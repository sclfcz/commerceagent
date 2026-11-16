import type { ExtractedCandidate } from './schema.js';

/**
 * Content filters applied before a candidate is written.
 *
 * They are deliberately conservative: dropping a legitimate candidate is cheap
 * (the user can still record it by hand), while a credential or personal datum
 * that lands in the Workspace Memory store is durable and gets replayed into
 * every later session's prompt.
 */

const SENSITIVE_PATTERNS: RegExp[] = [
  // Provider/API credentials and token shapes.
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i,
  // Key/value style secrets ("password: ...", "api_key=...").
  /\b(?:password|passwd|pwd|secret|api[\s_-]?key|access[\s_-]?token|refresh[\s_-]?token|client[\s_-]?secret|private[\s_-]?key)\b\s*[:=]\s*\S{6,}/i,
  // Connection strings that embed credentials.
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|mssql):\/\/\S+/i,
  // Personal data. Order numbers, SKUs and timestamps are common in this
  // product's conversations, so each pattern stays narrow: a bare long digit
  // run is not treated as a card number unless the text says so.
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
  /\b1[3-9]\d{9}\b/,
  /\b\d{17}[\dXx]\b/,
  /(?:卡号|银行卡|信用卡|card\s*(?:no|number)?)\s*[:：]?\s*(?:\d[ -]?){13,19}/i,
  // Private-network addresses are infrastructure detail, not workspace knowledge.
  /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/,
];

export function containsSensitiveContent(text: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(text));
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replaceAll(/[\s\p{P}\p{S}]/gu, '')
    .trim();
}

function bigrams(value: string): Set<string> {
  const grams = new Set<string>();
  for (let index = 0; index < value.length - 1; index += 1) {
    grams.add(value.slice(index, index + 2));
  }
  return grams;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const gram of a) if (b.has(gram)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

const DUPLICATE_SIMILARITY = 0.85;
const CONTAINMENT_RATIO = 0.75;

export interface ExistingMemoryForDedupe {
  id: string;
  status: string;
  kind: string;
  title: string | null;
  content: string;
  canonicalKey: string | null;
}

/**
 * Decide whether a candidate repeats something the Workspace already knows.
 *
 * Canonical-key equality is exact; content is compared after removing
 * whitespace and punctuation, by containment (one is essentially the other,
 * reworded only at the edges) and by character-bigram Jaccard similarity. The
 * same rules run against candidates emitted earlier in the same response, so a
 * model repeating itself is collapsed too.
 */
export function findDuplicateReason(
  candidate: ExtractedCandidate,
  existing: readonly ExistingMemoryForDedupe[],
): 'canonical_key' | 'content' | null {
  const candidateKey = candidate.title.trim().toLowerCase();
  const candidateContent = normalize(candidate.content);
  const candidateGrams = bigrams(candidateContent);
  for (const entry of existing) {
    if (
      candidateKey &&
      entry.canonicalKey &&
      candidateKey === entry.canonicalKey.trim().toLowerCase()
    ) {
      return 'canonical_key';
    }
    const existingContent = normalize(entry.content);
    if (!existingContent || !candidateContent) continue;
    const shorter = Math.min(existingContent.length, candidateContent.length);
    const longer = Math.max(existingContent.length, candidateContent.length);
    if (
      shorter / longer >= CONTAINMENT_RATIO &&
      (existingContent.includes(candidateContent) ||
        candidateContent.includes(existingContent))
    ) {
      return 'content';
    }
    if (
      jaccard(candidateGrams, bigrams(existingContent)) >= DUPLICATE_SIMILARITY
    ) {
      return 'content';
    }
  }
  return null;
}
