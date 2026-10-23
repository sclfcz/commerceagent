import { describe, expect, test } from 'vitest';

import {
  redactObservabilityValue,
  serializeRedactedContent,
} from '../src/otel-redaction.js';

describe('OpenTelemetry content redaction', () => {
  test('redacts sensitive fields recursively while preserving unrelated facts', () => {
    const result = serializeRedactedContent({
      order_id: 'fixture-order-17',
      status: 'delayed',
      recipientName: 'Synthetic Recipient',
      shipping_address: '8 Example Road, Example City',
      customer: {
        name: 'Nested Customer Name',
        phoneNumber: '13800138000',
        email: 'recipient@example.test',
      },
      apiKey: 'sk-live-synthetic-key-123456789',
      endpoint: 'https://api.example.test/anthropic',
    });

    for (const sensitive of [
      'Synthetic Recipient',
      'Nested Customer Name',
      '8 Example Road',
      '13800138000',
      'recipient@example.test',
      'sk-live-synthetic-key-123456789',
      'https://api.example.test/anthropic',
    ]) {
      expect(result).not.toContain(sensitive);
    }
    expect(result).toContain('fixture-order-17');
    expect(result).toContain('delayed');
    expect(result).toContain('[REDACTED]');
  });

  test('redacts credentials, endpoint URLs, contact information and addresses in free text', () => {
    const text =
      'Email private@example.test; phone +1 415-555-2671; address 123 Main Street. ' +
      'Visit https://service.example.test/api?secret=x; api_key=sk-live-text-key-123456789; ' +
      'Authorization: Bearer synthetic-bearer; Cookie: session=synthetic-cookie; ' +
      'Endpoint: api.example.test/v1; token=synthetic-free-token; ' +
      'JWT eyJsyntheticheader.eyJsyntheticpayload.synthetic-signature-value; ' +
      '地址：北京市朝阳区建国路88号。';
    const result = serializeRedactedContent(text);

    for (const sensitive of [
      'private@example.test',
      '+1 415-555-2671',
      '123 Main Street',
      'https://service.example.test/api?secret=x',
      'sk-live-text-key-123456789',
      'synthetic-bearer',
      'synthetic-cookie',
      'api.example.test/v1',
      'synthetic-free-token',
      'eyJsyntheticheader.eyJsyntheticpayload.synthetic-signature-value',
      '北京市朝阳区建国路88号',
    ]) {
      expect(result).not.toContain(sensitive);
    }
    expect(result).toContain('[REDACTED]');
  });

  test('bounds serialized content and can redact a named sensitive scalar', () => {
    expect(redactObservabilityValue('synthetic-value', 'access_token')).toBe(
      '[REDACTED]',
    );
    expect(serializeRedactedContent('x'.repeat(20_000))).toHaveLength(16_000);
  });
});
