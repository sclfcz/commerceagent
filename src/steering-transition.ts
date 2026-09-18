/**
 * Tracks the short transition between a user choosing "steer" and the runner
 * acknowledging that the superseded turn was interrupted.
 *
 * The Claude SDK can race an already-buffered final result against interrupt().
 * During that window the old result must not become a second assistant reply.
 */
export class SteeringTransitionRegistry {
  private readonly states = new Map<
    string,
    {
      pending: boolean;
      interruptedTurnIds: Set<string>;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(private readonly ttlMs = 120_000) {}

  mark(chatJid: string): void {
    const existing = this.states.get(chatJid);
    if (existing) clearTimeout(existing.timer);
    const interruptedTurnIds =
      existing?.interruptedTurnIds ?? new Set<string>();
    const timer = setTimeout(() => this.clear(chatJid), this.ttlMs);
    timer.unref?.();
    this.states.set(chatJid, {
      pending: true,
      interruptedTurnIds,
      timer,
    });
  }

  clear(chatJid: string): void {
    const existing = this.states.get(chatJid);
    if (existing) clearTimeout(existing.timer);
    this.states.delete(chatJid);
  }

  /**
   * Resolves the pending steer when the runner emits status=interrupted.
   * The superseded turn ID remains guarded briefly so a late buffered final
   * cannot leak even if callbacks finish out of order.
   */
  resolveInterrupted(chatJid: string, turnId?: string): boolean {
    const state = this.states.get(chatJid);
    if (!state?.pending) return false;
    state.pending = false;
    if (turnId) state.interruptedTurnIds.add(turnId);
    return true;
  }

  /**
   * While interrupt acknowledgement is pending, every non-interrupt output
   * belongs to the old turn. Afterwards only the recorded old turn is hidden.
   */
  shouldSuppressOutput(chatJid: string, turnId?: string): boolean {
    const state = this.states.get(chatJid);
    if (!state) return false;
    if (state.pending) return true;
    return !!turnId && state.interruptedTurnIds.has(turnId);
  }
}
