/**
 * R3-L4 (CLI twin `kb-local/src/breaker.rs`): one query embedding waits at most
 * `QUERY_EMBEDDING_DEADLINE_MS`, and a target (provider revision or built-in model) whose
 * embedding timed out is skipped for a cooldown (a failure is fast, and a too-long query says
 * nothing about the next one): searches serve the keyword arm at once
 * with the notice instead of each waiting out the deadline. After the cooldown one search is
 * the half-open probe; its success closes the breaker, its failure reopens it with a doubled
 * cooldown (up to the maximum). Process-local: each server process learns on its own.
 */
export const QUERY_EMBEDDING_DEADLINE_MS = 8_000;
export const EMBED_BREAKER_COOLDOWN_MS = 30_000;
export const EMBED_BREAKER_MAX_COOLDOWN_MS = 300_000;
const MAX_TRACKED_TARGETS = 1_024;

export type BreakerTicket = { key: string; probe: boolean };
type BreakerState = { openUntil: number; cooldownMs: number; probing: boolean };

export function createEmbedBreaker(now: () => number = Date.now) {
  const states = new Map<string, BreakerState>();
  return {
    /** A ticket to embed, or "open" when this target must not be tried now. */
    admit(key: string): BreakerTicket | "open" {
      const state = states.get(key);
      if (!state) return { key, probe: false };
      if (now() < state.openUntil || state.probing) return "open";
      state.probing = true;
      return { key, probe: true };
    },
    succeed(ticket: BreakerTicket): void {
      states.delete(ticket.key);
    },
    fail(ticket: BreakerTicket): void {
      const prior = states.get(ticket.key);
      // Concurrent failures of one outage open the breaker once; only a failed probe doubles.
      if (prior && !ticket.probe && now() < prior.openUntil) return;
      const cooldownMs = prior
        ? Math.min(prior.cooldownMs * 2, EMBED_BREAKER_MAX_COOLDOWN_MS)
        : EMBED_BREAKER_COOLDOWN_MS;
      states.delete(ticket.key);
      if (states.size >= MAX_TRACKED_TARGETS) {
        const oldest = states.keys().next();
        if (!oldest.done) states.delete(oldest.value);
      }
      states.set(ticket.key, { openUntil: now() + cooldownMs, cooldownMs, probing: false });
    },
    /** The attempt ended without a verdict (cancelled, deadline of the whole search, ...). */
    release(ticket: BreakerTicket): void {
      const state = states.get(ticket.key);
      if (ticket.probe && state) state.probing = false;
    },
  };
}
export type EmbedBreaker = ReturnType<typeof createEmbedBreaker>;

/** The server process's breaker for query embeddings. */
export const queryEmbedBreaker: EmbedBreaker = createEmbedBreaker();
