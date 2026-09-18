import fs from 'node:fs';

import type {
  WorkflowAgentSnapshot,
  WorkflowPhaseSnapshot,
  WorkflowRunSnapshot,
} from './stream-event.types.js';

function finite(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function unquote(value: string): string {
  return value.replace(/\\(['"`\\])/g, '$1');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function balancedEnd(
  source: string,
  start: number,
  open: string,
  close: string,
): number {
  let depth = 0;
  let quote: "'" | '"' | '`' | null = null;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function stringProperty(source: string, name: string): string | undefined {
  const match = source.match(
    new RegExp(
      `\\b${escapeRegExp(name)}\\s*:\\s*(['"\"])((?:\\\\.|(?!\\1).)*)\\1`,
    ),
  );
  return match?.[2] ? unquote(match[2]) : undefined;
}

function objectStringProperties(source: string): Record<string, string> {
  const values: Record<string, string> = {};
  const pattern = /\b([A-Za-z_$][\w$]*)\s*:\s*(['"])((?:\\.|(?!\2).)*)\2/g;
  for (const match of source.matchAll(pattern)) {
    values[match[1]] = unquote(match[3]);
  }
  return values;
}

function objectBodies(source: string): string[] {
  const bodies: string[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf('{', cursor);
    if (start < 0) break;
    const end = balancedEnd(source, start, '{', '}');
    if (end < 0) break;
    bodies.push(source.slice(start + 1, end));
    cursor = end + 1;
  }
  return bodies;
}

function phasePlan(script: string): WorkflowPhaseSnapshot[] {
  const property = /\bphases\s*:\s*\[/g.exec(script);
  if (!property) return [];
  const start = script.indexOf('[', property.index);
  const end = balancedEnd(script, start, '[', ']');
  if (end < 0) return [];
  const phases: WorkflowPhaseSnapshot[] = [];
  for (const body of objectBodies(script.slice(start + 1, end))) {
    const title = stringProperty(body, 'title');
    if (!title) continue;
    const detail = stringProperty(body, 'detail');
    phases.push({
      index: phases.length + 1,
      title,
      ...(detail ? { detail } : {}),
    });
  }
  return phases;
}

function arrayObjectPlans(
  script: string,
): Map<string, Array<Record<string, string>>> {
  const arrays = new Map<string, Array<Record<string, string>>>();
  const declaration = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\[/g;
  for (const match of script.matchAll(declaration)) {
    const start = script.indexOf('[', match.index ?? 0);
    const end = balancedEnd(script, start, '[', ']');
    if (end < 0) continue;
    const rows = objectBodies(script.slice(start + 1, end))
      .map(objectStringProperties)
      .filter((row) => Object.keys(row).length > 0);
    if (rows.length > 0) arrays.set(match[1], rows);
  }
  return arrays;
}

function expandMappedAgents(
  script: string,
  phaseIndexByTitle: Map<string, number>,
): WorkflowAgentSnapshot[] {
  const agents: WorkflowAgentSnapshot[] = [];
  for (const [arrayName, rows] of arrayObjectPlans(script)) {
    const mapPattern = new RegExp(
      `\\b${escapeRegExp(arrayName)}\\.map\\(\\s*(?:\\(\\s*)?([A-Za-z_$][\\w$]*)`,
      'g',
    );
    for (const match of script.matchAll(mapPattern)) {
      const mapStart = script.indexOf('(', match.index ?? 0);
      const mapEnd = balancedEnd(script, mapStart, '(', ')');
      if (mapEnd < 0) continue;
      const body = script.slice(mapStart + 1, mapEnd);
      const variable = match[1];
      const labelMatch = body.match(/\blabel\s*:\s*`((?:\\.|[^`])*)`/);
      if (!labelMatch?.[1] || !labelMatch[1].includes('${')) continue;
      const phaseTitle = stringProperty(body, 'phase');
      for (const row of rows) {
        let resolved = true;
        const label = unquote(labelMatch[1]).replace(
          new RegExp(
            `\\$\\{\\s*${escapeRegExp(variable)}\\.([A-Za-z_$][\\w$]*)\\s*\\}`,
            'g',
          ),
          (_placeholder, property: string) => {
            const value = row[property];
            if (!value) resolved = false;
            return value ?? '';
          },
        );
        if (!resolved || !label.trim() || label.includes('${')) continue;
        agents.push({
          index: agents.length + 1,
          label: label.trim(),
          phaseTitle,
          phaseIndex: phaseTitle
            ? phaseIndexByTitle.get(phaseTitle)
            : undefined,
          promptPreview: row.prompt,
          state: 'queued',
        });
      }
    }
  }
  return agents;
}

function literalAgents(
  script: string,
  phaseIndexByTitle: Map<string, number>,
): WorkflowAgentSnapshot[] {
  const agents: WorkflowAgentSnapshot[] = [];
  const callPattern = /\bagent\s*\(/g;
  for (const match of script.matchAll(callPattern)) {
    const start = script.indexOf('(', match.index ?? 0);
    const end = balancedEnd(script, start, '(', ')');
    if (end < 0) continue;
    const call = script.slice(start + 1, end);
    const labelMatch = call.match(/\blabel\s*:\s*(['"`])((?:\\.|(?!\1).)*)\1/);
    const label = labelMatch?.[2] ? unquote(labelMatch[2]).trim() : '';
    // A template expression is a plan, not a user-facing label. It is expanded
    // from the mapped array above or omitted until the SDK reports runtime data.
    if (!label || label.includes('${')) continue;
    const phaseTitle = stringProperty(call, 'phase');
    const prompt = call.match(/^\s*(['"])((?:\\.|(?!\1).)*)\1/)?.[2];
    agents.push({
      index: agents.length + 1,
      label,
      phaseTitle,
      phaseIndex: phaseTitle ? phaseIndexByTitle.get(phaseTitle) : undefined,
      promptPreview: prompt ? unquote(prompt) : undefined,
      state: 'queued',
    });
  }
  return agents;
}

/** Best-effort plan projection available before a Workflow starts running. */
export function workflowRunFromToolInput(
  taskId: string,
  input: Record<string, unknown>,
): WorkflowRunSnapshot {
  const script = stringValue(input.script) ?? '';
  const workflowName =
    stringValue(input.name) ??
    (unquote(
      script.match(/\bname\s*:\s*(['"`])((?:\\.|(?!\1).)*)\1/)?.[2] ?? '',
    ) ||
      undefined);
  const summary =
    unquote(
      script.match(/\bdescription\s*:\s*(['"`])((?:\\.|(?!\1).)*)\1/)?.[2] ??
        '',
    ) ||
    workflowName ||
    '动态工作流';

  const phases = phasePlan(script);
  const phaseIndexByTitle = new Map(
    phases.map((phase) => [phase.title, phase.index]),
  );
  const candidates = [
    ...expandMappedAgents(script, phaseIndexByTitle),
    ...literalAgents(script, phaseIndexByTitle),
  ];
  const seen = new Set<string>();
  const agents = candidates
    .filter((agent) => {
      const key = `${agent.phaseTitle ?? ''}\u0000${agent.label}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((agent, index) => ({ ...agent, index: index + 1 }));

  return {
    taskId,
    workflowName,
    summary,
    status: 'running',
    startTime: Date.now(),
    agentCount: agents.length || undefined,
    phases,
    agents,
  };
}

/** Merge the SDK's cumulative task_progress sample into the live plan. */
export function workflowRunFromTaskProgress(
  run: WorkflowRunSnapshot,
  input: {
    label?: string;
    summary?: string;
    usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number };
  },
): WorkflowRunSnapshot {
  const label = stringValue(input.label);
  const nextTotalTokens = finite(input.usage?.total_tokens);
  const previousTotalTokens = finite(run.totalTokens) ?? 0;
  const tokenDelta =
    nextTotalTokens !== undefined
      ? Math.max(0, nextTotalTokens - previousTotalTokens)
      : 0;
  let agents = run.agents.map((agent) => ({ ...agent }));
  if (label) {
    const existingIndex = agents.findIndex((agent) => agent.label === label);
    if (existingIndex >= 0) {
      const existing = agents[existingIndex];
      agents[existingIndex] = {
        ...existing,
        state: 'done',
        tokens: tokenDelta > 0 ? tokenDelta : existing.tokens,
        completedAt: existing.completedAt ?? Date.now(),
        lastToolSummary:
          input.summary && input.summary !== run.summary
            ? input.summary
            : existing.lastToolSummary,
      };
    } else {
      const currentPhase = run.phases.find((phase) => {
        const phaseAgents = agents.filter(
          (agent) =>
            agent.phaseIndex === phase.index ||
            agent.phaseTitle === phase.title,
        );
        return (
          phaseAgents.length === 0 ||
          phaseAgents.some((agent) => agent.state !== 'done')
        );
      });
      agents.push({
        index: agents.length + 1,
        label,
        phaseIndex: currentPhase?.index,
        phaseTitle: currentPhase?.title,
        state: 'done',
        completedAt: Date.now(),
        tokens: tokenDelta > 0 ? tokenDelta : undefined,
        lastToolSummary:
          input.summary && input.summary !== run.summary
            ? input.summary
            : undefined,
      });
    }
  }
  return {
    ...run,
    status: 'running',
    agentCount: Math.max(run.agentCount ?? 0, agents.length) || undefined,
    totalTokens: nextTotalTokens ?? run.totalTokens,
    totalToolCalls: finite(input.usage?.tool_uses) ?? run.totalToolCalls,
    durationMs: finite(input.usage?.duration_ms) ?? run.durationMs,
    agents,
  };
}

function normalizeAgentState(value: unknown): WorkflowAgentSnapshot['state'] {
  if (value === 'completed') return 'done';
  if (
    value === 'queued' ||
    value === 'running' ||
    value === 'done' ||
    value === 'failed' ||
    value === 'stopped'
  )
    return value;
  return 'unknown';
}

/** Read the SDK-owned task output, which is the authoritative completed view. */
export function workflowRunFromOutputFile(input: {
  taskId: string;
  outputFile?: string;
  status: string;
  summary?: string;
  workflowName?: string;
  usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number };
}): WorkflowRunSnapshot | undefined {
  if (!input.outputFile) return undefined;
  try {
    const stat = fs.statSync(input.outputFile);
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024) return undefined;
    const raw = JSON.parse(fs.readFileSync(input.outputFile, 'utf8')) as Record<
      string,
      unknown
    >;
    const progress = Array.isArray(raw.workflowProgress)
      ? (raw.workflowProgress as Array<Record<string, unknown>>)
      : [];
    if (progress.length === 0 && !finite(raw.agentCount)) return undefined;

    const phases = progress
      .filter((item) => item.type === 'workflow_phase')
      .map((item, offset) => ({
        index: finite(item.index) ?? offset + 1,
        title: stringValue(item.title) ?? `阶段 ${offset + 1}`,
        detail: stringValue(item.detail),
      }));
    const agents = progress
      .filter((item) => item.type === 'workflow_agent')
      .map(
        (item, offset): WorkflowAgentSnapshot => ({
          index: finite(item.index) ?? offset + 1,
          label: stringValue(item.label) ?? `Agent ${offset + 1}`,
          phaseIndex: finite(item.phaseIndex),
          phaseTitle: stringValue(item.phaseTitle),
          agentId: stringValue(item.agentId),
          model: stringValue(item.model),
          fallbackModel: stringValue(item.fallbackModel),
          state: normalizeAgentState(item.state),
          queuedAt: finite(item.queuedAt),
          startedAt: finite(item.startedAt),
          completedAt: finite(item.completedAt),
          attempt: finite(item.attempt),
          lastToolName: stringValue(item.lastToolName),
          lastToolSummary: stringValue(item.lastToolSummary),
          promptPreview: stringValue(item.promptPreview),
          resultPreview: stringValue(item.resultPreview),
          tokens: finite(item.tokens),
          toolCalls: finite(item.toolCalls),
          durationMs: finite(item.durationMs),
        }),
      );
    const status: WorkflowRunSnapshot['status'] =
      input.status === 'completed'
        ? 'completed'
        : input.status === 'failed'
          ? 'failed'
          : input.status === 'stopped'
            ? 'stopped'
            : 'unknown';
    return {
      taskId: input.taskId,
      runId: stringValue(raw.runId),
      workflowName: stringValue(raw.workflowName) ?? input.workflowName,
      summary:
        stringValue(raw.summary) ??
        input.summary ??
        input.workflowName ??
        '动态工作流',
      status,
      startTime: finite(raw.startTime),
      completedAt: Date.now(),
      durationMs: finite(raw.durationMs) ?? finite(input.usage?.duration_ms),
      agentCount: finite(raw.agentCount) ?? (agents.length || undefined),
      totalTokens: finite(raw.totalTokens) ?? finite(input.usage?.total_tokens),
      totalToolCalls:
        finite(raw.totalToolCalls) ?? finite(input.usage?.tool_uses),
      phases,
      agents,
    };
  } catch {
    return undefined;
  }
}
