import { expect, test } from 'vitest';
import { testChannelAccountCredentials } from '../src/channel-account-connectivity.js';
import type { ChannelAccount } from '../src/types.js';

test('unsupported channel credential checks never report a false success', async () => {
  const account = {
    provider: 'whatsapp',
  } as ChannelAccount;
  await expect(
    testChannelAccountCredentials(account, {}),
  ).resolves.toMatchObject({
    success: false,
    unsupported: true,
  });
});
