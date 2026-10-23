import { describe, expect, test } from 'vitest';

import {
  failClosedOnResidualSensitiveContent,
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

  test('redacts credentials, provider tokens, personal identifiers, cards, IPs and naked municipality addresses', () => {
    const sensitiveSamples = [
      'Authorization: Basic dXNlcjpwYXNz',
      'ghp_1234567890abcdefghijklmnopqrstuv',
      'gho_1234567890abcdefghijklmnopqrstuv',
      'github_pat_1234567890_abcdefghijklmnopqrstuvwxyz',
      'AKIAIOSFODNN7EXAMPLE',
      'ASIAIOSFODNN7EXAMPLE',
      'xoxb-SYNTHETIC-ONLY-DO-NOT-USE',
      'glpat-1234567890abcdefghijklmnop',
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      'o9R5q0nZ7W2cK4mY8sA1vP6d',
      '11010519491231002X',
      '4111111111111111',
      '10.0.3.12:8080',
      '[2001:db8::1]:443',
      '北京市朝阳区建国路88号3楼',
    ];
    const raw = `Sensitive values: ${sensitiveSamples.join(' | ')}`;
    const result = serializeRedactedContent({
      text: raw,
      order_id: 'ORD-2026-0912',
      amount: 129.5,
      date: '2026-09-12',
    });

    for (const sensitive of sensitiveSamples) {
      expect(result).not.toContain(sensitive);
    }
    expect(result).toContain('ORD-2026-0912');
    expect(result).toContain('129.5');
    expect(result).toContain('2026-09-12');
  });

  test('fails closed to original length and hash if a high-risk value survives redaction', () => {
    const original = 'This body contains a synthetic credential.';
    const fallback = failClosedOnResidualSensitiveContent(
      original,
      'Authorization: Basic dXNlcjpwYXNz',
    );
    const parsed = JSON.parse(fallback);
    expect(parsed).toEqual({
      content_redacted: true,
      original_length: original.length,
      original_sha256: expect.any(String),
    });
    expect(fallback).not.toContain('dXNlcjpwYXNz');
    expect(fallback).not.toContain(original);
  });
});
