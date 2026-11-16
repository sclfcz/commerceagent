/**
 * Workspace Memory consolidation (phase D).
 *
 * Nightly, host-side, deterministic maintenance for Workspace Memory:
 * duplicates are merged into one keeper and expired items are demoted to
 * searchable history. Nothing is deleted, and every change is an ordinary item
 * revision with version, provenance, audit and outbox lineage.
 *
 * Entry points:
 * - `startMemoryConsolidationWorker` — the long-running loop wired into boot;
 * - `runMemoryConsolidation` — one pass, used by tests and manual triggers;
 * - `listConsolidationStates` — per-workspace last-run report for the monitor.
 */
export {
  DEFAULT_SIMILARITY_THRESHOLD,
  applyMergeGroup,
  isTrigramSimilarityAvailable,
  mergeDuplicateBatch,
  planDuplicateGroups,
  type DuplicateGroup,
  type DuplicateReason,
} from './dedupe.js';
export {
  DEMOTION_IMPORTANCE_CAP,
  DEMOTION_MARKER,
  demoteExpiredBatch,
  planDemotion,
} from './demote.js';
export {
  MEMORY_CONSOLIDATION_ACTOR_ID,
  MEMORY_CONSOLIDATION_SOURCE_TYPE,
} from './lineage.js';
export {
  acquireConsolidationLease,
  listConsolidationStates,
  recordConsolidationRun,
  releaseConsolidationLease,
  type ConsolidationRunStatus,
  type ConsolidationState,
} from './state.js';
export {
  CONSOLIDATION_POLL_INTERVAL_MS,
  consolidationCronExpression,
  isConsolidationDue,
  lastDueInstant,
  nextDueInstant,
  resolveConsolidationSettings,
  runMemoryConsolidation,
  runMemoryConsolidationOnDatabase,
  startMemoryConsolidationWorker,
  type ConsolidationRunReason,
  type ConsolidationRunSummary,
  type ConsolidationSettings,
  type MemoryConsolidationWorkerHandle,
  type WorkspaceConsolidationResult,
} from './worker.js';
