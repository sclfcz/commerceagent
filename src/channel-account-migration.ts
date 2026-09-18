import crypto from 'node:crypto';
import type { ChannelAccount, ChannelProvider } from './types.js';
import {
  createChannelAccount,
  getDefaultChannelAccount,
  getAllRegisteredGroups,
  getLegacyChannelAccount,
  setRegisteredGroup,
  updateChannelAccount,
  updateChannelAccountAuthStatus,
} from './db.js';
import { getChannelFromJid } from './channel-prefixes.js';
import { parseChannelAddress } from './channel-address.js';
import {
  channelAccountSecretRef,
  deleteChannelAccountSecret,
  saveChannelAccountSecret,
  type ChannelAccountSecret,
} from './channel-account-secrets.js';

export function ensureLegacyDefaultChannelAccount(input: {
  ownerUserId: string;
  provider: ChannelProvider;
  name: string;
  secret: ChannelAccountSecret;
  enabled: boolean;
}): ChannelAccount {
  const backfillLegacyBindings = (account: ChannelAccount): ChannelAccount => {
    for (const [jid, group] of Object.entries(getAllRegisteredGroups())) {
      if (
        group.created_by !== input.ownerUserId ||
        group.channel_account_id ||
        getChannelFromJid(jid) !== input.provider ||
        parseChannelAddress(jid)?.legacy !== true
      ) {
        continue;
      }
      setRegisteredGroup(jid, {
        ...group,
        channel_account_id: account.id,
      });
    }
    return account;
  };

  const existing = getLegacyChannelAccount(input.ownerUserId, input.provider);
  if (existing) return backfillLegacyBindings(existing);
  const currentDefault = getDefaultChannelAccount(
    input.ownerUserId,
    input.provider,
  );
  const id = crypto.randomUUID();
  const secretRef = channelAccountSecretRef(id);
  saveChannelAccountSecret(secretRef, input.secret);
  try {
    return backfillLegacyBindings(
      createChannelAccount({
        id,
        owner_user_id: input.ownerUserId,
        provider: input.provider,
        name: input.name,
        secret_ref: secretRef,
        enabled: input.enabled,
        is_default: currentDefault == null,
        is_legacy_default: true,
        auth_mode:
          input.provider === 'wechat' || input.provider === 'whatsapp'
            ? 'qr_session'
            : input.provider === 'telegram' || input.provider === 'discord'
              ? 'bot_token'
              : 'credentials',
        auth_status: 'authorized',
      }),
    );
  } catch (error) {
    deleteChannelAccountSecret(secretRef);
    throw error;
  }
}

/** Compatibility write path for old /api/config/user-im/:provider routes. */
export function syncDefaultChannelAccountCredentials(input: {
  ownerUserId: string;
  provider: ChannelProvider;
  name: string;
  secret: ChannelAccountSecret;
  enabled: boolean;
}): ChannelAccount {
  const account = ensureLegacyDefaultChannelAccount(input);
  saveChannelAccountSecret(account.secret_ref, input.secret);
  updateChannelAccountAuthStatus(account.id, 'authorized');
  return (
    updateChannelAccount(account.id, input.ownerUserId, {
      enabled: input.enabled,
    }) ?? account
  );
}
