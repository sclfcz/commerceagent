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

function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return text.slice(start, end + 1);
}

/**
 * Tolerate a fenced code block (models often add one) but nothing else: the
 * outermost JSON object must parse and match the schema exactly.
 */
export function parseExtractionResponse(text: string): ExtractionParseResult {
  const json = extractJsonObject(text);
  if (!json) return { ok: false, reason: 'no JSON object in response' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'response is not valid JSON' };
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
