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
  executionId?: string;
  judgeProvenance?: Record<string, unknown>;
  sourceHash?: string;
  samples: Array<{
    sampleId: string;
    category: string;
    question: string;
    expectedStatus: string;
    expectedFacts: Record<string, unknown>;
    expectedEvidence: string[];
    rubric: string[];
    candidateOutput: string;
  }>;
  evaluations: Array<{
    sampleId: string;
    dimensions: Record<
      string,
      { scoreOutOfFive: number | null; pass: boolean; reason: string | null }
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
    expectedEvidence: sample.expectedEvidence,
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
      JUDGE_DIMENSIONS.map((dimension) => {
        const score = judge.dimensions[dimension]?.scoreOutOfFive;
        if (!Number.isInteger(score) || Number(score) < 1 || Number(score) > 5)
          throw new Error('judge_score_missing');
        return [dimension, Number(score)];
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
  return {
    schemaVersion: 2,
    runId: report.runId,
    annotatedSamples: rows.length,
    minimumRecommendedSamples: 20,
    kappaThreshold: 0.6,
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
      limitation:
        'Pilot calibration of these sampled dev answers only; not evidence of stable gateway routing, future Judge versions or general accuracy.',
    },
    judgeEligibleForRanking:
      rows.length >= 20 && (metrics.overall.kappa ?? -1) >= 0.6,
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
    `执行编号：${result.calibratedScope.executionId ?? result.runId}。样本 ${result.annotatedSamples} 条，每条四项 1–5 分。`,
    '',
    `标注方式：${result.annotationProvenance.aiAssistedSamples ? 'AI 辅助人工标注（用户声明逐条复核确认）' : '用户确认标注，来源见私有报告'}。`,
    '',
    `整体通过要求四项均 ≥4 分。整体二分一致率 ${rate(overall.agreement)}，二分 κ=${kappa(overall.kappa)}；误通过 ${overall.falsePasses} 条，误拒绝 ${overall.falseRejects} 条。相对标注的误通过率 ${rate(overall.falsePassRate)}，误拒绝率 ${rate(overall.falseRejectRate)}。`,
    '',
    `校准门槛：至少 20 条，整体二分 κ≥0.6。结果：${result.judgeEligibleForRanking ? '达到数值门槛，仍受以下范围限制' : '未达到门槛，Judge 仅供参考，不进入排名'}。`,
    '',
    '| 维度 | 1–5 分完全一致率 | 二分通过一致率 | 二分 κ | 二次加权 κ |',
    '|---|---:|---:|---:|---:|',
    ...Object.entries(result.metrics.byDimension).map(
      ([key, metric]) =>
        `| ${labels[key]} | ${rate(metric.ordinal.exactAgreement)} | ${rate(metric.agreement)} | ${kappa(metric.kappa)} | ${kappa(metric.ordinal.quadraticWeightedKappa)} |`,
    ),
    '',
    '二分通过为 ≥4 分；二次加权使用分歧权重 (评分差)^2/16。标签高度集中时 κ 可能低或不可定义；不可定义不等于零，也不能用原始一致率替代门槛。',
    '',
    '| 维度 | 评审器评分分布 1/2/3/4/5 | 标注评分分布 1/2/3/4/5 |',
    '|---|---|---|',
    ...Object.entries(result.metrics.byDimension).map(
      ([key, metric]) =>
        `| ${labels[key]} | ${metric.ordinal.judgeCounts.join('/')} | ${metric.ordinal.humanCounts.join('/')} |`,
    ),
    '',
    '本批是 20 条 dev 小样本校准。AI 辅助草拟并经用户复核不等于完全独立的人类从零标注，可能存在相关偏差；误通过/误拒绝均以这些确认标注为参考。',
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
  if (labels.length !== report.samples.length)
    throw new Error('calibration_sample_count_mismatch');
  const result = analyzeHumanLabels(report, labels);
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
    ordinalByDimension: Object.fromEntries(
      Object.entries(result.metrics.byDimension).map(([key, value]) => [
        key,
        value.ordinal,
      ]),
    ),
    judgeEligibleForRanking: result.judgeEligibleForRanking,
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
