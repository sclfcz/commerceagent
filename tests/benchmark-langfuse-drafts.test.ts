import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildLangfuseDraftBundle,
  collectLangfuseDraftBundle,
  writeLangfuseDraftBundle,
  type LangfuseObservation,
  type LangfuseScore,
} from '../benchmarks/lib/langfuse-drafts.js';

const roots: LangfuseObservation[] = [
  {
    id: 'observation-root-failure',
    traceId: 'internal-trace-failure',
    startTime: '2026-10-23T00:00:00.000Z',
    name: 'commerceagent.turn',
    metadata: {
      run_id: 'run-synthetic-failure',
      turn_id: 'turn-synthetic-failure',
      'attributes.commerceagent.run_finished.reason': 'runner_exit',
      'attributes.error.type': 'runner_error',
      'attributes.gen_ai.request.model': 'secret-model-name',
      'attributes.langfuse.user.id': 'private-user-hash',
      'attributes.langfuse.session.id': 'private-workspace-hash',
    },
  },
  {
    id: 'observation-root-low-score',
    traceId: 'internal-trace-low-score',
    startTime: '2026-10-23T00:01:00.000Z',
    name: 'commerceagent.turn',
    metadata: {
      run_id: 'run-synthetic-low-score',
      turn_id: 'turn-synthetic-low-score',
      'attributes.commerceagent.run_finished.reason': 'completed',
    },
  },
  {
    id: 'observation-root-no-identity',
    traceId: 'internal-trace-no-identity',
    startTime: '2026-10-23T00:02:00.000Z',
    name: 'commerceagent.turn',
    metadata: {
      'attributes.commerceagent.run_finished.reason': 'stopped',
    },
  },
];

const tools: LangfuseObservation[] = [
  {
    id: 'observation-tool-1',
    traceId: 'internal-trace-failure',
    name: 'commerceagent.tool',
    metadata: {
      'attributes.gen_ai.tool.name': 'mcp__commerce_fixture__get_order',
      'attributes.customer_email': 'customer@example.test',
    },
  },
  {
    id: 'observation-tool-2',
    traceId: 'internal-trace-low-score',
    name: 'commerceagent.tool',
    metadata: {
      'attributes.gen_ai.tool.name': 'mcp__commerce_fixture__search_policy',
    },
  },
];

const scores: LangfuseScore[] = [
  {
    dataType: 'NUMERIC',
    value: 2,
    subject: { kind: 'trace', id: 'internal-trace-low-score' },
  },
  {
    dataType: 'NUMERIC',
    value: 5,
    subject: { kind: 'trace', id: 'internal-trace-failure' },
  },
];

const tempDirectories: string[] = [];
afterEach(() => {
  for (const directory of tempDirectories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe('Langfuse metadata-only regression drafts', () => {
  it('builds empty structured skeletons without copying trace content or identity', () => {
    const bundle = buildLangfuseDraftBundle({
      roots,
      tools,
      scores,
      generatedAt: new Date('2026-10-24T00:00:00.000Z'),
    });
    const serialized = JSON.stringify(bundle);

    expect(bundle.selection).toMatchObject({
      failedTraceCount: 1,
      lowScoreTraceCount: 1,
      draftCount: 2,
      skippedMissingRunIdentity: 1,
      bodyFieldsRequested: false,
      holdoutRead: false,
      casesModified: false,
    });
    expect(bundle.drafts[0]).toMatchObject({
      source: {
        runId: 'run-synthetic-failure',
        turnId: 'turn-synthetic-failure',
        signal: 'failure',
        terminalReason: 'runner_exit',
        errorCategory: 'runner_error',
        toolNames: ['mcp__commerce_fixture__get_order'],
      },
      caseDraft: {
        id: '',
        category: '',
        riskLevel: '',
        split: '',
        prompt: '',
        expected: { status: '', facts: {} },
      },
      promotionRequirements: {
        humanReviewRequired: true,
        referenceAnswerSelfTestRequired: true,
        mutationTestsRequired: true,
        automaticPromotion: false,
      },
    });
    expect(bundle.drafts[1].source).toMatchObject({
      signal: 'low_score',
      lowScoreCount: 1,
    });
    for (const forbidden of [
      'internal-trace-',
      'secret-model-name',
      'private-user-hash',
      'private-workspace-hash',
      'customer@example.test',
      'input',
      'output',
    ])
      expect(serialized).not.toContain(forbidden);
  });

  it('writes only under the ignored results draft directory with private permissions', () => {
    const benchmarkDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'commerce-langfuse-drafts-'),
    );
    tempDirectories.push(benchmarkDirectory);
    const bundle = buildLangfuseDraftBundle({ roots, tools, scores });
    const output = writeLangfuseDraftBundle(
      benchmarkDirectory,
      bundle,
      new Date('2026-10-24T00:00:00.000Z'),
    );

    expect(output).toBe(
      path.join(
        benchmarkDirectory,
        'results',
        'langfuse-drafts',
        'run-2026-10-24T00-00-00-000Z',
      ),
    );
    expect(fs.existsSync(path.join(output, 'drafts.json'))).toBe(true);
    expect(fs.statSync(output).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(output, 'drafts.json')).mode & 0o777).toBe(
      0o600,
    );
    expect(fs.existsSync(path.join(benchmarkDirectory, 'cases'))).toBe(false);
  });

  it('requests bounded metadata fields and numeric scores without body fields', async () => {
    const requests: Array<{ url: URL; authorization: string | null }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      requests.push({
        url,
        authorization: new Headers(init?.headers).get('authorization'),
      });
      let data: unknown[] = [];
      if (url.pathname.endsWith('/observations')) {
        data =
          url.searchParams.get('name') === 'commerceagent.turn'
            ? [roots[0]]
            : [tools[0]];
      } else if (url.pathname.endsWith('/scores')) {
        data = [scores[0]];
      }
      return new Response(JSON.stringify({ data, meta: { cursor: null } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const bundle = await collectLangfuseDraftBundle({
      endpoint: 'http://127.0.0.1:3100',
      publicKey: 'pk-synthetic',
      secretKey: 'sk-synthetic',
      from: new Date('2026-10-20T00:00:00.000Z'),
      to: new Date('2026-10-24T00:00:00.000Z'),
      minScore: 4,
      fetcher,
    });

    expect(bundle.selection.draftCount).toBe(1);
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(
        request.url.searchParams.get('fromStartTime') ??
          request.url.searchParams.get('fromTimestamp'),
      ).toBe('2026-10-20T00:00:00.000Z');
      expect(
        request.url.searchParams.get('toStartTime') ??
          request.url.searchParams.get('toTimestamp'),
      ).toBe('2026-10-24T00:00:00.000Z');
      expect(request.url.searchParams.get('fields')).not.toContain('io');
      expect(request.authorization).toMatch(/^Basic /);
      expect(request.url.toString()).not.toContain('sk-synthetic');
    }
    const scoreRequest = requests.find((request) =>
      request.url.pathname.endsWith('/scores'),
    );
    expect(scoreRequest?.url.searchParams.get('dataType')).toBe('NUMERIC');
    expect(scoreRequest?.url.searchParams.get('valueMax')).toBe('3.999999');
  });

  it('rejects unexpected input/output fields from Langfuse responses', async () => {
    const fetcher: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              ...roots[0],
              input: 'PRIVATE_SYNTHETIC_MESSAGE',
            },
          ],
          meta: { cursor: null },
        }),
        { status: 200 },
      );

    await expect(
      collectLangfuseDraftBundle({
        endpoint: 'http://127.0.0.1:3100',
        publicKey: 'pk-synthetic',
        secretKey: 'sk-synthetic',
        from: new Date('2026-10-20T00:00:00.000Z'),
        to: new Date('2026-10-24T00:00:00.000Z'),
        minScore: 4,
        fetcher,
      }),
    ).rejects.toThrow('langfuse_content_field_rejected');
  });

  it('rejects score comments instead of exporting free-form annotations', async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input));
      const data = url.pathname.endsWith('/scores')
        ? [{ ...scores[0], comment: 'PRIVATE_SYNTHETIC_REVIEW_TEXT' }]
        : [];
      return new Response(JSON.stringify({ data, meta: { cursor: null } }), {
        status: 200,
      });
    };

    await expect(
      collectLangfuseDraftBundle({
        endpoint: 'http://127.0.0.1:3100',
        publicKey: 'pk-synthetic',
        secretKey: 'sk-synthetic',
        from: new Date('2026-10-20T00:00:00.000Z'),
        to: new Date('2026-10-24T00:00:00.000Z'),
        minScore: 4,
        fetcher,
      }),
    ).rejects.toThrow('langfuse_content_field_rejected');
  });
});
