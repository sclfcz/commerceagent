export function validatePublicSummary(
  markdown: string,
  candidates: Array<{ model: string; baseUrl: string }>,
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
  const leaked = [...new Set(secrets)].filter((value) =>
    markdown.toLowerCase().includes(value.toLowerCase()),
  );
  return { valid: leaked.length === 0, leaked };
}

export function renderPublicSummary(input: {
  runId: string;
  metrics: {
    candidates: Record<string, any>;
    pairwise: Record<string, any>;
  };
  costs: Record<string, any>;
  privateCandidates: Array<{ alias: string; model: string; baseUrl: string }>;
}) {
  const aliases = Object.keys(input.metrics.candidates).sort();
  const publicAlias = new Map(
    aliases.map((_, index) => [aliases[index], `candidate-${index + 1}`]),
  );
  const lines = [
    `# Benchmark summary: ${input.runId}`,
    '',
    'Only quality-eligible attempts are included in pass rates. Candidates with more than 10% ineligible attempts are excluded from ranking. Latencies are cold starts.',
    '',
    '| Candidate | Ranking | Eligible / total | Ineligible | First pass | Average pass | Completion | Facts/evidence | Instruction | Tools | pass^3 passed / failed / undetermined | Total cost | Cost per successful task | elapsed p50 / p95 ms | logical p50 / p95 ms |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
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
      `| ${publicAlias.get(alias)} | ${metrics.rankEligible ? 'eligible' : 'excluded'} | ${metrics.eligibleAttempts}/${metrics.attempts} | ${rate(metrics.ineligibleRate)} | ${rate(metrics.firstPassRate)} | ${rate(metrics.averagePassRate)} | ${rate(metrics.dimensionPassRates.completion)} | ${rate(metrics.dimensionPassRates.facts_evidence)} | ${rate(metrics.dimensionPassRates.instruction)} | ${rate(metrics.dimensionPassRates.tools)} | ${metrics.pass3.passed} / ${metrics.pass3.failed} / ${metrics.pass3.undetermined} | ${totalCost} | ${successCost} | ${metrics.latency.elapsedMs.p50 ?? 'unknown'} / ${metrics.latency.elapsedMs.p95 ?? 'unknown'} | ${metrics.latency.logicalRunMs.p50 ?? 'unknown'} / ${metrics.latency.logicalRunMs.p95 ?? 'unknown'} |`,
    );
  }
  lines.push(
    '',
    '## Paired comparisons',
    '',
    'Differences use paired case bootstrap intervals (10,000 resamples); intervals containing zero indicate no observed significant difference.',
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
