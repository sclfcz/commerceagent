import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

const REDACTED = '[REDACTED]';
const MAX_CONTENT_LENGTH = 16_000;

const SENSITIVE_FIELD =
  /(?:api[_ -]?key|secret|token|auth(?:orization)?|password|cookie|credential|endpoint|base[_ -]?url|url|email|e-mail|phone|mobile|telephone|contact|address|street|recipient|consignee|receiver|customer(?:[_ -]?(?:name|info|profile))?|ship[_ -]?to|shipping[_ -]?contact|delivery[_ -]?contact|full[_ -]?name|收件|收货|联系人|地址|电话|手机|邮箱|客户信息|姓名|令牌|密钥|凭据)/i;

const SENSITIVE_ASSIGNMENT =
  /((?:api[_ -]?key|secret(?:[_ -]?key)?|access[_ -]?token|refresh[_ -]?token|token|auth(?:orization)?|password|endpoint|base[_ -]?url)\s*[:=]\s*)["']?[^,\s;"'}]+/gi;

const SECRET_SCHEME =
  /((?:proxy-)?authorization\s*[:=]\s*)(?:basic|bearer|token)\s+[^\s,;"']+/gi;
const SCHEME_CREDENTIAL = /\b(?:basic|bearer|token)\s+[A-Za-z0-9+/=_\-.~]+/gi;
const JWT =
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const GITHUB_TOKEN =
  /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/gi;
const AWS_ACCESS_KEY = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const SLACK_TOKEN = /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gi;
const GITLAB_TOKEN = /\bglpat-[A-Za-z0-9_-]{16,}\b/gi;
const API_STYLE_TOKEN = /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/gi;
const LONG_HEX = /\b[A-Fa-f0-9]{32,}\b/g;
const HIGH_ENTROPY_TOKEN = /\b[A-Za-z0-9_+/=-]{24,}\b/g;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const NATIONAL_ID = /(?<!\d)\d{17}[\dXx](?![\dXx])/g;
const PHONE =
  /(?<!\d)(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)\d{3,4}[\s.-]?\d{4}(?!\d)/g;
const EVIDENCE_ID =
  /(?<![A-Za-z0-9])(?:[A-Z]{2,}(?:-[A-Z]{2,})*)-\d{1,6}(?:-(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01]))?(?![A-Za-z0-9]|-\d)/g;

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function isHighEntropyToken(value: string): boolean {
  return (
    value.length >= 24 &&
    /[A-Za-z]/.test(value) &&
    /\d/.test(value) &&
    shannonEntropy(value) >= 3.5
  );
}

function isLuhnValid(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function redactCardNumbers(value: string): string {
  return value.replace(/(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g, (match) =>
    isLuhnValid(match) ? REDACTED : match,
  );
}

function redactIpAddresses(value: string): string {
  const bracketed = value.replace(
    /\[([0-9A-Fa-f:.]+)\](?::\d{1,5})?/g,
    (match, host: string) => (isIP(host) === 6 ? REDACTED : match),
  );
  const ipv4 = bracketed.replace(
    /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?![\w.])/g,
    (match) => {
      const [host, rawPort] = match.split(':');
      const port = rawPort === undefined ? undefined : Number(rawPort);
      return isIP(host) === 4 && (port === undefined || port <= 65535)
        ? REDACTED
        : match;
    },
  );
  return ipv4.replace(
    /(?<![0-9A-Fa-f:])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?![0-9A-Fa-f:])/g,
    (match) => (isIP(match) === 6 ? REDACTED : match),
  );
}

function redactChineseAddresses(value: string): string {
  return (
    value
      // Directly redact addresses in the four municipalities, which have no
      // province component (for example 北京市朝阳区建国路88号3楼).
      .replace(
        /(?:北京市|天津市|上海市|重庆市)[\u4e00-\u9fff]{2,}(?:区|县)[^,，。;；\r\n]{2,}?(?:路|街|巷|弄|号)[^,，。;；\r\n]*/g,
        REDACTED,
      )
      .replace(
        /(?:中国)?[\u4e00-\u9fff]{2,}(?:省|自治区)[\u4e00-\u9fff]{2,}(?:市|州|盟)[\u4e00-\u9fff]{2,}(?:区|县|镇|乡)[\u4e00-\u9fff0-9-]{2,}(?:路|街|巷|弄|号|楼|室)[\u4e00-\u9fff0-9-]*/g,
        REDACTED,
      )
  );
}

function redactText(value: string): string {
  const preservedIds: string[] = [];
  let result = value.replace(EVIDENCE_ID, (id) => {
    const index = preservedIds.push(id) - 1;
    return `__CA_EVIDENCE_ID_${index}__`;
  });
  result = result
    // Run credential/token patterns before phone/card patterns so digits in a
    // token can never be partially replaced while leaving the token prefix.
    .replace(SECRET_SCHEME, `$1${REDACTED}`)
    .replace(SCHEME_CREDENTIAL, REDACTED)
    .replace(SENSITIVE_ASSIGNMENT, `$1${REDACTED}`)
    .replace(GITHUB_TOKEN, REDACTED)
    .replace(AWS_ACCESS_KEY, REDACTED)
    .replace(SLACK_TOKEN, REDACTED)
    .replace(GITLAB_TOKEN, REDACTED)
    .replace(API_STYLE_TOKEN, REDACTED)
    .replace(JWT, REDACTED)
    .replace(LONG_HEX, REDACTED)
    .replace(HIGH_ENTROPY_TOKEN, (match) =>
      isHighEntropyToken(match) ? REDACTED : match,
    )
    .replace(/https?:\/\/[^\s<>"'`]+/gi, REDACTED)
    .replace(/\b(?:Cookie|Set-Cookie)\s*:\s*[^\r\n]+/gi, REDACTED)
    .replace(EMAIL, REDACTED)
    .replace(NATIONAL_ID, REDACTED);

  result = redactCardNumbers(result);
  result = result.replace(PHONE, REDACTED);
  result = redactIpAddresses(result);
  result = redactChineseAddresses(result);
  result = result.replace(
    /((?:recipient(?:[_ -]?(?:name|address))?|consignee|receiver(?:[_ -]?(?:name|address))?|customer(?:[_ -]?(?:name|info|profile))?|shipping\s*address|delivery\s*address|address|收件人|收货人|联系人|收件地址|收货地址|配送地址|地址)\s*(?:是|[:：=])\s*)[^,，。;；\r\n]+/gi,
    `$1${REDACTED}`,
  );
  result = result.replace(
    /\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,5}\s+(?:Street|St|Road|Rd|Avenue|Ave|Boulevard|Blvd|Lane|Ln|Drive|Dr|Apartment|Apt|Unit)\.?\s*(?:#\s*)?[A-Za-z0-9-]*\b/gi,
    REDACTED,
  );
  result = result.replace(
    /__CA_EVIDENCE_ID_(\d+)__/g,
    (placeholder, rawIndex) => preservedIds[Number(rawIndex)] ?? placeholder,
  );
  return result.slice(0, MAX_CONTENT_LENGTH);
}

/** Recursively remove sensitive fields and redact sensitive values in free text. */
export function redactObservabilityValue(
  value: unknown,
  fieldName = '',
): unknown {
  if (SENSITIVE_FIELD.test(fieldName)) return REDACTED;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.stringify(
          redactObservabilityValue(JSON.parse(trimmed)),
        ).slice(0, MAX_CONTENT_LENGTH);
      } catch {
        // Treat malformed JSON as ordinary text and still apply pattern rules.
      }
    }
    return redactText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactObservabilityValue(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        redactObservabilityValue(child, key),
      ]),
    );
  }
  return value;
}

export function getResidualSensitiveCategories(value: string): string[] {
  const scanValue = value.replace(EVIDENCE_ID, '[SAFE_EVIDENCE_ID]');
  const has = (pattern: RegExp) => {
    pattern.lastIndex = 0;
    return pattern.test(scanValue);
  };
  const categories: string[] = [];
  if (has(SECRET_SCHEME)) categories.push('auth_scheme');
  if (has(SCHEME_CREDENTIAL)) categories.push('credential_scheme');
  const assignmentPattern = new RegExp(
    SENSITIVE_ASSIGNMENT.source,
    SENSITIVE_ASSIGNMENT.flags,
  );
  const hasUnredactedAssignment = Array.from(
    scanValue.matchAll(assignmentPattern),
  ).some((match) => {
    const complete = match[0] ?? '';
    const prefix = match[1] ?? '';
    const assignedValue = complete.slice(prefix.length).replace(/^['"]/, '');
    return !assignedValue.startsWith(REDACTED);
  });
  if (hasUnredactedAssignment) categories.push('credential_assignment');
  if (has(GITHUB_TOKEN)) categories.push('github_token');
  if (has(AWS_ACCESS_KEY)) categories.push('aws_access_key');
  if (has(SLACK_TOKEN)) categories.push('slack_token');
  if (has(GITLAB_TOKEN)) categories.push('gitlab_token');
  if (has(API_STYLE_TOKEN)) categories.push('api_style_token');
  if (has(JWT)) categories.push('jwt');
  if (has(LONG_HEX)) categories.push('long_hex');
  if (new RegExp(NATIONAL_ID.source, NATIONAL_ID.flags).test(scanValue)) {
    categories.push('national_id');
  }
  if (has(EMAIL)) categories.push('email');
  if (has(PHONE)) categories.push('phone');
  if (redactCardNumbers(scanValue) !== scanValue)
    categories.push('payment_card');
  if (redactIpAddresses(scanValue) !== scanValue) categories.push('ip_address');
  if (redactChineseAddresses(scanValue) !== scanValue)
    categories.push('street_address');
  const highEntropyPattern = new RegExp(
    HIGH_ENTROPY_TOKEN.source,
    HIGH_ENTROPY_TOKEN.flags,
  );
  if (
    Array.from(scanValue.matchAll(highEntropyPattern)).some(([match]) =>
      isHighEntropyToken(match),
    )
  ) {
    categories.push('high_entropy_token');
  }
  return categories;
}

function serialize(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * If sanitization leaves a high-risk pattern, fail closed with metadata only.
 * Exported so the fallback can be directly tested with simulated residuals.
 */
export function failClosedOnResidualSensitiveContent(
  originalContent: string,
  redactedContent: string,
): string {
  if (getResidualSensitiveCategories(redactedContent).length === 0) {
    return redactedContent;
  }
  return JSON.stringify({
    content_redacted: true,
    original_length: originalContent.length,
    original_sha256: createHash('sha256').update(originalContent).digest('hex'),
  });
}

export function serializeRedactedContent(value: unknown): string {
  const original = serialize(value);
  const redacted = serialize(redactObservabilityValue(value)).slice(
    0,
    MAX_CONTENT_LENGTH,
  );
  return failClosedOnResidualSensitiveContent(original, redacted);
}
