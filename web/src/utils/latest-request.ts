export interface LatestRequestTicket {
  readonly key: string;
  readonly sequence: number;
}

export interface LatestRequestGate {
  begin: (key: string) => LatestRequestTicket;
  isCurrent: (
    ticket: LatestRequestTicket,
    currentKey?: string | null,
  ) => boolean;
  cancel: (ticket: LatestRequestTicket) => void;
  invalidate: () => void;
}

export function isSelectionCurrent(
  operationKey: string,
  currentKey: string | null | undefined,
): boolean {
  return operationKey === currentKey;
}

/**
 * Coordinates async UI reads without requiring the transport to support
 * AbortSignal. Only the newest ticket can commit state, and callers may also
 * bind the commit to the component's current selection key.
 */
export function createLatestRequestGate(): LatestRequestGate {
  let sequence = 0;
  let current: LatestRequestTicket | null = null;

  return {
    begin(key) {
      current = { key, sequence: ++sequence };
      return current;
    },
    isCurrent(ticket, currentKey = ticket.key) {
      return (
        current?.sequence === ticket.sequence &&
        current.key === ticket.key &&
        isSelectionCurrent(ticket.key, currentKey)
      );
    },
    cancel(ticket) {
      if (current?.sequence === ticket.sequence) current = null;
    },
    invalidate() {
      current = null;
      sequence += 1;
    },
  };
}
