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

export function aggregatePromptfooCosts(
  pricing: {
    effective_date?: string;
    currency?: string;
    candidates?: Record<string, Partial<CandidatePrice>>;
  },
  results: Array<Record<string, any>>,
) {
  const aliases = [
    ...new Set(
      results
        .map((result) => result.response?.metadata?.candidate)
        .filter((alias): alias is string => typeof alias === 'string'),
    ),
  ].sort();
  return Object.fromEntries(
    aliases.map((alias) => {
      const rows = results.filter(
        (result) => result.response?.metadata?.candidate === alias,
      );
      const costs = rows.map((result) => result.response.metadata.cost);
      const known =
        costs.length > 0 &&
        costs.every(
          (cost) => typeof cost === 'number' && Number.isFinite(cost),
        );
      return [
        alias,
        {
          attempts: rows.length,
          currency: pricing.currency ?? null,
          effectiveDate: pricing.effective_date ?? null,
          source: pricing.candidates?.[alias]?.source ?? null,
          totalCost: known
            ? costs.reduce((total, cost) => total + cost, 0)
            : null,
          known,
        },
      ];
    }),
  );
}
