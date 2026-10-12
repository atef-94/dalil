# ACTIVE AI — Egyptian Arabic, Arabic & Franco-Arabic Language Dataset

Final report for the language dataset built to train/improve the AI Real Estate
Agent inside ACTIVE Operating System (this same `dalil` codebase). Produced as
part of PR #7.

## 1. Objective

Build a production-oriented NLU/linguistic dataset that teaches ACTIVE's AI
agent to understand real Egyptian real-estate communication across Modern
Standard Arabic, Egyptian colloquial Arabic, Franco-Arabic/Arabizi, mixed
Arabic+English, and informal WhatsApp-style chat — grounded in ACTIVE's actual
capabilities (CRM stages, tool registry, entity schema) rather than a generic,
disconnected taxonomy.

## 2. Methodology

Per the confirmed approach (templated/combinatorial generation as the
backbone, remaining open to real material if supplied later — see Section 8),
the dataset was built in five layers:

1. **Taxonomy design**, grounded in the real system:
   - `active_ai_intents.json` — 93 intents. 22 are `system_action: true` and
     map 1:1 onto the real `TOOL_REGISTRY`/`TOOL_SPECS` in
     `src/modules/ai/ai-agent.service.ts` (same `actionType` tokens the
     backend already executes, same `riskLevel`/`readOnly` flags). The
     remaining ~71 are informational/conversational intents with no direct
     system action (objections, investment questions, broker language, CRM
     narration).
   - `active_ai_entities.json` — 48 entity types grounded in
     `src/domain/types.ts` (real enums: `UnitStatus`, `ReservationStatus`,
     `ContractStatus`, `MessageChannel`, `PaymentFrequency`, etc.) and in the
     real 12-stage CRM pipeline (`src/modules/crm/crm-stage.service.ts`
     `DEFAULT_STAGES`), plus the mandated Egyptian location list with Franco
     variants.
   - `active_ai_categories_and_schema.json` — the 19-category distribution
     plan and the exact per-entry JSON schema used below.
2. **Franco-Arabic system** (`active_ai_franco_dictionary.json`): a
   letter-level Arabic→Franco phonetic map (31 letters/digraphs, standard
   Egyptian conventions: 3=ع, 7=ح, 2=ء/ق, 5=خ, etc.), a 64-word curated
   dictionary of real-estate/CRM vocabulary with multiple Franco spelling
   variants each, and 7 systematic spelling-variation rules (digit/letter
   alternation, vowel elision, doubling, definite-article fusion,
   English-word substitution, keyboard-switch typos, native-script
   misspellings).
3. **Template banks** (`lib/templates.js`, `lib/value-pools.js`): one or more
   hand-written Arabic/Egyptian sentence templates per intent, combined with
   entity value pools (40 project names, 20 developers, 12 Egyptian
   locations, 10 unit types, 30 lead names, continuous-range numeric slots
   for budget/area/percentages/years so combinatorial expansion doesn't
   collapse into a handful of duplicate values) and a neutral
   sentence-suffix pool (11 variants) that widens lexical variety on
   otherwise low-cardinality single-slot templates without changing
   intent/entities.
4. **Hand-authored hard content** (`lib/hand-authored.js`): 8 multi-turn
   conversations (2–4 turns each, carrying entity context across turns), 10
   standalone ambiguity/clarification examples, 6 polysemous-word examples,
   3 synonym clusters, and 10 adversarial test cases reserved exclusively for
   the evaluation set.
5. **Generation pipeline** (`generate.js`): a deterministic (seeded PRNG,
   reproducible across runs), pure-Node.js script that expands every
   template against the value pools, derives Franco/mixed-language/WhatsApp-
   shortened/typo variants from the highest-variety base categories,
   assigns every dataset field (including the real `permission_required`,
   `risk_level`, `requires_approval`, `requires_confirmation`, `read_only`
   flags copied from the matched intent), deduplicates by exact text, and
   splits off a stratified held-out evaluation set before writing the final
   files.

## 3. Results

| File | Rows | Notes |
|---|---|---|
| `active_ai_language_dataset.jsonl` | **21,918** | Core training set |
| `active_ai_language_dataset.csv` | 21,918 | Flattened export, same rows |
| `active_ai_evaluation_set.jsonl` | **1,045** | Held out, zero text/id overlap with core (verified) |
| `active_ai_intents.json` | 93 intents | |
| `active_ai_entities.json` | 48 entities | |
| `active_ai_franco_dictionary.json` | 64 words + 31 letters + 7 rules | |

Both the ≥20,000-core and ≥1,000-evaluation targets are met, and generation
did **not** stop at exactly 20,000 — the pipeline was tuned upward until
category coverage across all 19 planned buckets was populated with
non-trivial counts (see Section 4), consistent with "optimize for coverage,
not the round number."

Verified automatically (see QC checks run against the actual output files):
zero duplicate ids across core+eval, zero exact-text overlap between core and
eval, zero missing schema fields, zero actionable/action-field
inconsistencies, and CSV row count matches JSONL line count exactly.

### Core dataset breakdown

**By category:**

| Category | Count | Share |
|---|---:|---:|
| franco_arabic_variants | 7,245 | 33.1% |
| whatsapp_short_messages | 2,778 | 12.7% |
| active_ai_action_language | 2,836 | 12.9% |
| natural_sentences_informational | 4,360 | 19.9% |
| natural_sentences_search_filter | 916 | 4.2% |
| investment_language | 749 | 3.4% |
| sales_negotiation_language | 733 | 3.3% |
| customer_objections | 579 | 2.6% |
| crm_internal_language | 547 | 2.5% |
| mixed_arabic_english | 500 | 2.3% |
| broker_language | 354 | 1.6% |
| typing_errors_and_keyboard_switch | 241 | 1.1% |
| single_word_vocabulary | 15 | 0.07% |
| short_expressions | 11 | 0.05% |
| multi_turn_conversations | 10 | 0.05% |
| ambiguity_and_clarification | 30 | 0.14% |
| synonyms_and_equivalent_expressions | 8 | 0.04% |
| polysemous_contextual_words | 6 | 0.03% |

**By language:** egyptian_arabic 11,440 · franco 7,245 · whatsapp_short 2,733
· mixed_ar_en 500.

**Actionable:** 4,706 of 21,918 entries (21.5%) are `actionable: true` with a
real `action` token, `permission_required`, `risk_level`,
`requires_approval`, and `requires_confirmation` populated from the matched
intent's real TOOL_REGISTRY metadata. All 93 intents appear at least once
(minimum count 6, for `UNKNOWN`).

### Evaluation set breakdown

1,045 entries: 10 hand-authored adversarial cases (verbatim, not padded with
meaningless repeats) plus a stratified sample of 1,035 entries pulled *out of*
the core pool (not duplicated into it) from the categories the spec requires
the eval set to emphasize: `customer_objections` (255), `active_ai_action_language`
(255), `franco_arabic_variants` (255), `mixed_arabic_english` (250),
`ambiguity_and_clarification` (16), `multi_turn_conversations` (4).
84 of the 93 intents are represented; 401 entries (38.4%) are actionable.

## 4. Category-distribution honesty note

The original 19-category distribution plan (`active_ai_categories_and_schema.json`)
set target percentages for generation balance. Two categories —
`single_word_vocabulary` and `short_expressions` — are, by their own nature,
bounded: there are only so many genuinely distinct single Arabic real-estate
words or two-to-four-word phrases before further "expansion" would mean
padding with meaningless near-duplicates, which the brief explicitly
forbids. Rather than force these to their nominal target share by generating
repetitive filler, their realized counts (15 and 11) were kept small and
authentic, and the shortfall was made up by categories with genuine, deep
real-world variety (informational sentences, Franco variants, action
language, WhatsApp-short messages). This is a deliberate quality-over-quota
decision, consistent with the brief's own instruction to "optimize for
real-world Egyptian understanding... not the number."

`mixed_arabic_english` (500 realized vs. a larger nominal target) is
similarly bounded by design: the pipeline only produces a mixed-language
entry when the source sentence contains one of a curated set of natural
English-loanword substitutions (view, cash, delivery, offer, meeting,
discount) — a deliberate choice to keep every mixed-language entry a
plausible code-switch rather than force an arbitrary English word into a
sentence where it wouldn't naturally occur.

## 5. Data provenance & honesty (per the brief's Section 25 requirement)

No live corpus of real Egyptian customer/agent messages was scraped or
available in this environment. Every entry in this dataset is one of:

- **`reasonable_linguistic_variation`** — hand-written by the dataset author
  to reflect commonly-observed Egyptian real-estate/CRM phrasing patterns
  (informational questions, objections, negotiation language, action
  commands, ambiguous requests, adversarial framings). This is a judgment
  call about plausible usage, not a measurement of real message frequency.
- **`generated_synthetic`** — mechanically produced by the pipeline from a
  `reasonable_linguistic_variation` base: Franco-Arabic transliteration
  output, mixed-language substitution output, WhatsApp-shortening output,
  and typo-injection output.

**No entry in this dataset is tagged `verified_common_usage`.** That tag
exists in the schema for a future pass that incorporates real material (see
Section 8) and was deliberately left unused here rather than applied to
synthetic content, per the explicit instruction not to fabricate claims
about real-world language usage. Specific Franco spelling variants (e.g.
"3ayez" vs. "aayez" for عايز) reflect widely-known Egyptian Franco-Arabic
conventions, not a frequency-ranked or corpus-verified popularity order.

## 6. Safety principle: never assume language should execute an action

Per Section 28 of the brief, actionability is never inferred from an
intent match alone. Concretely:

- Every one of the 22 system-action intents also appears in the dataset in
  **non-actionable** framings — hypothetical ("لو كنت مكانك..."), past-tense
  ("امبارح كنت لغيت..."), third-party ("زميلي بيسأل..."), conditional
  ("لو رد هنغير مرحلته... بس لسه ما ردش"), and explicitly-a-test
  ("كتجربة بس على السيستم") — each labeled `actionable: false`,
  `action: null` even though the topic/intent is recognizable. 5 dedicated
  non-actionable-variant templates plus all 10 adversarial evaluation cases
  cover this.
- Every `actionable: true` entry carries the *real* `risk_level`,
  `requires_approval`, and `requires_confirmation` flags from ACTIVE's own
  `TOOL_REGISTRY` (e.g. `update_lead_status` → medium risk, requires
  confirmation; `record_payment`/`cancel_contract` → higher-friction paths)
  — this dataset never invents a lower-friction path than the app itself
  enforces.
- The `ambiguity_and_clarification` category (30 core + 16 eval entries)
  models requests that should produce a clarifying question rather than a
  guessed entity — e.g. "غيرلي المرحلة" (no lead named), "احجزلي الوحدة" (no
  project/unit specified).

## 7. Known limitations

- **`franco_variant` cross-linking is not populated** — the schema reserves
  this field to link an Arabic-script entry to its paired Franco rendering's
  `id`, but this generation pass treats each derived Franco entry as
  standalone (`franco_variant: null` throughout) rather than back-linking to
  its source entry's id. A follow-up pass could populate this cheaply since
  the pipeline already tracks the source entry at derivation time.
- **`normalized_text` for non-Arabic-base entries falls back to the entry's
  own text** rather than a separately-computed canonical Arabic rendering,
  for the same reason (no separate normalization pass was built for Franco/
  mixed/WhatsApp entries beyond what generation already produces).
- **Template-driven generation has structural repetition** by construction
  (paraphrase clusters sharing sentence frames with different slot values) —
  appropriate for NLU slot/intent training, but this is not free-text
  corpus diversity. Real conversational messiness (interruptions, run-on
  WhatsApp voice-to-text artifacts, emoji, multi-topic messages) is
  under-represented relative to a genuine scraped corpus.
- **Egyptian-market value pools are representative, not exhaustive** — 40
  project names, 20 developers, 12 locations. Real ACTIVE deployments will
  reference many more real project/developer names than appear here.
- **No exact backend `ContractStatus`/similar enum was left unverified**:
  entity definitions were cross-checked against `src/domain/types.ts` at
  generation time (one gap — a missing `terminated` value on
  `ContractStatus` — was caught and fixed during QC).

## 8. Recommended next steps

1. If real anonymized material becomes available (WhatsApp threads, CRM
   notes, ad copy — per the "both options" methodology decision), a follow-up
   pass should: (a) tag genuinely-observed phrasings as
   `verified_common_usage`, (b) mine additional Franco spelling variants and
   project/developer names actually in use, (c) enrich
   `multi_turn_conversations` with real dialogue structure.
2. Populate `franco_variant` cross-links and a proper Arabic normalization
   pass for Franco/mixed/WhatsApp entries.
3. Expand adversarial evaluation coverage — 10 hand-authored cases is a
   sound seed but a production evaluation harness would benefit from more,
   especially around financially-significant confirmation requirements.
4. If ACTIVE's `TOOL_REGISTRY` grows (new actionTypes), re-run
   `active_ai_intents.json`'s grounding pass against the updated registry
   before regenerating.

## 9. Reproducing this dataset

```
node ai-training-data/generate.js
```

Deterministic (seed `1337` in `lib/value-pools.js`'s `makeRng`) — re-running
without code changes reproduces byte-identical output.
