import { randomUUID } from 'node:crypto';
import type { AiMemory, AiMemoryCategory, AiMemorySourceType, SensitivityTier } from '../../domain/types.js';
import type { Repository } from '../../infra/repository.js';
import { NotFoundError, ValidationError } from '../../infra/errors.js';

export interface RememberInput {
  companyId: string;
  category: AiMemoryCategory;
  content: string;
  subjectType?: string;
  subjectId?: string;
  key?: string;
  tags?: string[];
  source: { type: AiMemorySourceType; id?: string };
  confidence?: number;
  sensitivity?: SensitivityTier;
  createdByUserId?: string;
  expiresAt?: string;
}

export interface RecallFilter {
  category?: AiMemoryCategory;
  subjectType?: string;
  subjectId?: string;
  tags?: string[];
  key?: string;
  query?: string;
}

const DEFAULT_RECALL_LIMIT = 20;
const MAX_CONTENT_LENGTH = 4000;

/**
 * Persistent AI Memory Layer — a general-purpose, explicit-provenance
 * store the AI/Automation layer can write real observations to and later
 * recall, distinct from the narrow single-purpose lookups already
 * scattered through ai-agent.service.ts (findRecentDecision,
 * hasAlreadyReachedOut). See AiMemory's own doc comment in domain/types.ts
 * for the full design rationale.
 *
 * Security-critical invariant, load-bearing for prompt-injection defense
 * once an LLM layer exists: `content` is DATA, never parsed/evaluated as
 * an instruction anywhere in this service or by any caller. A memory
 * written from an untrusted source (e.g. a customer WhatsApp message
 * summarized into a memory) must never be treated as a system directive —
 * recall() returns memories as opaque strings for a caller/LLM prompt to
 * treat as retrieved context, exactly like RETRIEVED DATA in the
 * SYSTEM/POLICY/USER/RETRIEVED-DATA/TOOL-OUTPUT/EXTERNAL-CONTENT
 * separation the LLM abstraction phase will build on top of this.
 *
 * Deliberately does NOT expose an AI-callable "remember" tool in this
 * phase (see recall_memory in TOOL_REGISTRY, ai-agent.service.ts) — with
 * no LLM to produce trustworthy structured content yet, only application
 * code (deterministic agent logic, a human via the API) writes memories;
 * only recall is agent-callable, and it's read-only.
 */
export class AiMemoryService {
  constructor(private readonly memories: Repository<AiMemory>) {}

  async remember(input: RememberInput): Promise<AiMemory> {
    if (!input.companyId) throw new ValidationError('companyId is required');
    if (!input.content?.trim()) throw new ValidationError('content is required');
    if (input.content.length > MAX_CONTENT_LENGTH) {
      throw new ValidationError(`content must be at most ${MAX_CONTENT_LENGTH} characters`);
    }
    if (!input.source?.type) throw new ValidationError('source.type is required');
    const confidence = input.confidence ?? 60;
    if (confidence < 0 || confidence > 100) throw new ValidationError('confidence must be between 0 and 100');
    if ((input.subjectType && !input.subjectId) || (!input.subjectType && input.subjectId)) {
      throw new ValidationError('subjectType and subjectId must be provided together');
    }

    const memory: AiMemory = {
      id: randomUUID(),
      companyId: input.companyId,
      category: input.category,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      key: input.key,
      content: input.content.trim(),
      tags: input.tags,
      source: input.source,
      confidence,
      sensitivity: input.sensitivity ?? 'standard',
      createdByUserId: input.createdByUserId,
      createdAt: new Date().toISOString(),
      expiresAt: input.expiresAt,
    };
    return this.memories.save(memory);
  }

  /**
   * Deterministic relevance scoring — no LLM exists in this codebase yet
   * (see lead-scoring.service.ts's own doc comment), so ranking is a
   * transparent weighted sum, not a black-box embedding similarity:
   *   - recency: exponential decay, half-life 14 days
   *   - confidence: linear 0-1 weight
   *   - subject match: +40 when subjectType/subjectId both match the filter
   *   - category match: +15 when category matches the filter
   *   - tag overlap: +10 per overlapping tag (capped at +30)
   *   - text match: +25 when the query substring appears in content/key
   * A future LLM-based reranker can replace this scoring function without
   * touching the storage/expiry/invalidation contract around it.
   */
  private score(memory: AiMemory, filter: RecallFilter, now: number): number {
    const ageDays = (now - Date.parse(memory.createdAt)) / (1000 * 60 * 60 * 24);
    const recencyScore = Math.pow(0.5, ageDays / 14) * 50;
    const confidenceScore = (memory.confidence / 100) * 20;
    let score = recencyScore + confidenceScore;

    if (filter.subjectType && filter.subjectId && memory.subjectType === filter.subjectType && memory.subjectId === filter.subjectId) {
      score += 40;
    }
    if (filter.category && memory.category === filter.category) score += 15;
    if (filter.tags?.length && memory.tags?.length) {
      const overlap = filter.tags.filter((t) => memory.tags!.includes(t)).length;
      score += Math.min(overlap * 10, 30);
    }
    if (filter.query) {
      const needle = filter.query.toLowerCase();
      if (memory.content.toLowerCase().includes(needle) || memory.key?.toLowerCase().includes(needle)) {
        score += 25;
      }
    }
    return score;
  }

  private isLive(memory: AiMemory, now: number): boolean {
    if (memory.invalidatedAt) return false;
    if (memory.expiresAt && Date.parse(memory.expiresAt) <= now) return false;
    return true;
  }

  async recall(companyId: string, filter: RecallFilter = {}, limit = DEFAULT_RECALL_LIMIT): Promise<AiMemory[]> {
    const now = Date.now();
    const candidates = await this.memories.findAll((m) => {
      if (m.companyId !== companyId) return false;
      if (!this.isLive(m, now)) return false;
      if (filter.category && m.category !== filter.category) return false;
      if (filter.subjectType && m.subjectType !== filter.subjectType) return false;
      if (filter.subjectId && m.subjectId !== filter.subjectId) return false;
      if (filter.key && m.key !== filter.key) return false;
      return true;
    });
    return candidates
      .map((m) => ({ memory: m, score: this.score(m, filter, now) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, limit))
      .map((r) => r.memory);
  }

  async get(id: string, companyId: string): Promise<AiMemory> {
    const memory = await this.memories.findById(id);
    if (!memory || memory.companyId !== companyId) throw new NotFoundError('memory not found');
    return memory;
  }

  async invalidate(id: string, companyId: string, invalidatedByUserId: string): Promise<AiMemory> {
    const memory = await this.get(id, companyId);
    if (memory.invalidatedAt) return memory;
    const updated: AiMemory = { ...memory, invalidatedAt: new Date().toISOString(), invalidatedByUserId };
    return this.memories.save(updated);
  }

  /** Physical cleanup of expired-but-not-yet-invalidated rows, on the same
   * scheduled-tick cadence as the other sweeps (main.ts) — recall() already
   * filters these out, so this is retention hygiene, not a correctness
   * requirement. Marks them invalidated rather than deleting, preserving
   * the same "never physically delete, mark and keep" audit posture as
   * every other invalidation in this service. */
  async sweepExpiredMemories(): Promise<number> {
    const now = Date.now();
    const all = await this.memories.findAll(
      (m) => !m.invalidatedAt && !!m.expiresAt && Date.parse(m.expiresAt) <= now,
    );
    for (const memory of all) {
      await this.memories.save({ ...memory, invalidatedAt: new Date().toISOString() });
    }
    return all.length;
  }
}
