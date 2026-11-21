import { z } from 'zod';

import {
  MEMORY_EXTRACTION_MAX_APPLIES_WHEN_CHARS,
  MEMORY_EXTRACTION_MAX_CANDIDATES,
  MEMORY_EXTRACTION_MAX_CONTENT_CHARS,
  MEMORY_EXTRACTION_MAX_TITLE_CHARS,
} from './config.js';

/**
 * Strict schema for the extraction model's JSON response.
 *
 * The model is untrusted input: anything that does not match exactly is
 * dropped as a whole response rather than partially repaired, so a malformed
 * reply can never become a half-valid memory candidate.
 */
export const EXTRACTION_KINDS = [
  'fact',
  'decision',
  'lesson',
  'open_loop',
] as const;

const SearchKeySchema = z.string().trim().min(1).max(64);

const CandidateSchema = z
  .object({
    kind: z.enum(EXTRACTION_KINDS),
    title: z.string().trim().min(1).max(MEMORY_EXTRACTION_MAX_TITLE_CHARS),
    content: z.string().trim().min(1).max(MEMORY_EXTRACTION_MAX_CONTENT_CHARS),
    search_keys: z.array(SearchKeySchema).max(6).optional(),
    confidence: z.number().min(0).max(1),
    importance: z.number().min(0).max(1),
    evidence_message_ids: z.array(z.string().trim().min(1).max(200)).max(20),
    applies_when: z
      .string()
      .trim()
      .min(1)
      .max(MEMORY_EXTRACTION_MAX_APPLIES_WHEN_CHARS)
      .optional(),
  })
  .strict();

export const ExtractionResponseSchema = z
  .object({
    candidates: z.array(CandidateSchema).max(MEMORY_EXTRACTION_MAX_CANDIDATES),
  })
  .strict();

export type ExtractedCandidate = z.infer<typeof CandidateSchema>;

export type ExtractionParseResult =
  | {
      ok: true;
      candidates: ExtractedCandidate[];
      dropped: number;
    }
  | { ok: false; reason: string };

/**
 * Slice out the first complete top-level JSON object.
 *
 * Models frequently wrap the object in a code fence or append a sentence after
 * it. Slicing from the first `{` to the *last* `}` breaks as soon as that
 * trailing sentence contains a brace; scanning for the matching close brace
 * (while respecting string literals) keeps the object intact and ignores
 * everything around it.
 */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  // Unterminated object: hand the tail to JSON.parse so the rejection reason
  // still reports where parsing stopped.
  return text.slice(start);
}

/**
 * Trailing commas are a common, harmless LLM artifact. Remove only the ones
 * that sit outside string literals, directly before a closing bracket: memory
 * content regularly quotes JSON or code, so a plain regex would rewrite text
 * such as `示例 {\"a\": 1,}` inside a candidate.
 */
function stripTrailingCommas(json: string): string {
  const out: string[] = [];
  let inString = false;
  let escaped = false;
  let pendingComma: number | null = null;
  const isWhitespace = (char: string): boolean =>
    char === ' ' || char === '\t' || char === '\n' || char === '\r';
  for (const char of json) {
    if (inString) {
      out.push(char);
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      pendingComma = null;
    } else if (char === ',') {
      pendingComma = out.length;
    } else if (char === '}' || char === ']') {
      if (pendingComma !== null) {
        out[pendingComma] = '';
        pendingComma = null;
      }
    } else if (!isWhitespace(char)) {
      pendingComma = null;
    }
    out.push(char);
  }
  return out.join('');
}

/**
 * Tolerate a fence or surrounding prose but nothing else: the first complete
 * JSON object must parse and match the schema exactly. The rejection reason
 * carries the parser's message (position only, never content) so operators can
 * tell truncation apart from malformed output without logging the transcript.
 */
export function parseExtractionResponse(text: string): ExtractionParseResult {
  const json = extractJsonObject(text);
  if (!json) return { ok: false, reason: 'no JSON object in response' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    try {
      parsed = JSON.parse(stripTrailingCommas(json));
    } catch {
      const detail = error instanceof Error ? error.message : 'parse failed';
      return {
        ok: false,
        reason: `response is not valid JSON (length ${text.length}): ${detail.slice(0, 120)}`,
      };
    }
  }
  const result = ExtractionResponseSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      reason: 'response does not match the candidate schema',
    };
  }
  return { ok: true, candidates: result.data.candidates, dropped: 0 };
}
