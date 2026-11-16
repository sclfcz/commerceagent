import fs from 'node:fs';
import path from 'node:path';

import { getSystemSettings } from '../runtime-config.js';

/**
 * Post-session extraction settings.
 *
 * The idle threshold is a separate, deliberately shorter setting than
 * `IDLE_TIMEOUT`: `IDLE_TIMEOUT` decides when a warm runner is reclaimed (30
 * minutes by default), while extraction should react to a conversation that
 * has clearly paused without waiting for the runner to disappear. The default
 * therefore mirrors a short "user stepped away" pause, and the setting is
 * clamped to the same one-minute..one-day range as the other timers.
 */
export const MEMORY_EXTRACTION_DEFAULT_IDLE_MS = 15 * 60 * 1000;
export const MEMORY_EXTRACTION_MIN_IDLE_MS = 60 * 1000;
export const MEMORY_EXTRACTION_MAX_IDLE_MS = 24 * 60 * 60 * 1000;

/** Candidates nobody confirms within this window are retired (superseded). */
export const MEMORY_EXTRACTION_CANDIDATE_TTL_DAYS = 14;

/** Upper bound per extraction run; the model prompt asks for at most this many. */
export const MEMORY_EXTRACTION_MAX_CANDIDATES = 5;

/** Lessons below this confidence are dropped even if the model emitted them. */
export const MEMORY_EXTRACTION_LESSON_MIN_CONFIDENCE = 0.7;

/** Message window handed to the model in one run. */
export const MEMORY_EXTRACTION_MAX_WINDOW_MESSAGES = 120;
export const MEMORY_EXTRACTION_MAX_INPUT_CHARS = 24_000;
export const MEMORY_EXTRACTION_MAX_CONTENT_CHARS = 2000;
export const MEMORY_EXTRACTION_MAX_TITLE_CHARS = 160;
export const MEMORY_EXTRACTION_MAX_APPLIES_WHEN_CHARS = 400;

/** Give up on a session after this many consecutive transport failures. */
export const MEMORY_EXTRACTION_MAX_ATTEMPTS = 3;
export const MEMORY_EXTRACTION_RETRY_BACKOFF_MS = 30 * 60 * 1000;

/** Sweep cadence for the host-side idle check and candidate expiry. */
export const MEMORY_EXTRACTION_SWEEP_INTERVAL_MS = 60 * 1000;
export const MEMORY_EXTRACTION_SWEEP_START_DELAY_MS = 30 * 1000;

export interface MemoryExtractionSettings {
  enabled: boolean;
  idleMs: number;
  ttlDays: number;
  maxCandidates: number;
  lessonMinConfidence: number;
}

export function resolveMemoryExtractionSettings(): MemoryExtractionSettings {
  const settings = getSystemSettings();
  return {
    enabled: settings.memoryExtractionEnabled,
    idleMs: settings.memoryExtractionIdleMs,
    ttlDays: MEMORY_EXTRACTION_CANDIDATE_TTL_DAYS,
    maxCandidates: MEMORY_EXTRACTION_MAX_CANDIDATES,
    lessonMinConfidence: MEMORY_EXTRACTION_LESSON_MIN_CONFIDENCE,
  };
}

const PROMPT_FILE = 'memory-extraction.md';

/**
 * The prompt lives next to the runtime prompts so operators can tune it with
 * the rest of the agent prompt set. It is resolved from the project root, the
 * same convention `container-runner` uses for its prompt mount.
 */
export function loadMemoryExtractionPrompt(): string {
  const file = path.join(
    process.cwd(),
    'container',
    'agent-runner',
    'prompts',
    PROMPT_FILE,
  );
  return fs.readFileSync(file, 'utf8');
}
