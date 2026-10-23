const REDACTED = '[REDACTED]';
const MAX_CONTENT_LENGTH = 16_000;

const SENSITIVE_FIELD =
  /(?:api[_ -]?key|secret|token|auth(?:orization)?|password|cookie|credential|endpoint|base[_ -]?url|url|email|e-mail|phone|mobile|telephone|contact|address|street|recipient|consignee|receiver|customer(?:[_ -]?(?:name|info|profile))?|ship[_ -]?to|shipping[_ -]?contact|delivery[_ -]?contact|full[_ -]?name|收件|收货|联系人|地址|电话|手机|邮箱|客户信息|姓名|令牌|密钥|凭据)/i;

function redactText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s<>"'`]+/gi, REDACTED)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, `Bearer ${REDACTED}`)
    .replace(/\b(?:Cookie|Set-Cookie)\s*:\s*[^\r\n]+/gi, REDACTED)
    .replace(
      /((?:api[_ -]?key|secret(?:[_ -]?key)?|token|auth(?:orization)?|password|endpoint|base[_ -]?url)\s*[:=]\s*)["']?[^,\s;"'}]+/gi,
      `$1${REDACTED}`,
    )
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/gi, REDACTED)
    .replace(
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
      REDACTED,
    )
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, REDACTED)
    .replace(
      /(?<!\d)(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)\d{3,4}[\s.-]?\d{4}(?!\d)/g,
      REDACTED,
    )
    .replace(
      /((?:recipient(?:[_ -]?(?:name|address))?|consignee|receiver(?:[_ -]?(?:name|address))?|customer(?:[_ -]?(?:name|info|profile))?|shipping\s*address|delivery\s*address|address|收件人|收货人|联系人|收件地址|收货地址|配送地址|地址)\s*(?:是|[:：=])\s*)[^,，。;；\r\n]+/gi,
      `$1${REDACTED}`,
    )
    .replace(
      /(?:中国)?[\u4e00-\u9fff]{2,}(?:省|自治区)?[\u4e00-\u9fff]{2,}(?:市|州|盟)[\u4e00-\u9fff]{2,}(?:区|县|镇|乡)[\u4e00-\u9fff0-9-]{2,}(?:路|街|巷|弄|号|楼|室)\S*/g,
      REDACTED,
    )
    .replace(
      /\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,5}\s+(?:Street|St|Road|Rd|Avenue|Ave|Boulevard|Blvd|Lane|Ln|Drive|Dr|Apartment|Apt|Unit)\.?\s*(?:#\s*)?[A-Za-z0-9-]*\b/gi,
      REDACTED,
    )
    .slice(0, MAX_CONTENT_LENGTH);
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

export function serializeRedactedContent(value: unknown): string {
  const redacted = redactObservabilityValue(value);
  const serialized =
    typeof redacted === 'string' ? redacted : JSON.stringify(redacted);
  return (serialized ?? '').slice(0, MAX_CONTENT_LENGTH);
}
