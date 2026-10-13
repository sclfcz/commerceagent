import crypto from 'node:crypto';

export function validatePublicSummary(
  markdown: string,
  candidates: Array<{ alias: string; model: string; baseUrl: string }>,
) {
  const secrets = candidates.flatMap((candidate) => {
    const host = (() => {
      try {
        return new URL(candidate.baseUrl).host;
      } catch {
        return '';
      }
    })();
    return [candidate.model, candidate.baseUrl, host].filter(
      (value) => value.length >= 4,
    );
  });
  const aliasLeaks = candidates
    .map((candidate) => candidate.alias)
    .filter((alias) => {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(^|[^a-z0-9-])${escaped}(?=$|[^a-z0-9-])`, 'i').test(
        markdown,
      );
    });
  const sensitiveKeywords = [
    'qwen',
    'deepseek',
    'kimi',
    'glm',
    'claude',
    'gpt',
  ];
  const needles = [...new Set([...secrets, ...sensitiveKeywords])];
  const leaked = [
    ...needles.filter((value) =>
      markdown.toLowerCase().includes(value.toLowerCase()),
    ),
    ...aliasLeaks,
  ];
  return { valid: leaked.length === 0, leaked };
}

export function renderPublicSummary(input: {
  runId: string;
  metrics: {
    candidates: Record<string, any>;
    pairwise: Record<string, any>;
  };
  costs: Record<string, any>;
  split?: string | null;
  holdoutCumulativeRuns?: number;
  privateCandidates: Array<{ alias: string; model: string; baseUrl: string }>;
}) {
  const aliases = Object.keys(input.metrics.candidates).sort();
  const publicAlias = new Map(
    aliases.map((alias) => [
      alias,
      `candidate-${crypto
        .createHash('sha256')
        .update(`${input.runId}|${alias}`)
        .digest('hex')
        .slice(0, 10)}`,
    ]),
  );
  const lines = [
    `# Benchmark summary: ${input.runId}`,
    '',
    'Only quality-eligible attempts are included in pass rates. Candidates with more than 10% ineligible attempts are excluded from ranking. Latencies are cold starts.',
    'Costs are usage-based estimates under the declared rate assumptions; one cache-read mapping has not yet been checked against a platform invoice.',
    `Split: ${input.split ?? 'legacy'}; cumulative holdout runs: ${input.holdoutCumulativeRuns ?? 0}.`,
    '',
    '| Candidate | Ranking | Eligible / total | Ineligible | First pass | Average pass | Task completion | Status accuracy | Facts/evidence | Format | Injection safety | Instruction | Tools | pass^3 passed / failed / undetermined | Total cost | Cost per successful task | elapsed p50 / p95 ms | logical p50 / p95 ms |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const alias of aliases) {
    const metrics = input.metrics.candidates[alias];
    const cost = input.costs[alias];
    const rate = (value: number | null | undefined) =>
      typeof value !== 'number' ? 'unknown' : `${(value * 100).toFixed(1)}%`;
    const totalCost =
      cost.totalCost === null
        ? 'unknown'
        : `${cost.currency} ${cost.totalCost.toFixed(6)}`;
    const successCost =
      cost.costPerSuccessfulTask === null
        ? 'unknown'
        : `${cost.currency} ${cost.costPerSuccessfulTask.toFixed(6)}`;
    lines.push(
      `| ${publicAlias.get(alias)} | ${metrics.rankEligible ? 'eligible' : 'excluded'} | ${metrics.eligibleAttempts}/${metrics.attempts} | ${rate(metrics.ineligibleRate)} | ${rate(metrics.firstPassRate)} | ${rate(metrics.averagePassRate)} | ${rate(metrics.dimensionPassRates.completion)} | ${rate(metrics.dimensionPassRates.status_accuracy)} | ${rate(metrics.dimensionPassRates.facts_evidence)} | ${rate(metrics.dimensionPassRates.format)} | ${rate(metrics.dimensionPassRates.injection_safety)} | ${rate(metrics.dimensionPassRates.instruction)} | ${rate(metrics.dimensionPassRates.tools)} | ${metrics.pass3.passed} / ${metrics.pass3.failed} / ${metrics.pass3.undetermined} | ${totalCost} | ${successCost} | ${metrics.latency.elapsedMs.p50 ?? 'unknown'} / ${metrics.latency.elapsedMs.p95 ?? 'unknown'} | ${metrics.latency.logicalRunMs.p50 ?? 'unknown'} / ${metrics.latency.logicalRunMs.p95 ?? 'unknown'} |`,
    );
  }
  lines.push(
    '',
    '## Paired comparisons',
    '',
    'Differences use paired case bootstrap intervals (10,000 resamples, without multiple-comparison correction); intervals containing zero indicate no observed significant difference. Candidates excluded from ranking are omitted from paired comparisons.',
    '',
  );
  if (Object.keys(input.metrics.pairwise).length === 0)
    lines.push(
      'No paired comparisons: fewer than two ranking-eligible candidates with shared eligible cases.',
      '',
    );
  for (const [key, interval] of Object.entries(input.metrics.pairwise)) {
    const [left, right] = key.split('__vs__');
    const label = `${publicAlias.get(left)} vs ${publicAlias.get(right)}`;
    lines.push(
      `- ${label}: difference ${interval.difference === null ? 'unknown' : `${(interval.difference * 100).toFixed(1)} pp`}, 95% CI [${interval.lower95 === null ? 'unknown' : `${(interval.lower95 * 100).toFixed(1)} pp`}, ${interval.upper95 === null ? 'unknown' : `${(interval.upper95 * 100).toFixed(1)} pp`}], n=${interval.pairedCases} cases.`,
    );
  }
  const privateByAlias = new Map(
    input.privateCandidates.map((candidate) => [candidate.alias, candidate]),
  );
  const markdown = lines.join('\n') + '\n';
  return {
    markdown,
    aliasMap: Object.fromEntries(
      aliases.map((alias) => [
        alias,
        {
          publicAlias: publicAlias.get(alias),
          model: privateByAlias.get(alias)?.model ?? null,
          baseUrl: privateByAlias.get(alias)?.baseUrl ?? null,
        },
      ]),
    ),
  };
}
