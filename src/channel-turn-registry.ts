import type { ChannelTurnContext } from './types.js';

export interface ActiveChannelTurn {
  correlationId: string;
  sourceJid: string;
  context: ChannelTurnContext;
}

export function channelTurnScope(
  folder: string,
  agentId?: string | null,
): string {
  return agentId ? `${folder}\u0000conversation:${agentId}` : folder;
}

/**
 * Host-owned registry for the exact input turn currently executing in each
 * long-lived SDK runner. Runner IPC claims are accepted only when their
 * correlation id matches this registry.
 */
export class ActiveChannelTurnRegistry {
  private readonly turns = new Map<string, ActiveChannelTurn>();

  set(scope: string, turn: ActiveChannelTurn | null | undefined): void {
    if (!turn) {
      this.turns.delete(scope);
      return;
    }
    this.turns.set(scope, {
      correlationId: turn.correlationId,
      sourceJid: turn.sourceJid,
      context: structuredClone(turn.context),
    });
  }

  require(scope: string, correlationId: string): ActiveChannelTurn {
    const turn = this.turns.get(scope);
    if (!turn || turn.correlationId !== correlationId) {
      throw new Error(
        'Feishu capability is not bound to the active input turn',
      );
    }
    if (
      turn.context.provider !== 'feishu' ||
      !turn.sourceJid.startsWith('feishu:')
    ) {
      throw new Error('The active input turn is not a Feishu turn');
    }
    return {
      correlationId: turn.correlationId,
      sourceJid: turn.sourceJid,
      context: structuredClone(turn.context),
    };
  }

  delete(scope: string): void {
    this.turns.delete(scope);
  }
}
