import fs from 'node:fs';
import crypto from 'node:crypto';
import { parse } from 'yaml';

export interface CandidatePrice {
  effective_date: string;
  currency: string;
  input: number | null;
  output: number | null;
  cache_read: number | null;
  cache_write: number | null;
  reasoning: number | null;
  source: string;
  model_fingerprint: string;
  billing_region: string;
}

export interface PricingIdentity {
  model: string;
  baseUrl: string;
  billingRegion?: string;
}

export function modelFingerprint(
  model: string,
  baseUrl: string,
): string | null {
  try {
    const origin = new URL(baseUrl).origin;
    return crypto
      .createHash('sha256')
      .update(`${model}|${origin}`, 'utf8')
      .digest('hex');
  } catch {
    return null;
  }
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
  identity: PricingIdentity | undefined,
): number | null {
  if (!usage || !price || !identity) return null;
  const fingerprint = modelFingerprint(identity.model, identity.baseUrl);
  if (
    !fingerprint ||
    price.model_fingerprint !== fingerprint ||
    !identity.billingRegion ||
    price.billing_region !== identity.billingRegion
  )
    return null;
  const ordinaryOutput = Math.max(
    0,
    usage.outputTokens - usage.reasoningTokens,
  );
  const requiredRates: Array<[keyof CandidatePrice, number]> = [
    ['input', usage.inputTokens],
    ['output', ordinaryOutput],
    ['cache_read', usage.cacheReadInputTokens],
    ['cache_write', usage.cacheCreationInputTokens],
    ['reasoning', usage.reasoningTokens],
  ];
  if (
    requiredRates.some(
      ([field, tokens]) =>
        tokens > 0 &&
        (typeof price[field] !== 'number' ||
          !Number.isFinite(price[field]) ||
          price[field]! < 0),
    )
  )
    return null;
  return (
    (usage.inputTokens * (price.input ?? 0) +
      ordinaryOutput * (price.output ?? 0) +
      usage.cacheReadInputTokens * (price.cache_read ?? 0) +
      usage.cacheCreationInputTokens * (price.cache_write ?? 0) +
      usage.reasoningTokens * (price.reasoning ?? 0)) /
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
          currency:
            pricing.candidates?.[alias]?.currency ?? pricing.currency ?? null,
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
