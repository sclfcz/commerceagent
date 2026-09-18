import type { CommerceAgentOwnerProfileTurnResult } from './mcp-tools.js';

interface PendingFirstWakeAcknowledgement {
  inputTurnId: string;
  leaseToken: number;
}

/**
 * Correlates a host-issued first-wake lease with the exact SDK input turn.
 * Registration alone is side-effect free; only an explicit healthy
 * top-level Assistant observation asks the private IPC control plane to ACK.
 */
export class CommerceAgentFirstWakeAcknowledger {
  private readonly pending = new Map<string, PendingFirstWakeAcknowledgement>();

  register(
    inputTurnId: string,
    result: CommerceAgentOwnerProfileTurnResult | null,
  ): boolean {
    const leaseToken = result?.projection.onboarding.leaseToken;
    if (
      !inputTurnId ||
      result?.firstWake !== true ||
      !Number.isInteger(leaseToken) ||
      (leaseToken ?? 0) < 1
    ) {
      return false;
    }
    this.pending.set(inputTurnId, {
      inputTurnId,
      leaseToken: leaseToken!,
    });
    return true;
  }

  async acknowledge(
    inputTurnId: string,
    send: (candidate: PendingFirstWakeAcknowledgement) => Promise<boolean>,
  ): Promise<boolean> {
    const candidate = this.pending.get(inputTurnId);
    if (!candidate) return false;
    const accepted = await send(candidate);
    if (accepted) this.pending.delete(inputTurnId);
    return accepted;
  }

  hasPending(inputTurnId: string): boolean {
    return this.pending.has(inputTurnId);
  }
}
