import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type {
  EvidenceCitation,
  HumanAdjudication,
} from './failure-attribution.js';

export function safeArtifactPath(root: string, relative: string): string {
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative.includes('\\') ||
    relative
      .split('/')
      .some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          part.toLowerCase().includes('holdout'),
      )
  )
    throw new Error('failure_review_artifact_path_invalid');
  let resolved = path.resolve(root);
  for (const part of relative.split('/')) {
    resolved = path.join(resolved, part);
    if (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink())
      throw new Error('failure_review_artifact_symlink');
  }
  return resolved;
}

export function readReviewArtifact(root: string, relative: string) {
  const file = safeArtifactPath(root, relative);
  if (!fs.existsSync(file))
    return { data: null, sha256: null, error: 'missing' };
  if (!fs.lstatSync(file).isFile())
    return { data: null, sha256: null, error: 'not_a_file' };
  const bytes = fs.readFileSync(file);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  try {
    const text = bytes.toString('utf8');
    const data = relative.endsWith('.jsonl')
      ? text
          .split('\n')
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line))
      : JSON.parse(text);
    return { data, sha256, error: null };
  } catch {
    return { data: null, sha256, error: 'invalid_json' };
  }
}

function resolvePointer(
  data: unknown,
  pointer: string,
): { found: boolean; value?: unknown } {
  if (!pointer.startsWith('/') || /~(?![01])/.test(pointer))
    return { found: false };
  let value = data;
  for (const component of pointer.slice(1).split('/')) {
    const key = component.replace(/~1/g, '/').replace(/~0/g, '~');
    if (
      !value ||
      typeof value !== 'object' ||
      !Object.hasOwn(value, key) ||
      (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(key))
    )
      return { found: false };
    value = (value as Record<string, unknown>)[key];
  }
  return { found: true, value };
}

export function verifyCitation(root: string, citation: EvidenceCitation) {
  if (
    !citation ||
    typeof citation.artifact !== 'string' ||
    typeof citation.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(citation.sha256) ||
    typeof citation.pointer !== 'string'
  )
    throw new Error('failure_review_citation_invalid');
  const artifact = readReviewArtifact(root, citation.artifact);
  const resolved = resolvePointer(artifact.data, citation.pointer);
  if (artifact.error || artifact.sha256 !== citation.sha256 || !resolved.found)
    throw new Error('failure_review_citation_unverified');
  return { document: artifact.data, value: resolved.value };
}

export function readAdjudications(
  root: string,
  relative: string,
  evidenceRevision: string,
  attempts: Array<{
    executionIndex: number;
    candidate: string;
    caseId: string;
  }>,
) {
  const artifact = readReviewArtifact(root, relative);
  const document = artifact.data as Record<string, any> | null;
  if (
    artifact.error ||
    document?.schemaVersion !== 1 ||
    !Array.isArray(document.reviews)
  )
    throw new Error('failure_review_adjudications_invalid');
  if (document.evidenceRevision !== evidenceRevision)
    throw new Error('failure_review_adjudications_stale');
  const decisions = new Map<number, HumanAdjudication>();
  const seen = new Set<number>();
  for (const row of document.reviews as Array<
    HumanAdjudication & { category: string | null }
  >) {
    if (!row || typeof row !== 'object')
      throw new Error('failure_review_adjudication_invalid');
    const attempt = attempts.find(
      (item) => item.executionIndex === row.executionIndex,
    );
    if (
      !attempt ||
      seen.has(row.executionIndex) ||
      attempt.candidate !== row.candidate ||
      attempt.caseId !== row.caseId
    )
      throw new Error('failure_review_adjudication_subject_mismatch');
    seen.add(row.executionIndex);
    if (row.category === null) {
      if (
        row.reviewer ||
        row.rationale ||
        !Array.isArray(row.evidence) ||
        row.evidence.length
      )
        throw new Error('failure_review_adjudication_incomplete');
      continue;
    }
    if (!Array.isArray(row.evidence) || !row.evidence.length)
      throw new Error('failure_review_adjudication_evidence_required');
    const ownPrefix = `promptfoo-${String(row.executionIndex).padStart(4, '0')}/`;
    let scopedJudgeEvidence = false;
    let scopedObservedEvidence = false;
    let scopedRubricEvidence = false;
    for (const citation of row.evidence) {
      const resolved = verifyCitation(root, citation);
      if (
        citation.artifact.startsWith('promptfoo-') &&
        !citation.artifact.startsWith(ownPrefix)
      )
        throw new Error('failure_review_citation_subject_mismatch');
      if (
        citation.artifact === 'cases.used.json' ||
        citation.artifact === 'summary.json'
      ) {
        const parts = citation.pointer.slice(1).split('/');
        const subject =
          citation.artifact === 'cases.used.json'
            ? resolved.document?.[parts[0]]
            : resolved.document?.results?.[parts[1]];
        if (
          citation.artifact === 'cases.used.json'
            ? subject?.id !== row.caseId
            : parts[0] !== 'results' ||
              subject?.executionIndex !== row.executionIndex ||
              subject?.candidate !== row.candidate ||
              subject?.caseId !== row.caseId
        )
          throw new Error('failure_review_citation_subject_mismatch');
        scopedRubricEvidence ||=
          citation.artifact === 'cases.used.json' && parts[1] === 'rubric';
      }
      if (
        citation.artifact.startsWith('judge/') &&
        resolved.value &&
        typeof resolved.value === 'object'
      ) {
        const subject = resolved.value as Record<string, unknown>;
        scopedJudgeEvidence ||=
          subject.executionIndex === row.executionIndex &&
          subject.caseId === row.caseId;
      }
      scopedObservedEvidence ||= [
        'trace.json',
        'fixture.jsonl',
        'fixture-state.json',
      ].some((name) => citation.artifact === ownPrefix + name);
    }
    if (row.category === 'judge_input_or_prompt_error' && !scopedJudgeEvidence)
      throw new Error('failure_review_judge_evidence_required');
    if (row.category === 'agent_error' && !scopedObservedEvidence)
      throw new Error('failure_review_agent_evidence_required');
    if (row.category === 'rubric_error' && !scopedRubricEvidence)
      throw new Error('failure_review_rubric_evidence_required');
    decisions.set(row.executionIndex, row as HumanAdjudication);
  }
  return { decisions, sha256: artifact.sha256 };
}

export function writeImmutableReview(file: string, content: string): void {
  if (fs.existsSync(file)) {
    if (
      fs.lstatSync(file).isSymbolicLink() ||
      fs.readFileSync(file, 'utf8') !== content
    )
      throw new Error('failure_review_immutable_conflict');
    return;
  }
  fs.writeFileSync(file, content, { flag: 'wx', mode: 0o600 });
}
