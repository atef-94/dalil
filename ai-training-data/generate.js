#!/usr/bin/env node
// Generation pipeline for the ACTIVE AI language dataset. Combines the
// hand-written template banks (lib/templates.js) with the entity value
// pools (lib/value-pools.js) and the Franco-Arabic dictionary (lib/franco.js)
// combinatorially, per the category distribution designed in
// active_ai_categories_and_schema.json, to produce the core dataset and a
// held-out evaluation set. Deterministic (seeded PRNG) so re-runs are
// reproducible and diffable.
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  INTENT_GROUPS, SINGLE_WORD_ENTRIES, SHORT_EXPRESSION_ENTRIES,
  NON_ACTIONABLE_ACTION_VARIANTS,
} from './lib/templates.js';
import { MULTI_TURN_CONVERSATIONS, AMBIGUITY_EXAMPLES, ADVERSARIAL_EXAMPLES } from './lib/hand-authored.js';
import { toFranco, injectArabicTypo } from './lib/franco.js';
import { makeRng, SENTENCE_SUFFIXES } from './lib/value-pools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = (name) => path.join(__dirname, name);

const intentsDoc = JSON.parse(readFileSync(OUT('active_ai_intents.json'), 'utf8'));
const INTENT_META = new Map(intentsDoc.intents.map((i) => [i.intent, i]));

// Real requiredPermission {action, resource} for the 22 real system_action
// actionTypes, copied from src/modules/automation/automation.service.ts's
// ACTION_VERB/ACTION_RESOURCE maps (the same maps ai-agent.service.ts's
// TOOL_REGISTRY reads at runtime) so permission_required in the dataset is
// the real enforced permission string, not invented.
const ACTION_RESOURCE = {
  create_task: 'task', send_message: 'message', create_lead: 'lead',
  update_lead_status: 'lead', assign_lead_owner: 'lead', update_campaign_status: 'campaign',
  webhook_call: 'secret', integration_call: 'integration_connection', ai_decide: 'ai_action',
  require_approval: 'approval', record_payment: 'payment_schedule', cancel_contract: 'contract',
  search_units: 'unit', score_lead: 'lead', compare_payment_plans: 'quotation',
  get_delivery_status: 'integration_connection', recall_memory: 'ai_memory',
  search_projects: 'project', get_project_details: 'project', get_project_payment_plans: 'payment_plan_template',
  get_developer_portfolio: 'project', get_project_facilities: 'project', get_project_location: 'project',
};
const ACTION_VERB = {
  create_task: 'create', send_message: 'create', create_lead: 'create',
  update_lead_status: 'edit', assign_lead_owner: 'edit', update_campaign_status: 'edit',
  webhook_call: 'view', integration_call: 'create', ai_decide: 'create',
  require_approval: 'approve', record_payment: 'edit', cancel_contract: 'edit',
  search_units: 'view', score_lead: 'view', compare_payment_plans: 'create',
  get_delivery_status: 'view', recall_memory: 'view', search_projects: 'view',
  get_project_details: 'view', get_project_payment_plans: 'view', get_developer_portfolio: 'view',
  get_project_facilities: 'view', get_project_location: 'view',
};

let nextId = 1;
function makeId() { return `act-${String(nextId++).padStart(6, '0')}`; }

function permissionFor(action) {
  if (!action || !(action in ACTION_VERB)) return null;
  return `${ACTION_VERB[action]}:${ACTION_RESOURCE[action]}`;
}

// Fills every entry_schema field for one dataset row. `actionableOverride`
// lets a specific utterance of a system_action intent be marked
// non-actionable (the "never assume every request should execute" cases)
// even though the intent itself is capable of firing an action elsewhere.
function makeEntry({ text, language, entities, intent, category, context = null, confidence, actionableOverride }) {
  const meta = INTENT_META.get(intent);
  if (!meta) throw new Error(`Unknown intent: ${intent}`);
  const actionable = actionableOverride !== undefined ? actionableOverride : (meta.system_action === true);
  const action = actionable ? meta.action : null;
  return {
    id: makeId(),
    text,
    language,
    normalized_text: language === 'egyptian_arabic' || language === 'msa' ? text : null,
    franco_variant: null,
    english_mix: null,
    intent,
    entities: entities || {},
    category,
    context,
    confidence,
    actionable,
    action,
    permission_required: actionable ? permissionFor(action) : null,
    risk_level: actionable ? (meta.risk_level || null) : null,
    requires_approval: actionable ? !!meta.requires_approval : false,
    requires_confirmation: actionable ? !!meta.requires_confirmation : false,
    read_only: actionable ? (meta.read_only === true) : null,
  };
}

// normalized_text must always be filled (schema: required, never omitted);
// for non-Arabic-base languages we don't have a separate canonical Arabic
// rendering pass in this pipeline, so we fall back to the entry's own text
// — documented as a known simplification in the dataset report.
function finalizeNormalizedText(entry) {
  if (entry.normalized_text === null) entry.normalized_text = entry.text;
  return entry;
}

const rng = makeRng(1337);
const SAMPLES_PER_TEMPLATE = 190;
const NON_ACTIONABLE_SAMPLES = 70;

// Appends a randomly chosen neutral clause (see SENTENCE_SUFFIXES) to widen
// text-level variety on otherwise low-cardinality single-slot templates,
// without altering intent/entities. A trailing Arabic question mark is
// preserved at the very end.
function withSuffix(text, r) {
  const suffix = SENTENCE_SUFFIXES[r.next() % SENTENCE_SUFFIXES.length];
  if (!suffix) return text;
  const hasQ = text.endsWith('؟');
  const base = hasQ ? text.slice(0, -1) : text;
  return `${base}${hasQ ? '،' : ''} ${suffix}${hasQ ? '؟' : ''}`;
}

const core = [];
const seenTexts = new Set();
function push(entry) {
  finalizeNormalizedText(entry);
  if (seenTexts.has(entry.text)) return false;
  seenTexts.add(entry.text);
  core.push(entry);
  return true;
}

// ---- Base entries from INTENT_GROUPS ----
const baseByCategory = new Map(); // category -> [entry, ...] for derivation sourcing
for (const group of INTENT_GROUPS) {
  for (const gen of group.gens) {
    for (let i = 0; i < SAMPLES_PER_TEMPLATE; i++) {
      const { text: rawText, entities } = gen(rng);
      const text = withSuffix(rawText, rng);
      const entry = makeEntry({
        text, language: 'egyptian_arabic', entities, intent: group.intent,
        category: group.category, confidence: 'reasonable_linguistic_variation',
      });
      if (push(entry)) {
        if (!baseByCategory.has(group.category)) baseByCategory.set(group.category, []);
        baseByCategory.get(group.category).push(entry);
      }
    }
  }
}

// ---- Single-word / short-expression fixed entries ----
for (const e of SINGLE_WORD_ENTRIES) {
  push(makeEntry({ text: e.text, language: 'egyptian_arabic', entities: e.entities, intent: e.intent, category: 'single_word_vocabulary', confidence: 'reasonable_linguistic_variation' }));
}
for (const e of SHORT_EXPRESSION_ENTRIES) {
  push(makeEntry({ text: e.text, language: 'egyptian_arabic', entities: e.entities, intent: e.intent, category: 'short_expressions', confidence: 'reasonable_linguistic_variation' }));
}

// ---- Non-actionable variants of action-intent phrasing ----
for (const group of NON_ACTIONABLE_ACTION_VARIANTS) {
  for (const gen of group.gens) {
    for (let i = 0; i < NON_ACTIONABLE_SAMPLES; i++) {
      const { text: rawText, entities } = gen(rng);
      const text = withSuffix(rawText, rng);
      push(makeEntry({
        text, language: 'egyptian_arabic', entities, intent: group.intent,
        category: 'active_ai_action_language', confidence: 'reasonable_linguistic_variation',
        actionableOverride: false,
      }));
    }
  }
}

// ---- Derived variants: franco / mixed / whatsapp-short / typo ----
// Weighted sampling from the informational/search/sales/objection/action
// base pools (the categories with the highest natural-language variety) to
// populate the four derived-form categories, per the distribution shares.
const DERIVE_SOURCE_CATEGORIES = [
  'natural_sentences_informational', 'natural_sentences_search_filter',
  'sales_negotiation_language', 'customer_objections', 'active_ai_action_language',
  'investment_language', 'broker_language', 'crm_internal_language',
];
function sourcePool() {
  const pool = [];
  for (const cat of DERIVE_SOURCE_CATEGORIES) pool.push(...(baseByCategory.get(cat) || []));
  return pool;
}
const pool = sourcePool();

const ENGLISH_GLOSS = new Map([
  ['فيو', 'view'], ['كاش', 'cash'], ['تسليم', 'delivery'], ['عرض', 'offer'],
  ['ميتنج', 'meeting'], ['خصم', 'discount'],
]);
function toMixed(text, r) {
  let out = text;
  let mixed = null;
  for (const [ar, en] of ENGLISH_GLOSS) {
    if (out.includes(ar)) { out = out.replace(ar, en); mixed = en; break; }
  }
  return { text: out, mixed };
}
const WHATSAPP_TRIM = [[/لو سمحت/g, ''], [/ممكن /g, ''], [/عايز اعرف /g, ''], [/؟/g, '?']];
function toWhatsapp(text) {
  let out = text;
  for (const [pattern, replacement] of WHATSAPP_TRIM) out = out.replace(pattern, replacement);
  return out.trim().replace(/\s+/g, ' ');
}

function deriveN(n, category, transform) {
  for (let i = 0; i < n; i++) {
    const src = pool[rng.next() % pool.length];
    const derived = transform(src);
    if (!derived) continue;
    push(makeEntry({
      text: derived.text, language: derived.language, entities: src.entities,
      intent: src.intent, category, confidence: 'generated_synthetic',
      actionableOverride: src.actionable,
    }));
  }
}

deriveN(7500, 'franco_arabic_variants', (src) => ({ text: toFranco(src.text, rng), language: 'franco' }));
deriveN(6000, 'mixed_arabic_english', (src) => {
  const { text, mixed } = toMixed(src.text, rng);
  if (!mixed) return null;
  return { text, language: 'mixed_ar_en' };
});
deriveN(6000, 'whatsapp_short_messages', (src) => ({ text: toWhatsapp(src.text), language: 'whatsapp_short' }));
deriveN(4500, 'typing_errors_and_keyboard_switch', (src) => ({ text: injectArabicTypo(src.text, rng), language: 'egyptian_arabic' }));

// ---- Multi-turn conversations ----
for (const convo of MULTI_TURN_CONVERSATIONS) {
  for (const spec of convo.extract) {
    const turn = convo.turns[spec.turn_index];
    const context = convo.turns.slice(0, spec.turn_index).map((t) => ({ speaker: t.speaker, text: t.text }));
    push(makeEntry({
      text: turn.text, language: 'egyptian_arabic', entities: spec.entities, intent: spec.intent,
      category: 'multi_turn_conversations', context, confidence: 'reasonable_linguistic_variation',
      actionableOverride: spec.actionable,
    }));
  }
}

// ---- Ambiguity examples ----
for (const ex of AMBIGUITY_EXAMPLES) {
  push(makeEntry({
    text: ex.text, language: 'egyptian_arabic', entities: ex.entities, intent: ex.intent,
    category: 'ambiguity_and_clarification', confidence: 'reasonable_linguistic_variation',
    actionableOverride: false,
  }));
}

// ---- Synonyms / equivalent-expression clusters (small, explicit) ----
const SYNONYM_CLUSTERS = [
  { intent: 'ASK_AVAILABILITY', entities: {}, texts: ['فيه متاح؟', 'لسه فيه وحدات؟', 'باقي حاجة ولا خلصت؟'] },
  { intent: 'ASK_PRICE', entities: {}, texts: ['السعر كام؟', 'التمن قد ايه؟', 'بكام الوحدة دي؟'] },
  { intent: 'OBJECTION_NEED_TO_THINK', entities: {}, texts: ['هفكر وارجعلك', 'محتاج وقت افكر', 'خليني افكر شوية'] },
];
for (const cluster of SYNONYM_CLUSTERS) {
  for (const text of cluster.texts) {
    push(makeEntry({ text, language: 'egyptian_arabic', entities: cluster.entities, intent: cluster.intent, category: 'synonyms_and_equivalent_expressions', confidence: 'reasonable_linguistic_variation' }));
  }
}

// ---- Polysemous / contextual-meaning examples ----
const POLYSEMY_EXAMPLES = [
  { text: 'عايز اعرف الحجز بيتم إزاي', intent: 'ASK_AVAILABILITY', entities: {}, gloss: '"حجز" here means the booking *process*, not an instruction to book.' },
  { text: 'حجزلي الوحدة دلوقتي', intent: 'BOOK_UNIT', entities: {}, gloss: '"حجز" here is a direct imperative to reserve.' },
  { text: 'استلام الوحدة هيبقى إمتى؟', intent: 'ASK_DELIVERY_DATE', entities: {}, gloss: '"استلام" here means handover/delivery date.' },
  { text: 'ابعتلي رقم استلام الشكوى', intent: 'UNKNOWN', entities: {}, gloss: '"استلام" here means a complaint reference/receipt number, unrelated to unit handover.' },
  { text: 'السعر شامل التشطيب ولا لأ؟', intent: 'ASK_PRICE', entities: {}, gloss: '"السعر" as the quoted unit price.' },
  { text: 'السعر ده هيفضل لحد امتى؟', intent: 'ASK_PRICE', entities: {}, gloss: '"السعر" here refers to a time-limited promotional price, not the base price.' },
];
for (const ex of POLYSEMY_EXAMPLES) {
  push(makeEntry({ text: ex.text, language: 'egyptian_arabic', entities: ex.entities, intent: ex.intent, category: 'polysemous_contextual_words', confidence: 'reasonable_linguistic_variation' }));
}

// ============================================================
// Evaluation set: adversarial generator variants + a held-out
// stratified sample pulled OUT of core (never present in both files).
// ============================================================
function adversarialGen(rng2) {
  const base = ADVERSARIAL_EXAMPLES[rng2.next() % ADVERSARIAL_EXAMPLES.length];
  return base;
}
const evalSet = [];
const evalSeen = new Set();
function pushEval(entry) {
  finalizeNormalizedText(entry);
  if (evalSeen.has(entry.text)) return;
  evalSeen.add(entry.text);
  evalSet.push(entry);
}
// Each adversarial example verbatim once, then rng-perturbed repeats aren't
// meaningful for fixed strings — instead we emit each fixed adversarial
// case once (quality over padding, per the "don't pad with meaningless
// duplicates" mandate) and rely on the held-out core sample below to reach
// the 1000+ target with genuinely varied phrasing.
for (const ex of ADVERSARIAL_EXAMPLES) {
  pushEval(makeEntry({
    text: ex.text, language: /[a-zA-Z]/.test(ex.text) && !/[؀-ۿ]/.test(ex.text) ? 'franco' : 'egyptian_arabic',
    entities: ex.entities, intent: ex.intent, category: 'adversarial', confidence: 'reasonable_linguistic_variation',
    actionableOverride: false,
  }));
}

// Stratified held-out sample: pull entries out of `core` (removing them so
// they never double as training data) from the categories the evaluation
// set is required to emphasize.
const EVAL_STRATA = [
  'ambiguity_and_clarification', 'franco_arabic_variants', 'mixed_arabic_english',
  'multi_turn_conversations', 'customer_objections', 'active_ai_action_language',
];
const evalTarget = 1300;
let coreIdx = 0;
const coreKeep = [];
const stratumCounters = Object.fromEntries(EVAL_STRATA.map((s) => [s, 0]));
const PER_STRATUM_CAP = Math.ceil((evalTarget - evalSet.length) / EVAL_STRATA.length) + 40;
for (const entry of core) {
  const isStratum = EVAL_STRATA.includes(entry.category);
  const stillNeeded = evalSet.length < evalTarget;
  if (isStratum && stillNeeded && stratumCounters[entry.category] < PER_STRATUM_CAP && (coreIdx % 3 === 0)) {
    pushEval(entry);
    stratumCounters[entry.category] += 1;
  } else {
    coreKeep.push(entry);
  }
  coreIdx += 1;
}

// ============================================================
// Write deliverables
// ============================================================
const CSV_FIELDS = ['id', 'text', 'language', 'normalized_text', 'franco_variant', 'english_mix', 'intent', 'entities', 'category', 'context', 'confidence', 'actionable', 'action', 'permission_required', 'risk_level', 'requires_approval', 'requires_confirmation', 'read_only'];
function toCsvValue(v) {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function writeCsv(filePath, rows) {
  const lines = [CSV_FIELDS.join(',')];
  for (const row of rows) lines.push(CSV_FIELDS.map((f) => toCsvValue(row[f])).join(','));
  writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
}

writeFileSync(OUT('active_ai_language_dataset.jsonl'), coreKeep.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
writeCsv(OUT('active_ai_language_dataset.csv'), coreKeep);
writeFileSync(OUT('active_ai_evaluation_set.jsonl'), evalSet.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');

// ---- Stats for the report ----
function statsFor(rows) {
  const byCategory = {}; const byLanguage = {}; const byIntent = {};
  let actionableCount = 0;
  for (const r of rows) {
    byCategory[r.category] = (byCategory[r.category] || 0) + 1;
    byLanguage[r.language] = (byLanguage[r.language] || 0) + 1;
    byIntent[r.intent] = (byIntent[r.intent] || 0) + 1;
    if (r.actionable) actionableCount += 1;
  }
  return { total: rows.length, byCategory, byLanguage, byIntent, actionableCount, uniqueIntents: Object.keys(byIntent).length };
}
const coreStats = statsFor(coreKeep);
const evalStats = statsFor(evalSet);
writeFileSync(OUT('.gen-stats.json'), JSON.stringify({ core: coreStats, eval: evalStats }, null, 2), 'utf8');

console.log('Core dataset:', coreStats.total, 'entries,', coreStats.uniqueIntents, 'unique intents,', coreStats.actionableCount, 'actionable');
console.log('Eval set:', evalStats.total, 'entries');
console.log('Category breakdown (core):', JSON.stringify(coreStats.byCategory, null, 2));
