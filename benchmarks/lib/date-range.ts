/** Inclusive UTC calendar intervals; report rows are returned whole, never prorated. */
function day(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  if (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    new Date(time).toISOString().slice(0, 10) !== value
  )
    return null;
  return Math.floor(time / 86_400_000);
}

export function validDateRange(start: unknown, end: unknown): boolean {
  const left = day(start),
    right = day(end);
  return left !== null && right !== null && left <= right;
}

export function dateRangesOverlap(
  start: unknown,
  end: unknown,
  otherStart: unknown,
  otherEnd: unknown,
): boolean {
  const left = day(start),
    right = day(end),
    otherLeft = day(otherStart),
    otherRight = day(otherEnd);
  return (
    left !== null &&
    right !== null &&
    otherLeft !== null &&
    otherRight !== null &&
    left <= right &&
    otherLeft <= otherRight &&
    left <= otherRight &&
    right >= otherLeft
  );
}

export function dateRangeCovers(
  start: unknown,
  end: unknown,
  requiredStart: unknown,
  requiredEnd: unknown,
): boolean {
  const left = day(start),
    right = day(end),
    requiredLeft = day(requiredStart),
    requiredRight = day(requiredEnd);
  return (
    left !== null &&
    right !== null &&
    requiredLeft !== null &&
    requiredRight !== null &&
    left <= requiredLeft &&
    right >= requiredRight &&
    requiredLeft <= requiredRight
  );
}
