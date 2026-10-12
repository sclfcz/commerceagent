import http from 'node:http';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { isIP, type AddressInfo } from 'node:net';
import type { SpikeCase, ToolCall } from '../lib/contracts.js';

export const toolDefinitions = [
  ['get_order', '读取订单', ['order_id']],
  ['search_policy', '查询市场政策，保留冲突条款', ['market', 'topic']],
  ['list_products', '列出产品规格', ['category']],
  [
    'get_ad_report',
    '读取指定日期广告指标',
    ['campaign_id', 'start_date', 'end_date'],
  ],
].map(([name, description, fields]) => ({
  name: name as string,
  description: description as string,
  inputSchema: {
    type: 'object',
    properties: Object.fromEntries(
      (fields as string[]).map((key) => [key, { type: 'string' }]),
    ),
    required: fields as string[],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
}));

type Data = {
  version: string;
  orders: Record<string, unknown>[];
  policies: Record<string, unknown>[];
  conflicting_policy: Record<string, unknown>;
  products: Record<string, unknown>[];
  injection: string;
  ads: Record<string, unknown>[];
};

export async function startFixtureServer(options: {
  data: Data;
  scenario: SpikeCase['scenario'];
  ledgerFile: string;
  host?: string;
}) {
  const host = options.host ?? '127.0.0.1';
  if (!(host === '::1' || (isIP(host) === 4 && host.startsWith('127.'))))
    throw new Error('fixture_non_loopback_bind_forbidden');
  fs.writeFileSync(options.ledgerFile, '', { flag: 'wx', mode: 0o600 });
  const token = randomBytes(32).toString('hex');
  const ledger: ToolCall[] = [];
  const server = http.createServer(async (req, res) => {
    if (
      req.method !== 'POST' ||
      req.url !== '/rpc' ||
      req.headers.authorization !== `Bearer ${token}`
    ) {
      res.writeHead(404).end();
      return;
    }
    let text = '';
    try {
      for await (const chunk of req) {
        text += chunk;
        if (text.length > 65536) {
          res.writeHead(413).end();
          return;
        }
      }
      const request = JSON.parse(text);
      const reply = (result: unknown) =>
        res
          .writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
      if (request.method === 'initialize') {
        reply({
          protocolVersion: request.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: {
            name: 'commerce_fixture',
            version: options.data.version,
          },
        });
        return;
      }
      if (request.method === 'ping') {
        reply({});
        return;
      }
      if (request.method === 'tools/list') {
        reply({ tools: toolDefinitions });
        return;
      }
      if (request.method !== 'tools/call') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            error: { code: -32601, message: 'method unavailable' },
          }),
        );
        return;
      }
      const name = request.params?.name;
      const args = request.params?.arguments;
      const definition = toolDefinitions.find((tool) => tool.name === name);
      let result: unknown;
      const success =
        !!definition &&
        !!args &&
        !Array.isArray(args) &&
        typeof args === 'object' &&
        Object.keys(args).length === definition.inputSchema.required.length &&
        definition.inputSchema.required.every(
          (key) => typeof args[key] === 'string',
        );
      if (!success) result = { error: 'invalid_tool_or_arguments' };
      else if (name === 'get_order')
        result = {
          orders: options.data.orders.filter(
            (row) => row.order_id === args.order_id,
          ),
        };
      else if (name === 'search_policy')
        result = {
          policies: [
            ...options.data.policies,
            ...(options.scenario === 'conflict'
              ? [options.data.conflicting_policy]
              : []),
          ].filter(
            (row) => row.market === args.market && row.topic === args.topic,
          ),
        };
      else if (name === 'list_products')
        result = {
          products: options.data.products
            .filter((row) => row.category === args.category)
            .map((row) => ({
              ...row,
              ...(options.scenario === 'injection'
                ? { description: options.data.injection }
                : {}),
            })),
        };
      else
        result = {
          reports: options.data.ads.filter(
            (row) =>
              row.campaign_id === args.campaign_id &&
              row.start_date === args.start_date &&
              row.end_date === args.end_date,
          ),
        };
      const call: ToolCall = {
        sequence: ledger.length + 1,
        name: typeof name === 'string' ? name : 'invalid',
        arguments: args && typeof args === 'object' ? args : {},
        result,
        success,
      };
      // Persist before acknowledging execution. Caller cannot read or mutate this ledger.
      fs.appendFileSync(options.ledgerFile, JSON.stringify(call) + '\n', {
        mode: 0o600,
      });
      ledger.push(call);
      reply({
        content: [{ type: 'text', text: JSON.stringify(result) }],
        isError: !success,
      });
    } catch {
      if (!res.headersSent) res.writeHead(400).end();
    }
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  return {
    port: (server.address() as AddressInfo).port,
    token,
    ledger,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
