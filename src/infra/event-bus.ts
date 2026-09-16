import type { DomainEventType } from '../domain/types.js';

export interface DomainEvent {
  companyId: string;
  type: DomainEventType;
  payload: Record<string, unknown>;
  actorUserId?: string;
  /** Optional caller-supplied dedup key (e.g. the mutated record's id + new
   * status) for the Automation Engine's idempotency check. When omitted,
   * the engine derives one from type+payload — see automation.service.ts
   * `computeEventIdempotencyKey`. */
  dedupeKey?: string;
}

type Handler = (event: DomainEvent) => void | Promise<void>;

/**
 * Minimal in-process pub/sub. Domain events are emitted from app.ts route
 * handlers right after the underlying service call already succeeded — this
 * bus exists purely to let the Automation Engine react to them without
 * every service importing or knowing about automation. A handler throwing
 * never propagates to the emitter: an automation failure must never break
 * the business operation that triggered it (the workflow run itself
 * records the failure — see automation.service.ts).
 */
export class EventBus {
  private handlers: Handler[] = [];

  subscribe(handler: Handler): void {
    this.handlers.push(handler);
  }

  async emit(event: DomainEvent): Promise<void> {
    for (const handler of this.handlers) {
      try {
        await handler(event);
      } catch (err) {
        process.stderr.write(`event-bus handler failed for ${event.type}: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  }
}
