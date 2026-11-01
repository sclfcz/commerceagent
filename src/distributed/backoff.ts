/**
 * Retry delay policy: exponential growth capped at `maxMs`, then full jitter in
 * [0, capped]. Full jitter prevents a batch of failed runs from retrying in
 * lock step and stampeding the queue.
 */
export function fullJitterBackoff(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number = Math.random,
): number {
  if (!Number.isFinite(attempt) || attempt < 1) return 0;
  if (!Number.isFinite(baseMs) || baseMs <= 0) return 0;
  const cap = Number.isFinite(maxMs) && maxMs > 0 ? maxMs : baseMs;
  const exponent = Math.min(attempt - 1, 52);
  const ceiling = Math.min(cap, baseMs * 2 ** exponent);
  const roll = Math.min(Math.max(random(), 0), 1);
  return Math.floor(roll * ceiling);
}
