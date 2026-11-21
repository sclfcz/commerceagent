import { describe, expect, test } from 'vitest';

import {
  MAX_SEARCH_KEYS,
  deriveQueryKeywords,
  deriveSearchKeys,
  keywordsToTsQuery,
  normalizeSearchKeys,
  searchKeysInputError,
} from '../src/memory-keywords.js';

describe('workspace memory retrieval keys', () => {
  test('normalizes explicit keys to lowercase, deduped, bounded entries', () => {
    expect(
      normalizeSearchKeys(['  Refund ', 'refund', '', '售后', 'x'.repeat(40)]),
    ).toEqual(['refund', '售后']);
    expect(
      normalizeSearchKeys(new Array(20).fill('k') as string[]),
    ).toHaveLength(1);
    const many = Array.from({ length: 20 }, (_, index) => `key-${index}`);
    expect(normalizeSearchKeys(many)).toHaveLength(MAX_SEARCH_KEYS);
    expect(normalizeSearchKeys(null)).toEqual([]);
  });

  test('reports unusable explicit key lists', () => {
    expect(searchKeysInputError(undefined)).toBeNull();
    expect(searchKeysInputError(['refund'])).toBeNull();
    expect(searchKeysInputError('refund' as unknown as string[])).toMatch(
      /array/,
    );
    expect(
      searchKeysInputError(Array.from({ length: 13 }, (_, i) => `k${i}`)),
    ).toMatch(/at most 12/);
    expect(searchKeysInputError([''])).toMatch(/empty/);
    expect(searchKeysInputError(['x'.repeat(33)])).toMatch(/32/);
    expect(searchKeysInputError([42 as unknown as string])).toMatch(/strings/);
  });

  test('derives Chinese n-gram keys from the title and content', () => {
    const keys = deriveSearchKeys({
      title: '退款政策',
      content: '客户退款需在7天内提交申请，超时不处理',
    });
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.length).toBeLessThanOrEqual(MAX_SEARCH_KEYS);
    expect(keys.every((key) => key === key.toLowerCase())).toBe(true);
    expect(keys.every((key) => key.length >= 1 && key.length <= 32)).toBe(true);
    // A title term survives as a stored key, and single characters never do.
    expect(keys).toContain('退款政策');
    expect(keys).not.toContain('退');
    // Derivation is deterministic so re-saving unchanged content is a no-op.
    expect(
      deriveSearchKeys({
        title: '退款政策',
        content: '客户退款需在7天内提交申请，超时不处理',
      }),
    ).toEqual(keys);
  });

  test('splits English and digits into words and drops stop words', () => {
    const keys = deriveSearchKeys({
      title: 'Refund Policy',
      content: 'Refunds are processed within 7 days by the finance team',
    });
    expect(keys).toContain('refund');
    expect(keys).toContain('policy');
    expect(keys).toContain('finance');
    expect(keys).not.toContain('the');
    expect(keys).not.toContain('are');
  });

  test('a long Chinese question still yields the short keyword it asks about', () => {
    const keywords = deriveQueryKeywords('请问客户要退款的话我们的流程是什么');
    expect(keywords).toContain('退款');
    expect(keywords).toContain('流程');
    // Stop-word-only grams are dropped, not merely down-ranked.
    expect(keywords).not.toContain('我们');
    expect(keywords).not.toContain('的话');
    expect(deriveQueryKeywords('')).toEqual([]);
  });

  test('query keywords cover English words and SKU-shaped tokens', () => {
    expect(
      deriveQueryKeywords('How does the refund policy work for SKU-928'),
    ).toEqual(expect.arrayContaining(['refund', 'policy', 'sku-928']));
  });

  test('builds a safe tsquery from keywords', () => {
    expect(keywordsToTsQuery(['退款', 'refund'])).toBe("'退款' | 'refund'");
    // Whitespace-containing entries are not single `simple` lexemes.
    expect(keywordsToTsQuery(['refund policy', '售后'])).toBe("'售后'");
    expect(keywordsToTsQuery([])).toBe('');
    expect(keywordsToTsQuery(["o'brien"])).toBe("'o''brien'");
  });
});
