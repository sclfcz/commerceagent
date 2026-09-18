import pino from 'pino';

const REDACTED = '[REDACTED]';
const MAX_LOG_ERROR_MESSAGE_LENGTH = 2_000;
const MAX_LOG_STRUCTURE_DEPTH = 8;
const MAX_LOG_ARRAY_ITEMS = 50;
const MAX_LOG_OBJECT_KEYS = 100;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

function readProperty(
  value: Record<string, unknown> | undefined,
  key: string,
): unknown {
  if (!value) return undefined;
  try {
    return value[key];
  } catch {
    // Error objects may expose values through throwing getters. Logging must
    // never turn an operational failure into another failure.
    return undefined;
  }
}

function readString(
  value: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const candidate = readProperty(value, key);
  return typeof candidate === 'string' && candidate.length > 0
    ? candidate
    : undefined;
}

function readNumber(
  value: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const candidate = readProperty(value, key);
  return typeof candidate === 'number' && Number.isFinite(candidate)
    ? candidate
    : undefined;
}

/**
 * Redact credentials that may be embedded in an otherwise useful provider
 * error message. Structured request/response objects are never copied by the
 * error serializer below; this is the final guard for inline values.
 */
export function redactLogMessage(value: string): string {
  const bounded =
    value.length > MAX_LOG_ERROR_MESSAGE_LENGTH
      ? `${value.slice(0, MAX_LOG_ERROR_MESSAGE_LENGTH)}…[truncated]`
      : value;
  return bounded
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-=]+/giu, `$1 ${REDACTED}`)
    .replace(
      /(\b(?:authorization|cookie|token|password|passwd|secret|api[_-]?key|app[_-]?secret|access[_-]?token|refresh[_-]?token)\b["']?\s*[=:]\s*)(?:"[^"\n]*"?|'[^'\n]*'?|[^\s"',;]+)/giu,
      `$1${REDACTED}`,
    )
    .replace(
      /(\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s/:@]+:)[^\s@/?#]+(@)/giu,
      `$1${REDACTED}$2`,
    )
    .replace(/\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/gu, REDACTED)
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/gu, REDACTED)
    .replace(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/gu,
      REDACTED,
    );
}

/**
 * Convert arbitrary thrown values to a diagnostic-only shape.
 *
 * Axios and the Lark SDK attach the entire HTTP request to an Error, including
 * Authorization headers in `config.headers` and raw headers in
 * `request._header`. Pino's default Error serializer follows those enumerable
 * properties. This whitelist deliberately retains only status and provider
 * diagnostics; config, request, headers, response bodies, and causes never
 * cross the logging boundary. The stack is retained only after the same
 * credential redaction and size bound applied to error messages.
 */
export function serializeErrorForLog(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    return { message: redactLogMessage(value) };
  }
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function')
  ) {
    return { message: redactLogMessage(String(value)) };
  }

  const error = asRecord(value);
  const response = asRecord(readProperty(error, 'response'));
  const responseData = asRecord(readProperty(response, 'data'));
  const responseError = asRecord(readProperty(responseData, 'error'));
  const responseHeaders = asRecord(readProperty(response, 'headers'));

  const serialized: Record<string, unknown> = {};
  const name = readString(error, 'name');
  const message = readString(error, 'message');
  const stack = readString(error, 'stack');
  const code = readProperty(error, 'code');
  const status =
    readNumber(error, 'status') ??
    readNumber(error, 'statusCode') ??
    readNumber(response, 'status') ??
    readNumber(response, 'statusCode');
  const feishuCode =
    readNumber(responseData, 'code') ??
    readNumber(response, 'code') ??
    (typeof code === 'number' ? code : undefined);
  const feishuMessage =
    readString(responseData, 'msg') ?? readString(responseData, 'message');
  const feishuLogId =
    readString(responseData, 'log_id') ??
    readString(responseData, 'logId') ??
    readString(responseError, 'log_id') ??
    readString(responseError, 'logId') ??
    readString(error, 'log_id') ??
    readString(error, 'logId') ??
    readString(responseHeaders, 'x-tt-logid') ??
    readString(responseHeaders, 'x-tt-log-id');

  if (name) serialized.name = redactLogMessage(name);
  serialized.message = redactLogMessage(message || 'Unknown error');
  if (stack) serialized.stack = redactLogMessage(stack);
  if (typeof code === 'string') {
    serialized.code = redactLogMessage(code);
  } else if (typeof code === 'number') {
    serialized.code = code;
  }
  if (status !== undefined) serialized.status = status;
  if (feishuCode !== undefined) serialized.feishuCode = feishuCode;
  if (feishuMessage) {
    serialized.feishuMessage = redactLogMessage(feishuMessage);
  }
  if (feishuLogId) serialized.feishuLogId = redactLogMessage(feishuLogId);

  return serialized;
}

function isSensitiveLogKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (
    normalized === 'authorization' ||
    normalized === 'cookie' ||
    normalized === 'setcookie' ||
    normalized === 'header' ||
    normalized === 'rawheader' ||
    normalized === 'rawheaders' ||
    normalized === 'password' ||
    normalized === 'passwd' ||
    normalized === 'sessionid' ||
    normalized.includes('token') ||
    normalized.includes('secret') ||
    normalized.includes('apikey') ||
    normalized.includes('authkey')
  );
}

function sanitizeLogValue(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (typeof value === 'string') return redactLogMessage(value);
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'undefined') return undefined;
  if (typeof value === 'symbol' || typeof value === 'function') {
    return String(value);
  }
  if (value instanceof Error) return serializeErrorForLog(value);
  if (depth >= MAX_LOG_STRUCTURE_DEPTH) return '[MaxDepth]';

  const object = value as object;
  if (seen.has(object)) return '[Circular]';
  seen.add(object);

  if (Array.isArray(value)) {
    const sanitized = value
      .slice(0, MAX_LOG_ARRAY_ITEMS)
      .map((item) => sanitizeLogValue(item, seen, depth + 1));
    if (value.length > MAX_LOG_ARRAY_ITEMS) sanitized.push('[Truncated]');
    return sanitized;
  }

  const record = asRecord(value);
  if (!record) return String(value);
  const sanitized: Record<string, unknown> = {};
  let count = 0;
  for (const key of Object.keys(record)) {
    if (count >= MAX_LOG_OBJECT_KEYS) {
      sanitized.__truncated__ = true;
      break;
    }
    count += 1;
    if (isSensitiveLogKey(key)) {
      sanitized[key] = REDACTED;
      continue;
    }
    const property = readProperty(record, key);
    sanitized[key] = sanitizeLogValue(property, seen, depth + 1);
  }
  return sanitized;
}

/**
 * Sanitize every structured log field, including Errors logged under names
 * such as `sendErr` or nested inside arrays/causes. Pino's path redaction stays
 * as defense in depth, but this formatter is the boundary that prevents an
 * unfamiliar SDK error shape from serializing raw HTTP credentials.
 */
export function sanitizeLogObject(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return sanitizeLogValue(value, new WeakSet(), 0) as Record<string, unknown>;
}

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  serializers: {
    err: serializeErrorForLog,
    error: serializeErrorForLog,
  },
  formatters: {
    log: sanitizeLogObject,
  },
  redact: {
    paths: [
      'token',
      'password',
      'secret',
      'apiKey',
      'api_key',
      'authorization',
      'Authorization',
      'cookie',
      'Cookie',
      'sessionId',
      '*.token',
      '*.password',
      '*.secret',
      '*.apiKey',
      '*.api_key',
      '*.authorization',
      '*.Authorization',
      '*.cookie',
      '*.Cookie',
      '*.sessionId',
      '*.appSecret',
      '*.app_secret',
      '*.appId',
      '*.anthropicApiKey',
      '*.anthropicAuthToken',
      '*.botToken',
      '*.bot_token',
      'headers.authorization',
      'headers.Authorization',
      'headers.cookie',
      'headers.Cookie',
      '*.headers.authorization',
      '*.headers.Authorization',
      '*.headers.cookie',
      '*.headers.Cookie',
      '*.config.headers.authorization',
      '*.config.headers.Authorization',
      '*.config.headers.cookie',
      '*.config.headers.Cookie',
      '*.request._header',
      '*.response.request._header',
      '*.response.config.headers.authorization',
      '*.response.config.headers.Authorization',
      '*.response.config.headers.cookie',
      '*.response.config.headers.Cookie',
    ],
    censor: REDACTED,
  },
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
    },
  },
});

// Route uncaught errors through pino so they get timestamps in stderr
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
  // 不立即退出：unhandled rejection 通常非致命（如 API 超时未 catch），
  // 立即 exit 会导致长期运行服务丢失正在处理的消息和容器管理状态。
  // uncaughtException 仍保持 exit(1)，因为异常会破坏进程状态。
});
