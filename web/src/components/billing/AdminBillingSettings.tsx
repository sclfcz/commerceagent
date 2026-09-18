import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, Loader2, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '../../api/client';
import { useBillingStore } from '../../stores/billing';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

interface BillingAdminConfig {
  enabled: boolean;
  minStartBalanceUsd: number;
  currency: string;
  currencyRate: number;
}

interface BillingDraft {
  billingEnabled: boolean;
  billingMinStartBalanceUsd: string;
  billingCurrency: string;
  billingCurrencyRate: string;
}

function toDraft(config: BillingAdminConfig): BillingDraft {
  return {
    billingEnabled: config.enabled,
    billingMinStartBalanceUsd: String(config.minStartBalanceUsd),
    billingCurrency: config.currency,
    billingCurrencyRate: String(config.currencyRate),
  };
}

export default function AdminBillingSettings() {
  const loadBillingStatus = useBillingStore((state) => state.loadBillingStatus);
  const [saved, setSaved] = useState<BillingDraft | null>(null);
  const [draft, setDraft] = useState<BillingDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [touched, setTouched] = useState<
    Partial<Record<keyof BillingDraft, boolean>>
  >({});

  const loadConfig = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await api.get<BillingAdminConfig>(
        '/api/billing/admin/config',
      );
      const next = toDraft(data);
      setSaved(next);
      setDraft(next);
      setSubmitted(false);
      setTouched({});
    } catch (error) {
      setLoadError(
        error instanceof Error && error.message
          ? error.message
          : '无法读取计费设置，请检查网络后重试。',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  const errors = useMemo(() => {
    if (!draft) return {};
    const next: Partial<Record<keyof BillingDraft, string>> = {};
    const minBalance = Number(draft.billingMinStartBalanceUsd);
    if (
      !draft.billingMinStartBalanceUsd.trim() ||
      !Number.isFinite(minBalance)
    ) {
      next.billingMinStartBalanceUsd = '请输入有效金额。';
    } else if (minBalance < 0 || minBalance > 1_000_000) {
      next.billingMinStartBalanceUsd = '请输入 0–1,000,000 USD。';
    }

    const currency = draft.billingCurrency.trim();
    if (!currency) {
      next.billingCurrency = '请输入显示货币代码。';
    } else if (currency.length > 10) {
      next.billingCurrency = '货币代码不能超过 10 个字符。';
    }

    const rate = Number(draft.billingCurrencyRate);
    if (!draft.billingCurrencyRate.trim() || !Number.isFinite(rate)) {
      next.billingCurrencyRate = '请输入有效汇率。';
    } else if (rate < 0.01 || rate > 1000) {
      next.billingCurrencyRate = '请输入 0.01–1000。';
    }
    return next;
  }, [draft]);

  const dirty =
    !!draft && !!saved && JSON.stringify(draft) !== JSON.stringify(saved);

  const handleSave = async () => {
    if (!draft) return;
    setSubmitted(true);
    if (Object.keys(errors).length > 0) return;
    setSaving(true);
    try {
      const data = await api.put<BillingAdminConfig>(
        '/api/billing/admin/config',
        {
          enabled: draft.billingEnabled,
          minStartBalanceUsd: Number(draft.billingMinStartBalanceUsd),
          currency: draft.billingCurrency.trim(),
          currencyRate: Number(draft.billingCurrencyRate),
        },
      );
      const next = toDraft(data);
      setSaved(next);
      setDraft(next);
      setSubmitted(false);
      setTouched({});
      await loadBillingStatus();
      toast.success('计费设置已保存');
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : '计费设置保存失败，请稍后重试。',
      );
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div
        className="flex min-h-48 items-center justify-center"
        aria-label="正在加载计费设置"
      >
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (loadError || !draft) {
    return (
      <div className="flex min-h-48 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border px-6 text-center">
        <AlertCircle className="size-6 text-destructive" aria-hidden="true" />
        <div>
          <p className="text-sm font-medium text-foreground">
            计费设置加载失败
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{loadError}</p>
        </div>
        <Button
          variant="outline"
          onClick={() => void loadConfig()}
          className="min-h-11"
        >
          <RotateCcw className="size-4" aria-hidden="true" />
          重新加载
        </Button>
      </div>
    );
  }

  const fieldError = (key: keyof BillingDraft) =>
    submitted || touched[key] ? errors[key] : undefined;

  return (
    <div className="mx-auto max-w-3xl">
      <header>
        <h2 className="text-lg font-semibold text-foreground">计费设置</h2>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          管理计费开关、最低起用余额和前端显示货币。套餐和默认套餐请在“套餐管理”中配置。
        </p>
      </header>

      <section className="mt-6 overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex min-h-20 items-center justify-between gap-6 px-5 py-4">
          <div className="min-w-0">
            <Label htmlFor="billing-admin-enabled">启用计费</Label>
            <p
              id="billing-admin-enabled-description"
              className="mt-1 text-xs leading-5 text-muted-foreground"
            >
              开启后，普通用户需要满足余额和套餐限制才能发送消息或运行任务。
            </p>
          </div>
          <Switch
            id="billing-admin-enabled"
            checked={draft.billingEnabled}
            onCheckedChange={(checked) =>
              setDraft((current) =>
                current ? { ...current, billingEnabled: checked } : current,
              )
            }
            aria-describedby="billing-admin-enabled-description"
          />
        </div>

        <div className="divide-y divide-border border-t border-border px-5">
          <div className="grid gap-2 py-5 sm:grid-cols-[minmax(0,1fr)_12rem] sm:gap-8">
            <div>
              <Label htmlFor="billing-admin-min-balance">最低可用余额</Label>
              <p
                id="billing-admin-min-balance-description"
                className="mt-1 text-xs leading-5 text-muted-foreground"
              >
                普通用户余额低于该值时，消息和任务会被阻止。
              </p>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <Input
                  id="billing-admin-min-balance"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={1_000_000}
                  step={0.01}
                  value={draft.billingMinStartBalanceUsd}
                  onChange={(event) =>
                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            billingMinStartBalanceUsd: event.target.value,
                          }
                        : current,
                    )
                  }
                  onBlur={() =>
                    setTouched((current) => ({
                      ...current,
                      billingMinStartBalanceUsd: true,
                    }))
                  }
                  aria-invalid={!!fieldError('billingMinStartBalanceUsd')}
                  aria-describedby={`billing-admin-min-balance-description${fieldError('billingMinStartBalanceUsd') ? ' billing-admin-min-balance-error' : ''}`}
                  className="h-11"
                />
                <span className="shrink-0 text-xs text-muted-foreground">
                  USD
                </span>
              </div>
              {fieldError('billingMinStartBalanceUsd') && (
                <p
                  id="billing-admin-min-balance-error"
                  role="alert"
                  className="mt-1 text-xs text-destructive"
                >
                  {fieldError('billingMinStartBalanceUsd')}
                </p>
              )}
            </div>
          </div>

          <div className="grid gap-2 py-5 sm:grid-cols-[minmax(0,1fr)_12rem] sm:gap-8">
            <div>
              <Label htmlFor="billing-admin-currency">显示货币代码</Label>
              <p
                id="billing-admin-currency-description"
                className="mt-1 text-xs leading-5 text-muted-foreground"
              >
                仅影响界面显示，例如 USD、CNY 或 EUR；账本仍以 USD 结算。
              </p>
            </div>
            <div>
              <Input
                id="billing-admin-currency"
                value={draft.billingCurrency}
                maxLength={10}
                onChange={(event) =>
                  setDraft((current) =>
                    current
                      ? {
                          ...current,
                          billingCurrency: event.target.value.toUpperCase(),
                        }
                      : current,
                  )
                }
                onBlur={() =>
                  setTouched((current) => ({
                    ...current,
                    billingCurrency: true,
                  }))
                }
                aria-invalid={!!fieldError('billingCurrency')}
                aria-describedby={`billing-admin-currency-description${fieldError('billingCurrency') ? ' billing-admin-currency-error' : ''}`}
                className="h-11"
              />
              {fieldError('billingCurrency') && (
                <p
                  id="billing-admin-currency-error"
                  role="alert"
                  className="mt-1 text-xs text-destructive"
                >
                  {fieldError('billingCurrency')}
                </p>
              )}
            </div>
          </div>

          <div className="grid gap-2 py-5 sm:grid-cols-[minmax(0,1fr)_12rem] sm:gap-8">
            <div>
              <Label htmlFor="billing-admin-currency-rate">显示汇率</Label>
              <p
                id="billing-admin-currency-rate-description"
                className="mt-1 text-xs leading-5 text-muted-foreground"
              >
                将 USD 金额换算为显示货币的乘数，例如 CNY 可填写 7.2。
              </p>
            </div>
            <div>
              <Input
                id="billing-admin-currency-rate"
                type="number"
                inputMode="decimal"
                min={0.01}
                max={1000}
                step={0.01}
                value={draft.billingCurrencyRate}
                onChange={(event) =>
                  setDraft((current) =>
                    current
                      ? { ...current, billingCurrencyRate: event.target.value }
                      : current,
                  )
                }
                onBlur={() =>
                  setTouched((current) => ({
                    ...current,
                    billingCurrencyRate: true,
                  }))
                }
                aria-invalid={!!fieldError('billingCurrencyRate')}
                aria-describedby={`billing-admin-currency-rate-description${fieldError('billingCurrencyRate') ? ' billing-admin-currency-rate-error' : ''}`}
                className="h-11"
              />
              {fieldError('billingCurrencyRate') && (
                <p
                  id="billing-admin-currency-rate-error"
                  role="alert"
                  className="mt-1 text-xs text-destructive"
                >
                  {fieldError('billingCurrencyRate')}
                </p>
              )}
            </div>
          </div>
        </div>
      </section>

      <div className="sticky bottom-0 z-10 mt-6 flex min-h-16 items-center justify-between gap-4 border-t border-border bg-background/95 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/85">
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {dirty ? '有尚未保存的计费设置' : '计费设置已保存'}
        </p>
        <Button
          onClick={() => void handleSave()}
          disabled={saving || !dirty || Object.keys(errors).length > 0}
          className="min-h-11"
        >
          {saving && (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          )}
          保存计费设置
        </Button>
      </div>
    </div>
  );
}
