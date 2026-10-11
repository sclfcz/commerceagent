import fs from 'node:fs';
import { parse } from 'yaml';

export interface CandidatePrice {
  effective_date: string;
  currency: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  reasoning: number;
  source: string;
}

export function loadPrices(
  file: string,
): Record<string, Partial<CandidatePrice>> {
  const value = parse(fs.readFileSync(file, 'utf8')) as {
    candidates?: Record<string, Partial<CandidatePrice>>;
  };
  return value?.candidates || {};
}

export function calculateCost(
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    reasoningTokens: number;
  } | null,
  price: Partial<CandidatePrice> | undefined,
): number | null {
  if (!usage || !price) return null;
  const fields: Array<keyof CandidatePrice> = [
    'input',
    'output',
    'cache_read',
    'cache_write',
    'reasoning',
  ];
  if (
    fields.some(
      (field) =>
        typeof price[field] !== 'number' ||
        !Number.isFinite(price[field]) ||
        price[field]! < 0,
    )
  )
    return null;
  const ordinaryOutput = Math.max(
    0,
    usage.outputTokens - usage.reasoningTokens,
  );
  return (
    (usage.inputTokens * price.input! +
      ordinaryOutput * price.output! +
      usage.cacheReadInputTokens * price.cache_read! +
      usage.cacheCreationInputTokens * price.cache_write! +
      usage.reasoningTokens * price.reasoning!) /
    1_000_000
  );
}
