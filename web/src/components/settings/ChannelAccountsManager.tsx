import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Settings2,
  TestTube2,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';

import { wsManager } from '@/api/ws';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useChatStore } from '../../stores/chat';
import {
  useChannelAccountsStore,
  type ChannelAccount,
  type ChannelProvider,
} from '../../stores/channel-accounts';
import {
  buildChannelAccountPayload,
  CHANNEL_PROVIDER_OPTIONS,
  providerAuthMode,
  providerDefinition,
  providerLabel,
  supportsChannelConnectionTest,
  supportsChannelPairing,
  validateChannelAccountForm,
  type AccountFormValues,
} from '../../utils/channel-accounts';
import { PairingSection } from './PairingSection';
import { usePairedChats } from './hooks/usePairedChats';
import { usePairingCode } from './hooks/usePairingCode';
import { ProviderConnectionFields } from './channel-accounts/ProviderConnectionFields';
import { QrOnboardingPanel } from './channel-accounts/QrOnboardingPanel';

type WorkspaceOption = { jid: string; name: string };

export function ChannelAccountsManager() {
  const {
    accounts,
    loading,
    error,
    loadAccounts,
    createAccount,
    testAccount,
    toggleAccount,
    deleteAccount,
    applyStatusEvent,
  } = useChannelAccountsStore();
  const groups = useChatStore((state) => state.groups);
  const loadGroups = useChatStore((state) => state.loadGroups);
  const [createOpen, setCreateOpen] = useState(false);
  const [settingsId, setSettingsId] = useState<string | null>(null);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [autoStartConnectionId, setAutoStartConnectionId] = useState<
    string | null
  >(null);
  const [actionId, setActionId] = useState<string | null>(null);

  useEffect(() => {
    void Promise.allSettled([loadAccounts(), loadGroups()]);
  }, [loadAccounts, loadGroups]);

  useEffect(() => {
    const unsubscribe = wsManager.on(
      'channel_account_status',
      (event: {
        accountId?: string;
        transportStatus?: ChannelAccount['transport_status'];
        lastError?: string | null;
        connectedAt?: string | null;
      }) => {
        if (!event.accountId || !event.transportStatus) return;
        applyStatusEvent({
          accountId: event.accountId,
          transportStatus: event.transportStatus,
          lastError: event.lastError,
          connectedAt: event.connectedAt,
        });
      },
    );
    return () => {
      unsubscribe();
    };
  }, [applyStatusEvent]);

  const workspaces = useMemo(
    () =>
      Object.entries(groups)
        .filter(([jid]) => jid.startsWith('web:'))
        .map(([jid, group]) => ({ jid, name: group.name })),
    [groups],
  );
  const settingsAccount =
    accounts.find((item) => item.id === settingsId) ?? null;
  const connectionAccount =
    accounts.find((item) => item.id === connectionId) ?? null;

  const handleTest = async (account: ChannelAccount) => {
    setActionId(`test:${account.id}`);
    try {
      const result = await testAccount(account.id);
      if (result.success) toast.success(`「${account.name}」连接测试通过`);
      else toast.error(result.error || '连接测试失败，请检查凭证和网络');
      await loadAccounts();
    } catch (err) {
      toast.error(getApiMessage(err, '连接测试失败，请检查凭证和网络'));
      await loadAccounts().catch(() => undefined);
    } finally {
      setActionId(null);
    }
  };

  const handleToggle = async (account: ChannelAccount) => {
    setActionId(`toggle:${account.id}`);
    try {
      await toggleAccount(account.id);
      toast.success(
        account.enabled
          ? '账号已停用，授权信息仍会保留'
          : '账号已启用，正在恢复连接',
      );
    } catch (err) {
      toast.error(getApiMessage(err, '更新账号状态失败'));
    } finally {
      setActionId(null);
    }
  };

  const handleDelete = async (account: ChannelAccount) => {
    if (
      !window.confirm(
        `删除渠道账号「${account.name}」？保存的凭证和授权会一并删除，此操作无法撤销。`,
      )
    )
      return;
    setActionId(`delete:${account.id}`);
    try {
      await deleteAccount(account.id);
      toast.success('渠道账号已删除');
    } catch (err) {
      const apiError = err as { body?: { binding_count?: number } };
      const count = apiError.body?.binding_count;
      toast.error(
        count
          ? `该账号仍有 ${count} 个工作区或会话绑定，请先换绑或解绑`
          : getApiMessage(err, '删除渠道账号失败'),
      );
    } finally {
      setActionId(null);
    }
  };

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold">渠道账号</h2>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
            同一渠道可以添加多个
            Bot。每个账号独立认证；工作区和会话的消息去向在“已接入会话”中管理。
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={() => void loadAccounts()}
          >
            <RefreshCw
              className={`size-3.5 ${loading ? 'animate-spin' : ''}`}
            />
            刷新
          </Button>
          <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="size-3.5" />
            添加账号
          </Button>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 border-b border-error/20 bg-error-bg px-5 py-3 text-xs text-error"
        >
          <span>{error}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void loadAccounts()}
          >
            重试
          </Button>
        </div>
      )}

      <div className="divide-y divide-border">
        {loading && accounts.length === 0 ? (
          <div className="flex items-center gap-2 px-5 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            正在加载渠道账号…
          </div>
        ) : accounts.length === 0 ? (
          <div className="px-5 py-8 text-center">
            <Bot className="mx-auto size-8 text-muted-foreground" />
            <p className="mt-2 text-sm font-medium">还没有渠道账号</p>
            <p className="mt-1 text-xs text-muted-foreground">
              添加第一个 Bot，完成渠道自己的凭证或扫码接入流程。
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-4"
              onClick={() => setCreateOpen(true)}
            >
              <Plus className="size-3.5" />
              添加渠道账号
            </Button>
          </div>
        ) : (
          accounts.map((account) => (
            <ChannelAccountRow
              key={account.id}
              account={account}
              workspaces={workspaces}
              actionId={actionId}
              onTest={handleTest}
              onToggle={handleToggle}
              onConnection={() => {
                setAutoStartConnectionId(null);
                setConnectionId(account.id);
              }}
              onSettings={() => setSettingsId(account.id)}
              onDelete={handleDelete}
            />
          ))
        )}
      </div>

      <CreateChannelAccountDialog
        open={createOpen}
        workspaces={workspaces}
        onClose={() => setCreateOpen(false)}
        onCreate={async (values) => {
          const payload = buildChannelAccountPayload(values, 'create');
          const account = await createAccount(
            payload as Parameters<typeof createAccount>[0],
          );
          setCreateOpen(false);
          toast.success('渠道账号已创建');
          if (providerAuthMode(account.provider) === 'qr_session') {
            setAutoStartConnectionId(account.id);
            setConnectionId(account.id);
          }
        }}
      />

      <AccountSettingsDialog
        account={settingsAccount}
        workspaces={workspaces}
        onClose={() => setSettingsId(null)}
      />

      <AccountConnectionDialog
        account={connectionAccount}
        autoStart={connectionAccount?.id === autoStartConnectionId}
        onClose={() => {
          setConnectionId(null);
          setAutoStartConnectionId(null);
        }}
      />
    </section>
  );
}

function ChannelAccountRow({
  account,
  workspaces,
  actionId,
  onTest,
  onToggle,
  onConnection,
  onSettings,
  onDelete,
}: {
  account: ChannelAccount;
  workspaces: WorkspaceOption[];
  actionId: string | null;
  onTest: (account: ChannelAccount) => Promise<void>;
  onToggle: (account: ChannelAccount) => Promise<void>;
  onConnection: () => void;
  onSettings: () => void;
  onDelete: (account: ChannelAccount) => Promise<void>;
}) {
  const busy = !!actionId;
  return (
    <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{account.name}</span>
          <span className="rounded bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
            {providerLabel(account.provider)}
          </span>
          {account.is_default && (
            <span className="rounded bg-primary/10 px-2 py-0.5 text-[10px] text-primary">
              默认账号
            </span>
          )}
          <AccountStateBadges account={account} />
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {defaultTargetLabel(account, workspaces)}
        </p>
        {account.last_error && (
          <p
            role={
              account.transport_status === 'reconnecting' ? 'status' : 'alert'
            }
            className={`mt-1 line-clamp-2 text-xs ${
              account.transport_status === 'reconnecting'
                ? 'text-warning'
                : 'text-error'
            }`}
          >
            {account.transport_status === 'reconnecting'
              ? `自动重连中：${account.last_error}`
              : account.last_error}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {supportsChannelConnectionTest(account.provider) &&
          account.has_credentials && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void onTest(account)}
            >
              {actionId === `test:${account.id}` ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <TestTube2 className="size-3.5" />
              )}
              测试连接
            </Button>
          )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={onConnection}
        >
          <KeyRound className="size-3.5" />
          {providerAuthMode(account.provider) === 'qr_session'
            ? account.auth_status === 'authorized'
              ? '管理连接'
              : '扫码连接'
            : '连接设置'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={onSettings}
        >
          <Settings2 className="size-3.5" />
          默认规则
        </Button>
        <div className="flex min-h-9 items-center gap-2 px-2 text-xs text-muted-foreground">
          <Switch
            checked={account.enabled}
            disabled={busy}
            onCheckedChange={() => void onToggle(account)}
            aria-label={`${account.enabled ? '停用' : '启用'}账号 ${account.name}`}
          />
          {account.enabled ? '启用' : '停用'}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="text-error hover:text-error"
          disabled={busy}
          onClick={() => void onDelete(account)}
          aria-label={`删除账号 ${account.name}`}
        >
          {actionId === `delete:${account.id}` ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Trash2 className="size-3.5" />
          )}
        </Button>
      </div>
    </div>
  );
}

function CreateChannelAccountDialog({
  open,
  workspaces,
  onClose,
  onCreate,
}: {
  open: boolean;
  workspaces: WorkspaceOption[];
  onClose: () => void;
  onCreate: (values: AccountFormValues) => Promise<void>;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [provider, setProvider] = useState<ChannelProvider>('feishu');
  const [name, setName] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [isDefault, setIsDefault] = useState(false);
  const [defaultWorkspace, setDefaultWorkspace] = useState('none');
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setStep(1);
    setProvider('feishu');
    setName('');
    setEnabled(true);
    setIsDefault(false);
    setDefaultWorkspace('none');
    setCredentials(defaultCredentials('feishu'));
    setFormError(null);
  }, [open]);

  const values: AccountFormValues = {
    provider,
    name,
    enabled,
    isDefault,
    defaultWorkspaceJid: defaultWorkspace,
    credentials,
    replaceCredentials: true,
  };
  const definition = providerDefinition(provider);

  const next = () => {
    const validationError = validateChannelAccountForm(values, 'create');
    if (validationError) {
      setFormError(validationError);
      return;
    }
    setFormError(null);
    setStep(2);
  };

  const submit = async () => {
    const validationError = validateChannelAccountForm(values, 'create');
    if (validationError) {
      setFormError(validationError);
      setStep(1);
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      await onCreate(values);
    } catch (err) {
      setFormError(getApiMessage(err, '创建渠道账号失败'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => !value && !saving && onClose()}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>添加渠道账号</DialogTitle>
          <DialogDescription>
            第 {step} 步，共 2 步 ·{' '}
            {step === 1 ? '选择渠道并完成连接配置' : '设置账号的默认接入规则'}
          </DialogDescription>
        </DialogHeader>

        {step === 1 ? (
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="new-channel-provider">渠道</Label>
                <Select
                  value={provider}
                  onValueChange={(value) => {
                    const nextProvider = value as ChannelProvider;
                    setProvider(nextProvider);
                    setCredentials(defaultCredentials(nextProvider));
                    setFormError(null);
                  }}
                >
                  <SelectTrigger id="new-channel-provider" className="mt-1.5">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CHANNEL_PROVIDER_OPTIONS.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="new-channel-name">账号名称</Label>
                <Input
                  id="new-channel-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  className="mt-1.5"
                  placeholder={`例如：客服${definition.label} Bot`}
                  autoFocus
                />
              </div>
            </div>
            <div className="border-t border-border pt-4">
              <h3 className="text-sm font-medium">连接方式</h3>
              <p className="mb-4 mt-1 text-xs leading-5 text-muted-foreground">
                {definition.description}
              </p>
              <ProviderConnectionFields
                provider={provider}
                values={credentials}
                idPrefix="new-channel"
                disabled={saving}
                onChange={(key, value) =>
                  setCredentials((current) => ({ ...current, [key]: value }))
                }
              />
            </div>
          </div>
        ) : (
          <AccountRoutingFields
            idPrefix="new-channel-routing"
            provider={provider}
            enabled={enabled}
            isDefault={isDefault}
            defaultWorkspace={defaultWorkspace}
            workspaces={workspaces}
            onEnabledChange={setEnabled}
            onDefaultChange={setIsDefault}
            onWorkspaceChange={setDefaultWorkspace}
          />
        )}

        {formError && (
          <p role="alert" className="text-sm text-error">
            {formError}
          </p>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={saving}
            onClick={step === 1 ? onClose : () => setStep(1)}
          >
            {step === 1 ? '取消' : '上一步'}
          </Button>
          <Button
            type="button"
            disabled={saving}
            onClick={() => void (step === 1 ? next() : submit())}
          >
            {saving && <Loader2 className="size-4 animate-spin" />}
            {step === 1
              ? '下一步：默认规则'
              : providerAuthMode(provider) === 'qr_session'
                ? '创建并扫码'
                : '创建账号'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AccountSettingsDialog({
  account,
  workspaces,
  onClose,
}: {
  account: ChannelAccount | null;
  workspaces: WorkspaceOption[];
  onClose: () => void;
}) {
  const updateAccount = useChannelAccountsStore((state) => state.updateAccount);
  const [name, setName] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [isDefault, setIsDefault] = useState(false);
  const [defaultWorkspace, setDefaultWorkspace] = useState('none');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!account) return;
    setName(account.name);
    setEnabled(account.enabled);
    setIsDefault(account.is_default);
    setDefaultWorkspace(account.default_workspace_jid ?? 'none');
    setError(null);
  }, [account]);

  const submit = async () => {
    if (!account) return;
    if (!name.trim()) return setError('请输入账号名称');
    setSaving(true);
    setError(null);
    try {
      await updateAccount(account.id, {
        name: name.trim(),
        enabled,
        is_default: isDefault,
        default_workspace_jid:
          defaultWorkspace === 'none' ? null : defaultWorkspace,
      });
      toast.success('默认接入规则已保存');
      onClose();
    } catch (err) {
      setError(getApiMessage(err, '保存默认接入规则失败'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={!!account}
      onOpenChange={(value) => !value && !saving && onClose()}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>账号与默认规则</DialogTitle>
          <DialogDescription>
            这里不修改渠道凭证。具体工作区和会话绑定请到“已接入会话”管理。
          </DialogDescription>
        </DialogHeader>
        {account && (
          <div className="space-y-5">
            <div>
              <Label htmlFor="channel-settings-name">账号名称</Label>
              <Input
                id="channel-settings-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="mt-1.5"
              />
            </div>
            <AccountRoutingFields
              idPrefix="channel-settings-routing"
              provider={account.provider}
              enabled={enabled}
              isDefault={isDefault}
              defaultWorkspace={defaultWorkspace}
              workspaces={workspaces}
              onEnabledChange={setEnabled}
              onDefaultChange={setIsDefault}
              onWorkspaceChange={setDefaultWorkspace}
            />
            {error && (
              <p role="alert" className="text-sm text-error">
                {error}
              </p>
            )}
          </div>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={saving}
            onClick={onClose}
          >
            取消
          </Button>
          <Button type="button" disabled={saving} onClick={() => void submit()}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            保存默认规则
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AccountConnectionDialog({
  account,
  autoStart,
  onClose,
}: {
  account: ChannelAccount | null;
  autoStart: boolean;
  onClose: () => void;
}) {
  const updateAccount = useChannelAccountsStore((state) => state.updateAccount);
  const logoutAccount = useChannelAccountsStore((state) => state.logoutAccount);
  const [replacing, setReplacing] = useState(false);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [options, setOptions] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!account) return;
    setReplacing(
      !account.has_credentials &&
        providerAuthMode(account.provider) !== 'qr_session',
    );
    setCredentials(defaultCredentials(account.provider));
    setOptions(accountOptions(account));
    setError(null);
  }, [account]);

  if (!account) return null;
  const definition = providerDefinition(account.provider);

  const replaceCredentials = async () => {
    const values: AccountFormValues = {
      provider: account.provider,
      name: account.name,
      enabled: account.enabled,
      isDefault: account.is_default,
      defaultWorkspaceJid: account.default_workspace_jid ?? 'none',
      credentials: { ...credentials, ...options },
      replaceCredentials: true,
    };
    const validationError = validateChannelAccountForm(values, 'edit');
    if (validationError) return setError(validationError);
    setSaving(true);
    setError(null);
    try {
      await updateAccount(account.id, { credentials: values.credentials });
      setReplacing(false);
      setCredentials(defaultCredentials(account.provider));
      toast.success('连接凭证已更新');
    } catch (err) {
      setError(getApiMessage(err, '更新连接凭证失败'));
    } finally {
      setSaving(false);
    }
  };

  const saveOptions = async () => {
    setSaving(true);
    setError(null);
    try {
      await updateAccount(account.id, { credentials: options });
      toast.success('连接选项已保存');
    } catch (err) {
      setError(getApiMessage(err, '保存连接选项失败'));
    } finally {
      setSaving(false);
    }
  };

  const revokeCredentials = async () => {
    if (!window.confirm(`清除「${account.name}」的连接凭证并停用账号？`))
      return;
    setSaving(true);
    setError(null);
    try {
      await logoutAccount(account.id);
      toast.success('连接凭证已清除，账号已停用');
      setReplacing(true);
    } catch (err) {
      setError(getApiMessage(err, '清除连接凭证失败'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(value) => !value && !saving && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{providerLabel(account.provider)}连接</DialogTitle>
          <DialogDescription>
            管理“{account.name}
            ”的认证和协议设置。默认工作区与具体会话绑定不在这里修改。
          </DialogDescription>
        </DialogHeader>

        {definition.authMode === 'qr_session' ? (
          <div className="space-y-5">
            {account.provider === 'wechat' && (
              <div>
                <h3 className="mb-2 text-sm font-medium">网络方式</h3>
                <ProviderConnectionFields
                  provider="wechat"
                  values={options}
                  idPrefix={`connection-${account.id}`}
                  disabled={saving}
                  showSecrets={false}
                  onChange={(key, value) =>
                    setOptions((current) => ({ ...current, [key]: value }))
                  }
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  disabled={saving}
                  onClick={() => void saveOptions()}
                >
                  {saving && <Loader2 className="size-3.5 animate-spin" />}
                  保存网络方式
                </Button>
              </div>
            )}
            <div className="border-t border-border pt-4">
              <h3 className="mb-3 text-sm font-medium">扫码与连接状态</h3>
              <QrOnboardingPanel account={account} autoStart={autoStart} />
            </div>
          </div>
        ) : (
          <div className="space-y-5">
            <div className="rounded-lg border border-border px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">
                    {account.has_credentials
                      ? '连接凭证已配置'
                      : '连接凭证待配置'}
                  </p>
                  <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                    密钥不会回填。替换凭证时请重新填写完整的一组字段。
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setReplacing((current) => !current);
                    setCredentials(defaultCredentials(account.provider));
                    setError(null);
                  }}
                >
                  <Pencil className="size-3.5" />
                  {replacing
                    ? '取消替换'
                    : account.has_credentials
                      ? '替换凭证'
                      : '填写凭证'}
                </Button>
              </div>
              {replacing && (
                <div className="mt-4 border-t border-border pt-4">
                  <ProviderConnectionFields
                    provider={account.provider}
                    values={{ ...credentials, ...options }}
                    idPrefix={`replace-${account.id}`}
                    disabled={saving}
                    showOptions={false}
                    onChange={(key, value) =>
                      setCredentials((current) => ({
                        ...current,
                        [key]: value,
                      }))
                    }
                  />
                  <Button
                    type="button"
                    className="mt-4"
                    disabled={saving}
                    onClick={() => void replaceCredentials()}
                  >
                    {saving && <Loader2 className="size-4 animate-spin" />}
                    保存新凭证
                  </Button>
                </div>
              )}
            </div>

            {(account.provider === 'dingtalk' ||
              account.provider === 'discord') && (
              <div>
                <h3 className="mb-2 text-sm font-medium">回复方式</h3>
                <ProviderConnectionFields
                  provider={account.provider}
                  values={options}
                  idPrefix={`options-${account.id}`}
                  disabled={saving}
                  showSecrets={false}
                  onChange={(key, value) =>
                    setOptions((current) => ({ ...current, [key]: value }))
                  }
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  disabled={saving}
                  onClick={() => void saveOptions()}
                >
                  {saving && <Loader2 className="size-3.5 animate-spin" />}
                  保存回复方式
                </Button>
              </div>
            )}

            {account.has_credentials && (
              <div className="border-t border-border pt-4">
                <Button
                  type="button"
                  variant="outline"
                  className="text-error hover:text-error"
                  disabled={saving}
                  onClick={() => void revokeCredentials()}
                >
                  <Trash2 className="size-4" />
                  清除连接凭证
                </Button>
              </div>
            )}
          </div>
        )}

        {supportsChannelPairing(account.provider) &&
          account.has_credentials && (
            <AccountPairingSection account={account} />
          )}

        {error && (
          <p role="alert" className="text-sm text-error">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={saving}
            onClick={onClose}
          >
            完成
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AccountPairingSection({ account }: { account: ChannelAccount }) {
  const base = `/api/channel-accounts/${encodeURIComponent(account.id)}`;
  const pairing = usePairingCode({ endpoint: `${base}/pairing-code` });
  const paired = usePairedChats({ endpoint: `${base}/paired-chats` });

  useEffect(() => {
    void paired.load();
  }, [paired.load]);

  return (
    <PairingSection
      channelName={providerLabel(account.provider)}
      pairing={pairing}
      paired={paired}
    />
  );
}

function AccountRoutingFields({
  idPrefix,
  provider,
  enabled,
  isDefault,
  defaultWorkspace,
  workspaces,
  onEnabledChange,
  onDefaultChange,
  onWorkspaceChange,
}: {
  idPrefix: string;
  provider: ChannelProvider;
  enabled: boolean;
  isDefault: boolean;
  defaultWorkspace: string;
  workspaces: WorkspaceOption[];
  onEnabledChange: (value: boolean) => void;
  onDefaultChange: (value: boolean) => void;
  onWorkspaceChange: (value: string) => void;
}) {
  return (
    <div className="space-y-5">
      <div className="space-y-3 rounded-lg border border-border px-4 py-3">
        <ToggleField
          id={`${idPrefix}-enabled`}
          label="创建后启用账号"
          description="停用只会断开消息连接，不会删除凭证或扫码授权。"
          checked={enabled}
          onChange={onEnabledChange}
        />
        <ToggleField
          id={`${idPrefix}-default`}
          label={`设为默认${providerLabel(provider)}账号`}
          description="没有明确指定账号时，优先使用这个账号。"
          checked={isDefault}
          onChange={onDefaultChange}
        />
      </div>
      <div>
        <Label htmlFor={`${idPrefix}-workspace`}>未绑定会话的默认去向</Label>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          只作为兜底规则；具体群聊和私聊仍可在“已接入会话”中单独绑定。
        </p>
        <Select value={defaultWorkspace} onValueChange={onWorkspaceChange}>
          <SelectTrigger id={`${idPrefix}-workspace`} className="mt-2">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">进入个人主页</SelectItem>
            {workspaces.map((workspace) => (
              <SelectItem key={workspace.jid} value={workspace.jid}>
                {workspace.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

function ToggleField({
  id,
  label,
  description,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <Label htmlFor={id} className="text-sm font-medium">
          {label}
        </Label>
        <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
          {description}
        </p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function AccountStateBadges({ account }: { account: ChannelAccount }) {
  const authStatus =
    account.auth_status ?? (account.has_credentials ? 'authorized' : 'draft');
  const transportStatus =
    account.transport_status ??
    (account.status === 'connected'
      ? 'connected'
      : account.status === 'connecting'
        ? 'connecting'
        : account.status === 'reconnecting'
          ? 'reconnecting'
          : account.status === 'error'
            ? 'error'
            : 'disconnected');
  const auth = {
    draft: ['待配置', 'bg-muted text-muted-foreground'],
    awaiting_scan: ['待扫码', 'bg-warning-bg text-warning'],
    authorized: ['已授权', 'bg-success-bg text-success'],
    revoked: ['已撤销', 'bg-muted text-muted-foreground'],
    error: ['认证异常', 'bg-error-bg text-error'],
  }[authStatus];
  const transport = !account.enabled
    ? (['已停用', 'bg-muted text-muted-foreground'] as const)
    : {
        disconnected: ['离线', 'bg-muted text-muted-foreground'],
        connecting: ['连接中', 'bg-warning-bg text-warning'],
        reconnecting: ['重连中', 'bg-warning-bg text-warning'],
        connected: ['在线', 'bg-success-bg text-success'],
        error: ['连接异常', 'bg-error-bg text-error'],
      }[transportStatus];
  return (
    <>
      <span
        className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] ${auth[1]}`}
      >
        {authStatus === 'authorized' && <CheckCircle2 className="size-3" />}
        {authStatus === 'error' && <AlertCircle className="size-3" />}
        {auth[0]}
      </span>
      <span
        className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] ${transport[1]}`}
      >
        {transportStatus === 'connected' && account.enabled && (
          <CheckCircle2 className="size-3" />
        )}
        {transportStatus === 'reconnecting' && account.enabled && (
          <RefreshCw className="size-3 motion-safe:animate-spin" />
        )}
        {transportStatus === 'error' && account.enabled && (
          <AlertCircle className="size-3" />
        )}
        {transport[0]}
      </span>
    </>
  );
}

function defaultCredentials(provider: ChannelProvider): Record<string, string> {
  if (provider === 'wechat') return { bypassProxy: 'true' };
  if (provider === 'dingtalk') return { streamingMode: 'card' };
  if (provider === 'discord') return { streamingMode: 'off' };
  return {};
}

function accountOptions(account: ChannelAccount): Record<string, string> {
  if (account.provider === 'wechat')
    return { bypassProxy: String(account.options?.bypassProxy ?? true) };
  if (account.provider === 'dingtalk')
    return { streamingMode: account.options?.streamingMode ?? 'card' };
  if (account.provider === 'discord')
    return { streamingMode: account.options?.streamingMode ?? 'off' };
  return {};
}

function defaultTargetLabel(
  account: ChannelAccount,
  workspaces: WorkspaceOption[],
) {
  if (account.default_workspace_jid)
    return `默认去向：${workspaces.find((item) => item.jid === account.default_workspace_jid)?.name ?? '已删除工作区'}`;
  return '默认去向：个人主页';
}

function getApiMessage(error: unknown, fallback: string) {
  if (
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof error.message === 'string'
  )
    return error.message;
  return fallback;
}
