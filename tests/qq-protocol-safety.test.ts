import { describe, expect, test } from 'vitest';
import { validateQQGatewayUrl } from '../src/qq.js';

describe('QQ protocol safety', () => {
  test('accepts official secure gateway hosts', () => {
    expect(validateQQGatewayUrl('wss://api.sgroup.qq.com/websocket')).toBe(
      'wss://api.sgroup.qq.com/websocket',
    );
  });

  test.each([
    'ws://api.sgroup.qq.com/websocket',
    'wss://evil.example/websocket',
    'wss://qq.com.evil.example/websocket',
    'wss://user:pass@api.sgroup.qq.com/websocket',
  ])('rejects an untrusted gateway URL: %s', (url) => {
    expect(() => validateQQGatewayUrl(url)).toThrow(/untrusted/);
  });
});
