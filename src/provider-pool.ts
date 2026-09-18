/**
 * Provider Pool — 多提供商负载均衡
 *
 * 支持三种策略：round-robin、weighted-round-robin、failover
 * 健康状态纯内存管理，配置由 runtime-config V4 注入（不再自行管理配置文件）
 */
import { logger } from './logger.js';
import type { BalancingConfig } from './runtime-config.js';

// ─── 类型定义 ──────────────────────────────────────────────

export interface ProviderPoolMember {
  profileId: string;
  weight: number;
  enabled: boolean;
}

/**
 * One quarantined (account, model) pair.
 *
 * Every OAuth account carries an independent quota per model tier: a rejected
 * Fable 5 budget on one account says nothing about that account's Opus budget,
 * nor about any other account's Fable budget. Tracking model walls separately
 * from account walls is what lets the pool drain the primary tier across every
 * account before any account escalates to the fallback tier.
 */
interface ModelQuarantine {
  since: number;
  until: number | null;
}

/**
 * A model tier to select within: one shared model name, or a per-account map
 * for the primary tier where each account has its own configured model. The
 * empty string selects without any tier constraint.
 */
export type ProviderTier = string | ReadonlyMap<string, string>;

/**
 * Stable identity for the model selected implicitly by the official SDK.
 *
 * Official OAuth providers are allowed to leave `anthropicModel` empty. An
 * empty tier means "ignore model quarantine" to the pool, so using the raw
 * config value would collapse a real model wall into an account wall. Keep a
 * distinct internal key while still leaving ANTHROPIC_MODEL unset at runtime.
 */
export const SDK_DEFAULT_MODEL_TIER = '__commerceagent_sdk_default_model__';

export function providerModelTier(model: string | null | undefined): string {
  return model?.trim() || SDK_DEFAULT_MODEL_TIER;
}

/**
 * Composite-key separator. NUL cannot occur in a profile id or a model name,
 * so the key is unambiguous — but it is invisible in editors and diffs, which
 * is exactly how the readers below once drifted to parsing a space. Encode and
 * decode through this constant and `modelKeyOwner()`; never re-derive it.
 */
const MODEL_KEY_SEP = '\u0000';

function modelKey(profileId: string, model: string): string {
  return `${profileId}${MODEL_KEY_SEP}${model.trim().toLowerCase()}`;
}

/** The profileId half of a model-quarantine key. */
function modelKeyOwner(key: string): string {
  const at = key.indexOf(MODEL_KEY_SEP);
  return at === -1 ? key : key.slice(0, at);
}

export interface ProviderHealthStatus {
  profileId: string;
  healthy: boolean;
  consecutiveErrors: number;
  lastErrorAt: number | null;
  lastSuccessAt: number | null;
  unhealthySince: number | null;
  /**
   * Upstream-reported end of the quarantine (epoch ms), taken from the SDK
   * `rate_limit_event.resetsAt`. An account-scope limit can last hours, so the
   * flat `recoveryIntervalMs` must not resurrect the provider before this.
   * Null means "no upstream signal — use the configured interval".
   */
  quarantinedUntil: number | null;
  activeSessionCount: number;
}

// ─── 常量 ──────────────────────────────────────────────────

const DEFAULT_UNHEALTHY_THRESHOLD = 3;
const DEFAULT_RECOVERY_INTERVAL_MS = 300_000; // 5 minutes
/** Upper bound for an upstream-reported quarantine window. */
const MAX_QUARANTINE_MS = 24 * 60 * 60 * 1000;

function makeHealthStatus(profileId: string): ProviderHealthStatus {
  return {
    profileId,
    healthy: true,
    consecutiveErrors: 0,
    lastErrorAt: null,
    lastSuccessAt: null,
    unhealthySince: null,
    quarantinedUntil: null,
    activeSessionCount: 0,
  };
}

/**
 * Upstream reset stamps arrive as epoch seconds on some Claude Code builds and
 * epoch milliseconds on others. Normalize to ms and reject values that are not
 * a usable future instant, so a malformed stamp degrades to the interval rule
 * instead of pinning a provider out of rotation forever.
 */
function normalizeResetStamp(
  resetsAt: number | null | undefined,
  now: number,
): number | null {
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) return null;
  const ms = resetsAt < 1e11 ? resetsAt * 1000 : resetsAt;
  if (ms <= now) return null;
  // Guard against absurd stamps (>24h) quarantining an account for days.
  return Math.min(ms, now + MAX_QUARANTINE_MS);
}

// ─── ProviderPool 类 ──────────────────────────────────────

export class ProviderPool {
  private members: ProviderPoolMember[] = [];
  private strategy: BalancingConfig['strategy'] = 'round-robin';
  private unhealthyThreshold = DEFAULT_UNHEALTHY_THRESHOLD;
  private recoveryIntervalMs = DEFAULT_RECOVERY_INTERVAL_MS;
  private healthMap: Map<string, ProviderHealthStatus> = new Map();
  private modelQuarantine: Map<string, ModelQuarantine> = new Map();
  private roundRobinIndex = 0;

  /** True when the strategy rotates on every request rather than on failure. */
  get rotatesPerRequest(): boolean {
    return this.strategy !== 'failover';
  }

  /**
   * Refresh internal state from V4 provider config.
   * Called by container-runner before selection, and by routes after config changes.
   */
  refreshFromConfig(
    providers: Array<{ id: string; enabled: boolean; weight: number }>,
    balancing: BalancingConfig,
  ): void {
    this.members = providers.map((p) => ({
      profileId: p.id,
      weight: Math.max(1, Math.min(100, p.weight || 1)),
      enabled: p.enabled,
    }));
    this.strategy = balancing.strategy;
    this.unhealthyThreshold = balancing.unhealthyThreshold;
    this.recoveryIntervalMs = balancing.recoveryIntervalMs;

    // Clean up health entries for removed members
    const memberIds = new Set(this.members.map((m) => m.profileId));
    for (const key of this.healthMap.keys()) {
      if (!memberIds.has(key)) this.healthMap.delete(key);
    }
    for (const key of this.modelQuarantine.keys()) {
      if (!memberIds.has(modelKeyOwner(key))) {
        this.modelQuarantine.delete(key);
      }
    }
  }

  // ─── 模型档位隔离 ────────────────────────────────────────

  /**
   * Quarantine one (account, model) pair after a model-scope rejection. The
   * account itself stays healthy: its other tiers, and every other account's
   * budget for this same model, are untouched.
   */
  reportModelFailure(
    profileId: string,
    model: string,
    quarantineUntil?: number | null,
  ): void {
    const trimmed = model.trim();
    if (!trimmed) return;
    const now = Date.now();
    const until = normalizeResetStamp(quarantineUntil, now);
    this.modelQuarantine.set(modelKey(profileId, trimmed), {
      since: now,
      until,
    });
    logger.warn(
      {
        profileId,
        model: trimmed,
        quarantinedUntil: until ? new Date(until).toISOString() : null,
      },
      'Model tier quarantined for this account',
    );
  }

  isModelQuarantined(
    profileId: string,
    model: string,
    now = Date.now(),
  ): boolean {
    const trimmed = model.trim();
    if (!trimmed) return false;
    const key = modelKey(profileId, trimmed);
    const entry = this.modelQuarantine.get(key);
    if (!entry) return false;
    const recoverAt = entry.until ?? entry.since + this.recoveryIntervalMs;
    if (now >= recoverAt) {
      this.modelQuarantine.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Enabled members that are account-healthy and not quarantined for the tier.
   *
   * A tier is either one shared model name (the system fallback tier) or a
   * per-account map (the primary tier, where each account carries its own
   * configured model). An empty tier ignores the model dimension entirely.
   */
  private candidatesForTier(
    tier: ProviderTier,
    now: number,
  ): ProviderPoolMember[] {
    return this.members.filter((m) => {
      if (!m.enabled) return false;
      const health = this.healthMap.get(m.profileId);
      if (health && !health.healthy) return false;
      const model =
        typeof tier === 'string' ? tier : (tier.get(m.profileId) ?? '');
      return !model || !this.isModelQuarantined(m.profileId, model, now);
    });
  }

  /** Whether any enabled, account-healthy member can still serve the tier. */
  hasCandidateForTier(tier: ProviderTier): boolean {
    this.refreshRecoveryState();
    return this.candidatesForTier(tier, Date.now()).length > 0;
  }

  resetModelQuarantine(profileId?: string): void {
    if (!profileId) {
      this.modelQuarantine.clear();
      return;
    }
    for (const key of this.modelQuarantine.keys()) {
      if (modelKeyOwner(key) === profileId) this.modelQuarantine.delete(key);
    }
  }

  /**
   * Candidate-affecting quarantine state, used by bounded replay loops to
   * prove that a non-terminal provider failure actually made progress.
   */
  getAvailabilityStateKey(now = Date.now()): string {
    this.refreshRecoveryState(now);
    const accountWalls = this.members
      .filter((member) => {
        if (!member.enabled) return false;
        const health = this.healthMap.get(member.profileId);
        return !!health && !health.healthy;
      })
      .map((member) => member.profileId)
      .sort();
    const modelWalls: string[] = [];
    for (const [key, entry] of this.modelQuarantine) {
      const recoverAt = entry.until ?? entry.since + this.recoveryIntervalMs;
      if (now >= recoverAt) {
        this.modelQuarantine.delete(key);
      } else if (
        this.members.some(
          (member) => member.profileId === modelKeyOwner(key) && member.enabled,
        )
      ) {
        modelWalls.push(key);
      }
    }
    modelWalls.sort();
    return JSON.stringify({ accountWalls, modelWalls });
  }

  /** How many enabled members are currently configured */
  getEnabledCount(): number {
    return this.members.filter((m) => m.enabled).length;
  }

  // ─── 选择算法 ────────────────────────────────────────────

  /**
   * 选择一个提供商，返回 profileId。
   *
   * @param tier When given, only accounts that can still serve this model
   * tier are eligible. Callers drain the primary tier across every account
   * before retrying with the fallback tier.
   */
  selectProvider(tier: ProviderTier = ''): string {
    const { strategy, members } = this;
    this.refreshRecoveryState();

    const candidates = this.candidatesForTier(tier, Date.now());

    if (candidates.length === 0) {
      // All unhealthy — best-effort: return first enabled member, or first member
      const firstEnabled = members.find((m) => m.enabled);
      const fallback = firstEnabled || members[0];
      if (fallback) {
        logger.warn(
          { profileId: fallback.profileId, strategy },
          'All providers unhealthy, falling back to first available',
        );
        return fallback.profileId;
      }
      // No members at all
      throw new Error('Provider pool has no members configured');
    }

    let selected: ProviderPoolMember;

    switch (strategy) {
      case 'round-robin': {
        const idx = this.roundRobinIndex % candidates.length;
        selected = candidates[idx];
        this.roundRobinIndex = idx + 1;
        break;
      }

      case 'weighted-round-robin': {
        const totalWeight = candidates.reduce(
          (sum, c) => sum + Math.max(1, Math.min(100, c.weight || 1)),
          0,
        );
        const target = this.roundRobinIndex % totalWeight;
        let cumulative = 0;
        selected = candidates[0];
        for (const c of candidates) {
          cumulative += Math.max(1, Math.min(100, c.weight || 1));
          if (target < cumulative) {
            selected = c;
            break;
          }
        }
        this.roundRobinIndex += 1;
        break;
      }

      case 'failover': {
        selected = candidates[0];
        break;
      }

      default: {
        selected = candidates[0];
        break;
      }
    }

    logger.debug(
      { profileId: selected.profileId, strategy },
      'Selected provider for session',
    );
    return selected.profileId;
  }

  // ─── 健康上报 ────────────────────────────────────────────

  reportSuccess(profileId: string, model?: string): void {
    const health = this.getOrCreateHealth(profileId);
    // A completed turn proves this exact tier works again.
    if (model?.trim()) {
      this.modelQuarantine.delete(modelKey(profileId, model.trim()));
    }
    health.consecutiveErrors = 0;
    health.lastSuccessAt = Date.now();
    if (!health.healthy) {
      health.healthy = true;
      health.unhealthySince = null;
      health.quarantinedUntil = null;
      logger.info({ profileId }, 'Provider recovered after success report');
    }
  }

  /**
   * @param quarantineUntil Upstream `rate_limit_event.resetsAt`, when the
   * failure was an account-scope rejection that reports its own reset time.
   */
  reportFailure(
    profileId: string,
    immediate = false,
    quarantineUntil?: number | null,
  ): void {
    const now = Date.now();
    const health = this.getOrCreateHealth(profileId);
    health.consecutiveErrors = immediate
      ? Math.max(health.consecutiveErrors + 1, this.unhealthyThreshold)
      : health.consecutiveErrors + 1;
    health.lastErrorAt = now;

    // Always take the latest upstream signal: a repeated rejection carries a
    // fresher reset stamp than the one recorded when the provider first failed.
    const reportedUntil = normalizeResetStamp(quarantineUntil, now);
    if (reportedUntil !== null) health.quarantinedUntil = reportedUntil;

    if (health.healthy && health.consecutiveErrors >= this.unhealthyThreshold) {
      health.healthy = false;
      health.unhealthySince = now;
      logger.warn(
        {
          profileId,
          consecutiveErrors: health.consecutiveErrors,
          threshold: this.unhealthyThreshold,
          quarantinedUntil: health.quarantinedUntil
            ? new Date(health.quarantinedUntil).toISOString()
            : null,
        },
        'Provider marked unhealthy after consecutive failures',
      );
    }
  }

  // ─── 会话计数 ────────────────────────────────────────────

  acquireSession(profileId: string): void {
    const health = this.getOrCreateHealth(profileId);
    health.activeSessionCount += 1;
  }

  releaseSession(profileId: string): void {
    const health = this.getOrCreateHealth(profileId);
    health.activeSessionCount = Math.max(0, health.activeSessionCount - 1);
  }

  // ─── 查询 ───────────────────────────────────────────────

  /**
   * Apply the same time-based recovery rule used by provider selection.
   * Failure-disposition checks call this first so "pool exhausted" cannot
   * disagree with what the next selectProvider() call would consider healthy.
   */
  refreshRecoveryState(now = Date.now()): void {
    for (const member of this.members) {
      if (!member.enabled) continue;
      const health = this.healthMap.get(member.profileId);
      if (!health || health.healthy || health.unhealthySince === null) continue;
      // An upstream-reported reset is authoritative over the local interval:
      // account-scope limits routinely outlast recoveryIntervalMs, and
      // resurrecting the provider early burns one whole turn per cycle.
      const recoverAt =
        health.quarantinedUntil ??
        health.unhealthySince + this.recoveryIntervalMs;
      if (now >= recoverAt) {
        health.healthy = true;
        health.consecutiveErrors = 0;
        health.unhealthySince = null;
        health.quarantinedUntil = null;
        logger.info(
          { profileId: member.profileId },
          'Provider auto-recovered after recovery interval',
        );
      }
    }
  }

  getHealthStatuses(): ProviderHealthStatus[] {
    // Ensure all configured members have health entries
    for (const member of this.members) {
      this.getOrCreateHealth(member.profileId);
    }
    return this.members.map((m) => ({
      ...(this.healthMap.get(m.profileId) || makeHealthStatus(m.profileId)),
    }));
  }

  getHealthStatus(profileId: string): ProviderHealthStatus {
    const health = this.healthMap.get(profileId);
    return health ? { ...health } : makeHealthStatus(profileId);
  }

  resetHealth(profileId: string): void {
    this.healthMap.set(profileId, makeHealthStatus(profileId));
    this.resetModelQuarantine(profileId);
  }

  // ─── 内部工具 ────────────────────────────────────────────

  private getOrCreateHealth(profileId: string): ProviderHealthStatus {
    let health = this.healthMap.get(profileId);
    if (!health) {
      health = makeHealthStatus(profileId);
      this.healthMap.set(profileId, health);
    }
    return health;
  }
}

// ─── 单例 ──────────────────────────────────────────────────

export const providerPool = new ProviderPool();
