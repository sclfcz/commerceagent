import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calibrationScorePairs, JUDGE_DIMENSIONS } from '../lib/judge.js';
import { hash, privateJson } from '../lib/contracts.js';
import { validatePublicSummary } from '../lib/public-report.js';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const benchmarkDirectory = path.join(repository, 'benchmarks');

interface JudgeReport {
  runId: string;
  calibrationMode?: string;
  executionId?: string;
  judgeProvenance?: Record<string, unknown>;
  sourceHash?: string;
  samples: Array<{
    sampleId: string;
    category: string;
    question: string;
    expectedStatus: string;
    expectedFacts: Record<string, unknown>;
    requiredEvidence?: string[];
    expectedEvidence?: string[];
    allowedEvidence?: string[];
    toolReturns?: Array<Record<string, unknown>>;
    rubric: string[];
    candidateOutput: string;
  }>;
  evaluations: Array<{
    sampleId: string;
    dimensions: Record<
      string,
      {
        scoreOutOfFive: number | null;
        pass: boolean;
        graderError?: boolean;
        reason: string | null;
      }
    >;
  }>;
}

function jsonlRead(file: string) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function jsonlWrite(file: string, rows: unknown[]) {
  fs.writeFileSync(
    file,
    rows.map((row) => JSON.stringify(row)).join('\n') + '\n',
    {
      mode: 0o600,
      flag: 'wx',
    },
  );
}

export function buildHumanLabelTemplate(report: JudgeReport) {
  return report.samples.map((sample) => ({
    sampleId: sample.sampleId,
    category: sample.category,
    question: sample.question,
    expectedStatus: sample.expectedStatus,
    expectedFacts: sample.expectedFacts,
    requiredEvidence: sample.requiredEvidence ?? [],
    allowedEvidence: sample.allowedEvidence ?? sample.expectedEvidence ?? [],
    toolReturns: sample.toolReturns ?? [],
    rubric: sample.rubric,
    candidateOutput: sample.candidateOutput,
    humanScores: Object.fromEntries(
      JUDGE_DIMENSIONS.map((dimension) => [dimension, null]),
    ),
    humanNotes: '',
  }));
}

export function analyzeHumanLabels(
  report: JudgeReport,
  labels: Array<{
    sampleId: string;
    humanScores: Record<string, unknown>;
    annotationProvenance?: {
      method?: string;
      displayLabel?: string;
      humanReviewedAll?: boolean;
      confirmationSource?: string;
      draftingModel?: string | null;
      judgeScoresDisclosedByAssistantBeforeConfirmation?: boolean;
    };
  }>,
  graderErrors: Partial<Record<(typeof JUDGE_DIMENSIONS)[number], number>> = {},
  judgeResultsHash: string | null = null,
) {
  const expectedIds = new Set(report.samples.map((sample) => sample.sampleId));
  if (
    expectedIds.size !== report.samples.length ||
    new Set(labels.map((label) => label.sampleId)).size !== labels.length ||
    labels.length !== expectedIds.size ||
    labels.some((label) => !expectedIds.has(label.sampleId))
  )
    throw new Error('calibration_sample_set_invalid');
  if (
    new Set(report.evaluations.map((row) => row.sampleId)).size !==
    report.evaluations.length
  )
    throw new Error('judge_sample_set_invalid');
  const judgeById = new Map(
    report.evaluations.map((evaluation) => [evaluation.sampleId, evaluation]),
  );
  const rows = labels.map((label) => {
    const judge = judgeById.get(label.sampleId);
    if (!judge) throw new Error('calibration_sample_id_invalid');
    const humanScores = Object.fromEntries(
      JUDGE_DIMENSIONS.map((dimension) => {
        const score = label.humanScores?.[dimension];
        if (!Number.isInteger(score) || Number(score) < 1 || Number(score) > 5)
          throw new Error('calibration_score_invalid');
        return [dimension, Number(score)];
      }),
    );
    const judgeScores = Object.fromEntries(
      JUDGE_DIMENSIONS.flatMap((dimension) => {
        const score = judge.dimensions[dimension]?.scoreOutOfFive;
        return Number.isInteger(score) &&
          Number(score) >= 1 &&
          Number(score) <= 5
          ? [[dimension, Number(score)]]
          : [];
      }),
    );
    return { sampleId: label.sampleId, judgeScores, humanScores };
  });
  const metrics = calibrationScorePairs(rows);
  const aiAssistedSamples = labels.filter(
    (label) => label.annotationProvenance?.method === 'ai_assisted_human',
  ).length;
  const methods = [
    ...new Set(
      labels.map(
        (label) => label.annotationProvenance?.method ?? 'unspecified',
      ),
    ),
  ];
  const annotationProvenance = {
    method: methods.length === 1 ? methods[0] : 'mixed',
    displayLabel:
      aiAssistedSamples === labels.length
        ? 'AI 辅助人工标注'
        : methods.join(', '),
    aiAssistedSamples,
    humanReviewedSamples: labels.filter(
      (label) => label.annotationProvenance?.humanReviewedAll === true,
    ).length,
    declaredSources: [
      ...new Set(
        labels.map(
          (label) =>
            label.annotationProvenance?.confirmationSource ?? 'unspecified',
        ),
      ),
    ],
    humanReviewBasis: 'user_declaration',
    draftingModels: [
      ...new Set(
        labels.map(
          (label) => label.annotationProvenance?.draftingModel ?? null,
        ),
      ),
    ],
    judgeScoresDisclosedByAssistantBeforeConfirmation: labels.some(
      (label) =>
        label.annotationProvenance
          ?.judgeScoresDisclosedByAssistantBeforeConfirmation === true,
    ),
    independenceLimitation:
      aiAssistedSamples > 0
        ? 'AI 草拟后由用户逐条复核确认；不等于完全独立的人类从零标注，可能存在相关偏差。'
        : '标注独立性仅依据提供的来源声明，未作外部核验。',
  };
  const criticalDimensions = [
    'completeness',
    'grounding',
    'decision_appropriateness',
  ] as const;
  const humanLowScoreCounts = Object.fromEntries(
    JUDGE_DIMENSIONS.map((dimension) => [
      dimension,
      rows.filter((row) => row.humanScores[dimension]! <= 3).length,
    ]),
  );
  const dimensionGates = Object.fromEntries(
    criticalDimensions.map((dimension) => {
      const metric = metrics.byDimension[dimension];
      const exactAgreement = metric.ordinal.exactAgreement;
      const weightedKappa = metric.ordinal.quadraticWeightedKappa;
      const concentrationInsufficient = metric.insufficientVariation;
      const enoughSamples = metric.ordinal.n >= 20;
      const enoughLowScores = humanLowScoreCounts[dimension] >= 3;
      const informationInsufficient =
        concentrationInsufficient || !enoughSamples || !enoughLowScores;
      const passed =
        !informationInsufficient &&
        exactAgreement !== null &&
        exactAgreement >= 0.6 &&
        weightedKappa !== null &&
        weightedKappa >= 0.6;
      const status = concentrationInsufficient
        ? 'insufficient_score_variation'
        : !enoughSamples
          ? 'insufficient_valid_samples'
          : !enoughLowScores
            ? 'insufficient_low_score_examples'
            : passed
              ? 'passed'
              : 'below_threshold';
      return [
        dimension,
        {
          sampleCount: metric.n,
          minimumSamples: 20,
          humanScoresAtOrBelow3: humanLowScoreCounts[dimension],
          minimumHumanScoresAtOrBelow3: 3,
          sampleInformationSufficient: !informationInsufficient,
          scoreConcentration: metric.scoreConcentration,
          exactAgreement,
          minimumExactAgreement: 0.6,
          quadraticWeightedKappa: weightedKappa,
          minimumQuadraticWeightedKappa: 0.6,
          status,
          passed,
        },
      ];
    }),
  );
  const judgeScoreCompleteness = Object.fromEntries(
    JUDGE_DIMENSIONS.map((dimension) => {
      const scored = metrics.byDimension[dimension].ordinal.n;
      return [
        dimension,
        {
          expected: rows.length,
          scored,
          missing: rows.length - scored,
          graderErrors: graderErrors[dimension] ?? 0,
        },
      ];
    }),
  );
  const sampleInformationSufficient =
    Object.values(dimensionGates).every(
      (gate) => gate.sampleInformationSufficient,
    ) && metrics.sampleInformationSufficient;
  return {
    schemaVersion: 2,
    runId: report.runId,
    annotatedSamples: rows.length,
    minimumRecommendedSamples: 20,
    calibrationStatus: sampleInformationSufficient
      ? Object.values(dimensionGates).every((gate) => gate.passed)
        ? 'passed'
        : 'below_threshold'
      : 'insufficient_sample_information',
    sampleInformation: {
      sufficient: sampleInformationSufficient,
      concentrationThreshold: 0.9,
      insufficientVariationDimensions: metrics.insufficientVariationDimensions,
      lowScoreInsufficientDimensions: criticalDimensions.filter(
        (dimension) => humanLowScoreCounts[dimension] < 3,
      ),
      humanScoresAtOrBelow3: humanLowScoreCounts,
      requiredHumanScoresAtOrBelow3PerCriticalDimension: 3,
    },
    calibrationGate: {
      criticalDimensions: [...criticalDimensions],
      perDimension: dimensionGates,
      professional_tone: 'reference_only',
      minimumSamplesPerCriticalDimension: 20,
      minimumHumanScoresAtOrBelow3PerCriticalDimension: 3,
      minimumExactAgreement: 0.6,
      minimumQuadraticWeightedKappa: 0.6,
    },
    judgeScoreCompleteness,
    annotationProvenance,
    calibrationCodeHash: hash([
      fs.readFileSync(fileURLToPath(import.meta.url), 'utf8'),
      fs.readFileSync(new URL('../lib/judge.ts', import.meta.url), 'utf8'),
    ]),
    calibratedScope: {
      executionId: report.executionId ?? null,
      judgeProvenance: report.judgeProvenance ?? null,
      sourceHash: report.sourceHash ?? null,
      judgeReportHash: hash(report),
      humanLabelsHash: hash(labels),
      judgeResultsHash,
      limitation:
        'Pilot calibration of these sampled dev answers only; not evidence of stable gateway routing, future Judge versions or general accuracy.',
    },
    judgeEligibleForRanking: Object.values(dimensionGates).every(
      (gate) => gate.passed,
    ),
    metrics,
  };
}

export function renderCalibrationSummary(
  result: ReturnType<typeof analyzeHumanLabels>,
) {
  const rate = (value: number | null) =>
    value === null ? '不可定义' : `${(value * 100).toFixed(1)}%`;
  const kappa = (value: number | null) =>
    value === null ? '不可定义' : value.toFixed(3);
  const overall = result.metrics.overall;
  const labels: Record<string, string> = {
    completeness: '完整度',
    grounding: '事实依据',
    decision_appropriateness: '决策恰当性',
    professional_tone: '专业语气',
  };
  const lines = [
    '# Judge 校准汇总',
    '',
    `执行编号：${result.calibratedScope.executionId ?? result.runId}。盲标样本 ${result.annotatedSamples} 条；无效或缺失的 Judge 评分保持缺失，不按 0 分替代。`,
    '',
    `标注方式：${result.annotationProvenance.aiAssistedSamples ? 'AI 辅助人工标注（用户声明逐条复核确认）' : '用户确认标注，来源见私有报告'}。`,
    '',
    `整体二分指标只统计四项均有有效评分的 ${overall.n} 条样本。整体一致率 ${rate(overall.agreement)}，二分 κ=${kappa(overall.kappa)}；误通过 ${overall.falsePasses} 条，误拒绝 ${overall.falseRejects} 条。相对标注的误通过率 ${rate(overall.falsePassRate)}，误拒绝率 ${rate(overall.falseRejectRate)}。`,
    '',
    `校准门槛：完整度、事实依据、决策恰当性分别要求至少 20 条、每项至少 3 条人工评分 ≤3、1–5 分完全一致率 ≥60%、二次加权 κ ≥0.6；专业语气只作参考。任一方在某维度 ≥90% 集中于同一分数时，该维度标为样本信息不足，κ 不报告。结果：${result.calibrationStatus === 'insufficient_sample_information' ? '样本分布不足以判断 Judge 能力；Judge 仅作参考，不进入排名' : result.judgeEligibleForRanking ? '达到数值门槛，仍受以下范围限制' : '至少一个关键维度未达到门槛，Judge 仅供参考，不进入排名'}。`,
    '',
    '| 维度 | 有效评分数 | 人工/ Judge 最大同分占比 | 样本信息 | 1–5 分完全一致率 | 二分一致率 | 二分 κ | 二次加权 κ |',
    '|---|---:|---:|---|---:|---:|---:|---:|',
    ...Object.entries(result.metrics.byDimension).map(([key, metric]) => {
      const gate = result.calibrationGate.perDimension[key];
      const concentration = `${rate(metric.scoreConcentration.human)} / ${rate(metric.scoreConcentration.judge)}`;
      const status =
        key === 'professional_tone'
          ? metric.insufficientVariation
            ? '信息不足，仅供参考'
            : '仅作参考'
          : gate?.status?.startsWith('insufficient')
            ? '信息不足，不报告 κ'
            : gate?.status === 'insufficient_valid_samples'
              ? '有效样本不足'
              : gate?.passed
                ? '可判定'
                : '可判定但未过门槛';
      return `| ${labels[key]} | ${metric.ordinal.n}/${result.annotatedSamples} | ${concentration} | ${status} | ${rate(metric.ordinal.exactAgreement)} | ${rate(metric.agreement)} | ${kappa(metric.kappa)} | ${kappa(metric.ordinal.quadraticWeightedKappa)} |`;
    }),
    '',
    '二分通过为 ≥4 分；二次加权使用分歧权重 (评分差)^2/16。任一方某维度的最大评分占比达到 90% 时，该维度样本信息不足，报告保留评分分布和原始一致率，但将所有 κ 标为不可判定，不把公式值 0 解读为判断差。',
    '',
    '| 维度 | 评审器评分分布 1/2/3/4/5 | 标注评分分布 1/2/3/4/5 |',
    '|---|---|---|',
    ...Object.entries(result.metrics.byDimension).map(
      ([key, metric]) =>
        `| ${labels[key]} | ${metric.ordinal.judgeCounts.join('/')} | ${metric.ordinal.humanCounts.join('/')} |`,
    ),
    '',
    `关键维度状态：${Object.entries(result.calibrationGate.perDimension)
      .map(
        ([key, gate]) =>
          `${labels[key]} ${gate.status.startsWith('insufficient') ? `样本信息不足（≤3 分 ${gate.humanScoresAtOrBelow3}/3）` : gate.passed ? '通过' : '未通过'}（完全一致率 ${rate(gate.exactAgreement)}，加权 κ ${kappa(gate.quadraticWeightedKappa)}）`,
      )
      .join('；')}。`,
    `评分完整性：${
      Object.entries(result.judgeScoreCompleteness)
        .filter(([, counts]) => counts.missing > 0)
        .map(
          ([key, counts]) =>
            `${labels[key]} 缺失 ${counts.missing} 项（Judge 错误 ${counts.graderErrors} 项）`,
        )
        .join('；') || '四个维度评分均完整'
    }。`,
    result.annotationProvenance.aiAssistedSamples
      ? '本批是 AI 辅助人工标注：AI 草拟后由用户逐条复核，不等于完全独立的人类从零标注，可能存在相关偏差。'
      : '本批标注方式为人工盲标；来源声明见私有报告。',
    '',
    '评审器走聚合网关，上游模型版本未核验。结论仅适用于本次样本、rubric/源码版本和请求路径，不外推到未来网关版本或其他任务。确定性业务断言与 Judge 分数分开；未运行 holdout 或阶段 6。',
    '',
  ];
  return lines.join('\n');
}

export function calibrate(runDirectory: string) {
  const judgeRoot = path.join(path.resolve(runDirectory), 'judge');
  const latestFile = path.join(judgeRoot, 'latest-completed.json');
  const latest = fs.existsSync(latestFile)
    ? JSON.parse(fs.readFileSync(latestFile, 'utf8'))
    : null;
  const judgeDirectory = latest
    ? path.dirname(path.resolve(judgeRoot, latest.reportPath))
    : judgeRoot;
  if (
    latest &&
    !judgeDirectory.startsWith(path.join(judgeRoot, 'executions') + path.sep)
  )
    throw new Error('judge_report_path_invalid');
  const reportFile = path.join(judgeDirectory, 'report.private.json');
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8')) as JudgeReport;
  if (latest && hash(report) !== latest.reportHash)
    throw new Error('judge_report_hash_mismatch');
  const labelFile = path.join(judgeDirectory, 'human-labels.jsonl');
  if (!fs.existsSync(labelFile)) {
    jsonlWrite(labelFile, buildHumanLabelTemplate(report));
    return {
      stage: 'human_labels_needed',
      samples: report.samples.length,
      file: path.relative(benchmarkDirectory, labelFile),
      candidateIdentityIncluded: false,
      judgeScoresIncluded: false,
    };
  }
  const labels = jsonlRead(labelFile);
  if (report.calibrationMode === 'manual_blind_fresh') {
    if (
      labels.some(
        (label: Record<string, any>) =>
          label.annotationProvenance?.method !== 'manual_blind',
      )
    )
      throw new Error('fresh_calibration_requires_manual_blind_labels');
  }
  if (labels.length !== report.samples.length)
    throw new Error('calibration_sample_count_mismatch');
  const rawResultsFile = path.join(judgeDirectory, 'results.json');
  const rawResults = JSON.parse(
    fs.readFileSync(rawResultsFile, 'utf8'),
  ) as Array<Record<string, any>>;
  const graderErrors: Partial<
    Record<(typeof JUDGE_DIMENSIONS)[number], number>
  > = {};
  for (const result of rawResults) {
    const assertions =
      result.gradingResult?.componentResults ?? result.assertionResults ?? [];
    for (const assertion of assertions) {
      if (assertion.metadata?.graderError !== true) continue;
      const metric = assertion.assertion?.metric ?? assertion.metric;
      const dimension =
        typeof metric === 'string' ? metric.replace(/^judge_/, '') : undefined;
      if (JUDGE_DIMENSIONS.includes(dimension as never))
        graderErrors[dimension as (typeof JUDGE_DIMENSIONS)[number]] =
          (graderErrors[dimension as (typeof JUDGE_DIMENSIONS)[number]] ?? 0) +
          1;
    }
  }
  const result = analyzeHumanLabels(
    report,
    labels,
    graderErrors,
    hash(rawResults),
  );
  const summaryFile = path.join(
    judgeDirectory,
    `calibration-summary.${hash(result).slice(0, 12)}.private.json`,
  );
  if (!fs.existsSync(summaryFile)) privateJson(summaryFile, result);
  const publicFile = summaryFile.replace('.private.json', '.public.md');
  const publicReport = renderCalibrationSummary(result);
  const candidatesFile = path.join(
    path.resolve(runDirectory),
    'candidates.json',
  );
  const candidates = fs.existsSync(candidatesFile)
    ? JSON.parse(fs.readFileSync(candidatesFile, 'utf8'))
    : [];
  if (
    typeof report.judgeProvenance?.requestedModel === 'string' &&
    typeof report.judgeProvenance?.apiBaseUrl === 'string'
  )
    candidates.push({
      alias: 'private-judge-identity',
      model: report.judgeProvenance.requestedModel,
      baseUrl: report.judgeProvenance.apiBaseUrl,
    });
  if (!validatePublicSummary(publicReport, candidates).valid)
    throw new Error('calibration_public_summary_leak');
  if (!fs.existsSync(publicFile))
    fs.writeFileSync(publicFile, publicReport, { mode: 0o600, flag: 'wx' });
  return {
    stage: 'calibration_complete',
    annotatedSamples: result.annotatedSamples,
    overallKappa: result.metrics.overall.kappa,
    overallAgreement: result.metrics.overall.agreement,
    annotationMethod: result.annotationProvenance.displayLabel,
    calibrationStatus: result.calibrationStatus,
    sampleInformation: result.sampleInformation,
    ordinalByDimension: Object.fromEntries(
      Object.entries(result.metrics.byDimension).map(([key, value]) => [
        key,
        value.ordinal,
      ]),
    ),
    judgeEligibleForRanking: result.judgeEligibleForRanking,
    dimensionGates: result.calibrationGate.perDimension,
    judgeScoreCompleteness: result.judgeScoreCompleteness,
    falsePasses: result.metrics.overall.falsePasses,
    falseRejects: result.metrics.overall.falseRejects,
    report: path.relative(path.resolve(runDirectory), summaryFile),
    publicReport: path.relative(path.resolve(runDirectory), publicFile),
  };
}

const runDirectory = process.argv[2];
if (
  runDirectory &&
  path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)
) {
  try {
    process.stdout.write(JSON.stringify(calibrate(runDirectory)) + '\n');
  } catch (error) {
    const code =
      error instanceof Error && /^[a-z0-9_:-]+$/i.test(error.message)
        ? error.message
        : 'calibration_failed';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
