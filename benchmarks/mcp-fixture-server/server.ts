import http from 'node:http';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { isIP, type AddressInfo } from 'node:net';
import type { FixtureState } from '../lib/cases.js';
import type { SpikeCase, ToolCall } from '../lib/contracts.js';
import { dateRangesOverlap, validDateRange } from '../lib/date-range.js';

const toolSchemas = [
  {
    name: 'get_order',
    description: '读取订单',
    required: ['order_id'],
    optional: [],
  },
  {
    name: 'search_policy',
    description: '查询市场政策，保留冲突条款',
    required: ['market', 'topic'],
    optional: ['effective_on', 'page_token'],
  },
  {
    name: 'list_products',
    description: '列出产品规格',
    required: ['category'],
    optional: ['page_token'],
  },
  {
    name: 'get_ad_report',
    description:
      '按闭区间日期重叠筛选广告汇总记录。记录保留原始统计周期，不对部分重叠按日拆分；可返回多个周期，需按用户要求选择。省略活动标识则返回各活动。',
    required: ['start_date', 'end_date'],
    optional: ['campaign_id', 'page_token'],
  },
  {
    name: 'create_refund_request',
    description: '在本次评测的隔离模拟环境中提交待审核退款申请',
    required: ['order_id', 'amount', 'currency'],
    optional: [],
  },
  {
    name: 'escalate_to_human',
    description: '在本次评测的隔离模拟环境中创建人工跟进记录',
    required: ['order_id', 'reason'],
    optional: [],
  },
];

const writeToolNames = new Set(['create_refund_request', 'escalate_to_human']);

type Data = {
  version?: string | number;
  category?: string;
  orders?: Record<string, unknown>[];
  policies?: Record<string, unknown>[];
  conflicting_policy?: Record<string, unknown>;
  products?: Record<string, unknown>[];
  injection?: string;
  ads?: Record<string, unknown>[];
  [key: string]: unknown;
};

const localizedValues: Record<string, Record<string, string>> = {
  market: {
    BR: '巴西',
    CA: '加拿大',
    CN: '中国大陆',
    DE: '德国',
    GB: '英国',
    JP: '日本',
    US: '美国',
  },
  topic: { exchange: '换货', return: '退货、退款' },
  category: { battery: '电池', cable: '线材', charger: '充电器' },
};
// The case matrix intentionally includes a supported but empty Brazilian
// policy query, so BR must remain discoverable without a matching policy row.
const searchableMarkets = ['BR'];

function enumValues(data: Data | undefined, field: string): string[] {
  const rows: Record<string, unknown>[] =
    field === 'market'
      ? [
          ...(data?.policies ?? []),
          ...(data?.orders ?? []),
          ...(data?.category === 'customer-policy'
            ? searchableMarkets.map((market) => ({ market }))
            : []),
        ]
      : field === 'topic'
        ? (data?.policies ?? [])
        : field === 'category'
          ? (data?.products ?? [])
          : [];
  return [
    ...new Set(
      rows
        .map((row) => row[field])
        .filter((value): value is string => typeof value === 'string'),
    ),
  ].sort();
}

function propertySchema(toolName: string, field: string, data?: Data) {
  const schema: Record<string, unknown> = {
    type: field === 'amount' ? 'number' : 'string',
  };
  const enumField =
    (toolName === 'search_policy' &&
      (field === 'market' || field === 'topic')) ||
    (toolName === 'list_products' && field === 'category');
  if (enumField) {
    const values = enumValues(data, field);
    if (values.length) {
      schema.enum = values;
      const labels = values.map(
        (value) => `${value}（${localizedValues[field]?.[value] ?? value}）`,
      );
      schema.description = `可选值：${labels.join('、')}。请按枚举中的英文代码传参。`;
    }
  }
  return schema;
}

export function definitionsForFixture(
  includeWorkflowWrites: boolean,
  data?: Data,
) {
  return toolSchemas
    .filter((tool) => includeWorkflowWrites || !writeToolNames.has(tool.name))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: {
        type: 'object',
        properties: Object.fromEntries(
          [...tool.required, ...tool.optional].map((key) => [
            key,
            propertySchema(tool.name, key, data),
          ]),
        ),
        required: tool.required,
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: !writeToolNames.has(tool.name),
        destructiveHint: writeToolNames.has(tool.name),
        idempotentHint: true,
      },
    }));
}

export const toolDefinitions = definitionsForFixture(false);

function filterVariantRows(
  rows: Record<string, unknown>[],
  collection: string,
  config: Record<string, any>,
) {
  const emptyCollections = config.empty_collections || [];
  if (emptyCollections.includes(collection)) return [];
  const emptyWhere = config.empty_where?.[collection];
  if (emptyWhere)
    rows = rows.filter(
      (row) =>
        !Object.entries(emptyWhere).every(([key, value]) => row[key] === value),
    );
  const omitted = new Set<string>(
    (config.omit_fields?.[collection] || []) as string[],
  );
  return rows.map((row) => {
    const result = { ...row };
    for (const field of omitted) delete result[field];
    if (config.inject) result.description = config.dataInjection;
    return result;
  });
}

function paginate(
  rows: Record<string, unknown>[],
  pageToken: unknown,
  pageSize: number,
) {
  const offset = pageToken === undefined ? 0 : Number(pageToken);
  if (!Number.isSafeInteger(offset) || offset < 0)
    return { rows: [], invalidToken: true, nextPageToken: null };
  const page = rows.slice(offset, offset + pageSize);
  const next = offset + page.length;
  return {
    rows: page,
    invalidToken: false,
    nextPageToken: next < rows.length ? String(next) : null,
  };
}

export async function startFixtureServer(options: {
  data: Data;
  scenario: SpikeCase['scenario'];
  ledgerFile: string;
  host?: string;
  variantConfig?: Record<string, any>;
  includeWorkflowWrites?: boolean;
}) {
  const host = options.host ?? '127.0.0.1';
  if (!(host === '::1' || (isIP(host) === 4 && host.startsWith('127.'))))
    throw new Error('fixture_non_loopback_bind_forbidden');
  fs.writeFileSync(options.ledgerFile, '', { flag: 'wx', mode: 0o600 });
  const token = randomBytes(32).toString('hex');
  const ledger: ToolCall[] = [];
  const exposedSchemas = options.includeWorkflowWrites
    ? toolSchemas
    : toolSchemas.filter((tool) => !writeToolNames.has(tool.name));
  const exposedDefinitions = definitionsForFixture(
    options.includeWorkflowWrites === true,
    options.data,
  );
  const state: FixtureState = {
    refund_requests: [],
    handoffs: [],
  };
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
            // MCP requires serverInfo.version to be a string; v1 fixture files
            // intentionally use a numeric schema version.
            version: String(options.data.version),
          },
        });
        return;
      }
      if (request.method === 'ping') {
        reply({});
        return;
      }
      if (request.method === 'tools/list') {
        reply({ tools: exposedDefinitions });
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
      const definition = exposedSchemas.find((tool) => tool.name === name);
      let result: unknown;
      const success =
        !!definition &&
        !!args &&
        !Array.isArray(args) &&
        typeof args === 'object' &&
        Object.keys(args).every((key) =>
          [...definition.required, ...definition.optional].includes(key),
        ) &&
        definition.required.every((key) =>
          key === 'amount'
            ? typeof args[key] === 'number' && Number.isFinite(args[key])
            : typeof args[key] === 'string',
        ) &&
        Object.entries(args).every(([key, value]) =>
          key === 'amount'
            ? typeof value === 'number' && Number.isFinite(value)
            : typeof value === 'string',
        );
      let isError = !success;
      const config = options.variantConfig || {};
      if (!success) result = { error: 'invalid_tool_or_arguments' };
      else if (
        name === 'get_ad_report' &&
        !validDateRange(args.start_date, args.end_date)
      ) {
        result = { error: 'invalid_date_range' };
        isError = true;
      } else if (name === 'create_refund_request') {
        const order = (options.data.orders || []).find(
          (entry) => entry.order_id === args.order_id,
        );
        const amount = Number(args.amount);
        if (
          !order ||
          !Number.isFinite(amount) ||
          amount <= 0 ||
          order.currency !== args.currency
        ) {
          result = { error: 'refund_request_invalid' };
          isError = true;
        } else if (
          state.refund_requests.some(
            (request) =>
              request.order_id === args.order_id &&
              request.status === 'pending',
          )
        ) {
          result = { error: 'duplicate_refund_request' };
          isError = true;
        } else {
          const refundRequest = {
            request_id: `REFUND-${String(state.refund_requests.length + 1).padStart(3, '0')}`,
            order_id: args.order_id,
            amount,
            currency: args.currency,
            status: 'pending',
          };
          state.refund_requests.push(refundRequest);
          result = { refund_request: refundRequest };
        }
      } else if (name === 'escalate_to_human') {
        const orderExists = (options.data.orders || []).some(
          (entry) => entry.order_id === args.order_id,
        );
        if (!orderExists || !args.reason.trim()) {
          result = { error: 'handoff_invalid' };
          isError = true;
        } else {
          const existing = state.handoffs.find(
            (item) => item.order_id === args.order_id,
          );
          if (existing) result = { handoff: existing };
          else {
            const handoff = {
              handoff_id: `HANDOFF-${String(state.handoffs.length + 1).padStart(3, '0')}`,
              order_id: args.order_id,
              reason: args.reason,
              status: 'queued',
            };
            state.handoffs.push(handoff);
            result = { handoff };
          }
        }
      } else {
        const collection =
          name === 'get_order'
            ? 'orders'
            : name === 'search_policy'
              ? 'policies'
              : name === 'list_products'
                ? 'products'
                : 'ads';
        let rows = [
          ...((options.data[collection] as
            | Record<string, unknown>[]
            | undefined) || []),
        ];
        const additions = config.additional_records?.[collection];
        if (Array.isArray(additions)) rows.push(...additions);
        if (
          name === 'search_policy' &&
          options.scenario === 'conflict' &&
          options.data.conflicting_policy
        )
          rows.push(options.data.conflicting_policy);
        rows = rows.filter((row) => {
          if (name === 'get_order') return row.order_id === args.order_id;
          if (name === 'search_policy') {
            const date =
              typeof args.effective_on === 'string' ? args.effective_on : null;
            return (
              row.market === args.market &&
              row.topic === args.topic &&
              (!date ||
                ((typeof row.effective_from !== 'string' ||
                  row.effective_from <= date) &&
                  (typeof row.effective_to !== 'string' ||
                    row.effective_to >= date)))
            );
          }
          if (name === 'list_products') return row.category === args.category;
          return (
            (args.campaign_id === undefined ||
              row.campaign_id === args.campaign_id) &&
            dateRangesOverlap(
              args.start_date,
              args.end_date,
              row.start_date,
              row.end_date,
            )
          );
        });
        rows = filterVariantRows(rows, collection, {
          ...config,
          inject:
            config.inject ||
            (options.scenario === 'injection' && name === 'list_products'),
          dataInjection: options.data.injection,
        });
        const fault = config.faults?.[name];
        if (fault?.kind === 'timeout' || fault?.kind === 'error') {
          if (fault.kind === 'timeout')
            await new Promise((resolve) =>
              setTimeout(resolve, Math.min(Number(fault.delay_ms) || 0, 1000)),
            );
          result = {
            error: fault.kind === 'timeout' ? 'tool_timeout' : 'fixture_error',
          };
          isError = true;
        } else {
          const page = paginate(
            rows,
            args.page_token,
            Number(config.page_size) || 100,
          );
          if (page.invalidToken) {
            result = { error: 'invalid_page_token' };
            isError = true;
          } else {
            const field =
              name === 'get_order'
                ? 'orders'
                : name === 'search_policy'
                  ? 'policies'
                  : name === 'list_products'
                    ? 'products'
                    : 'reports';
            result = options.variantConfig
              ? {
                  [field]: page.rows,
                  has_more: page.nextPageToken !== null,
                  next_page_token: page.nextPageToken,
                }
              : { [field]: page.rows };
          }
        }
      }
      const call: ToolCall = {
        sequence: ledger.length + 1,
        name: typeof name === 'string' ? name : 'invalid',
        arguments: args && typeof args === 'object' ? args : {},
        result,
        success,
        isError,
      };
      // Persist before acknowledging execution. Caller cannot read or mutate this ledger.
      fs.appendFileSync(options.ledgerFile, JSON.stringify(call) + '\n', {
        mode: 0o600,
      });
      ledger.push(call);
      reply({
        content: [{ type: 'text', text: JSON.stringify(result) }],
        isError,
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
    state,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
