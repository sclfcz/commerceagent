import { loadChannelAccountSecret } from './channel-account-secrets.js';
import { getChannelAccount } from './db.js';
import type { ChannelAccount, ChannelTurnContext } from './types.js';

const FEISHU_CLI_CREDENTIAL_ENV_KEYS = [
  'FEISHU_APP_ID',
  'FEISHU_APP_SECRET',
  // feishu-cli document commands prefer an explicit user token over the App
  // credentials. A token inherited through provider/custom env must therefore
  // not survive an exact container Bot binding.
  'FEISHU_USER_ACCESS_TOKEN',
] as const;

export class FeishuCliCredentialBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeishuCliCredentialBindingError';
  }
}

export interface FeishuCliRuntimeBinding {
  source: 'channel_account';
  accountId: string;
  appId: string;
  appSecret: string;
}

interface FeishuCliBindingDependencies {
  getChannelAccount: (id: string) => ChannelAccount | undefined;
  loadChannelAccountSecret: (
    secretRef: string,
  ) => Record<string, string | undefined> | null;
}

export interface ResolveFeishuCliRuntimeBindingInput {
  ownerUserId?: string | null;
  channelContext?: ChannelTurnContext;
  workspaceChannelAccountId?: string | null;
}

function optionalTrimmed(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function hasUnsafeCredentialCharacters(value: string): boolean {
  return /[\u0000\r\n]/.test(value);
}

/**
 * Select the Bot identity a container run must use without reading secrets.
 * Host mode deliberately never calls this helper: feishu-cli on the host owns
 * its complete native environment/config resolution.
 */
export function resolveFeishuCliBoundAccountId(
  input: Pick<
    ResolveFeishuCliRuntimeBindingInput,
    'channelContext' | 'workspaceChannelAccountId'
  >,
): string | null {
  const isFeishuTurn = input.channelContext?.provider === 'feishu';
  const turnAccountId = isFeishuTurn
    ? optionalTrimmed(input.channelContext?.channelAccountId)
    : null;
  return turnAccountId ?? optionalTrimmed(input.workspaceChannelAccountId);
}

/**
 * Resolve the Feishu CLI identity for one Agent run.
 *
 * An exact inbound Feishu turn is authoritative. A workspace-level account is
 * used only when no turn-scoped account exists. With no bound account this
 * returns null and feishu-cli resolves any native container profile/config
 * without CommerceAgent parsing it. Host-mode execution must not call this
 * resolver at all.
 *
 * Once a Feishu account is explicitly bound, failures are closed rather than
 * silently falling back to a different Bot identity.
 */
export function resolveFeishuCliRuntimeBinding(
  input: ResolveFeishuCliRuntimeBindingInput,
  dependencies: FeishuCliBindingDependencies = {
    getChannelAccount,
    loadChannelAccountSecret,
  },
): FeishuCliRuntimeBinding | null {
  const isFeishuTurn = input.channelContext?.provider === 'feishu';
  const turnAccountId = isFeishuTurn
    ? optionalTrimmed(input.channelContext?.channelAccountId)
    : null;
  const candidateAccountId = resolveFeishuCliBoundAccountId(input);

  if (!candidateAccountId) return null;

  const account = dependencies.getChannelAccount(candidateAccountId);
  if (!account) {
    throw new FeishuCliCredentialBindingError(
      'The Feishu account bound to this turn no longer exists',
    );
  }
  if (account.provider !== 'feishu') {
    throw new FeishuCliCredentialBindingError(
      'The channel account bound to this Feishu turn has the wrong provider',
    );
  }
  if (!input.ownerUserId || account.owner_user_id !== input.ownerUserId) {
    throw new FeishuCliCredentialBindingError(
      'The Feishu account bound to this run does not belong to the workspace owner',
    );
  }
  if (!account.enabled) {
    throw new FeishuCliCredentialBindingError(
      'The Feishu account bound to this run is disabled',
    );
  }

  const secret = dependencies.loadChannelAccountSecret(account.secret_ref);
  const appId = optionalTrimmed(secret?.appId);
  const appSecret = optionalTrimmed(secret?.appSecret);
  if (!appId || !appSecret) {
    throw new FeishuCliCredentialBindingError(
      'The Feishu account bound to this run has incomplete credentials',
    );
  }
  if (
    hasUnsafeCredentialCharacters(appId) ||
    hasUnsafeCredentialCharacters(appSecret)
  ) {
    throw new FeishuCliCredentialBindingError(
      'The Feishu account bound to this run has invalid credential characters',
    );
  }

  const contextAppId = optionalTrimmed(input.channelContext?.bot?.appId);
  if (turnAccountId && contextAppId && contextAppId !== appId) {
    throw new FeishuCliCredentialBindingError(
      'The Feishu Bot identity for this turn does not match the bound account',
    );
  }

  return {
    source: 'channel_account',
    accountId: account.id,
    appId,
    appSecret,
  };
}

function bindingEnvironment(
  binding: FeishuCliRuntimeBinding,
): Record<string, string> {
  return {
    FEISHU_APP_ID: binding.appId,
    FEISHU_APP_SECRET: binding.appSecret,
  };
}

export function applyFeishuCliBindingToEnvLines(
  lines: string[],
  binding: FeishuCliRuntimeBinding | null,
): void {
  if (!binding) return;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (
      FEISHU_CLI_CREDENTIAL_ENV_KEYS.some((key) =>
        lines[index]?.startsWith(`${key}=`),
      )
    ) {
      lines.splice(index, 1);
    }
  }
  for (const [key, value] of Object.entries(bindingEnvironment(binding))) {
    lines.push(`${key}=${value}`);
  }
}
