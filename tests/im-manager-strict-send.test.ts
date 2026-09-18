import { describe, expect, test } from 'vitest';

import { IMConnectionManager } from '../src/im-manager.js';

describe('IM manager strict outbound acknowledgement', () => {
  test('unknown routes reject for text, image, and file', async () => {
    const manager = new IMConnectionManager();
    await expect(manager.sendMessage('web:workspace', 'text')).rejects.toThrow(
      'Unknown channel type',
    );
    await expect(
      manager.sendImage('web:workspace', Buffer.from('image'), 'image/png'),
    ).rejects.toThrow('Unknown channel type');
    await expect(
      manager.sendFile('web:workspace', '/tmp/report', 'report.pdf'),
    ).rejects.toThrow('无法识别');
  });
});
