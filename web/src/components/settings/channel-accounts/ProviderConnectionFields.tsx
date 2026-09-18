import { ExternalLink } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import type { ChannelProvider } from '../../../stores/channel-accounts';
import {
  providerDefinition,
  type ChannelSetupGuide,
} from '../../../utils/channel-accounts';

interface ProviderConnectionFieldsProps {
  provider: ChannelProvider;
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  disabled?: boolean;
  idPrefix: string;
  showSecrets?: boolean;
  showGuide?: boolean;
  showOptions?: boolean;
}

export function ProviderConnectionFields({
  provider,
  values,
  onChange,
  disabled = false,
  idPrefix,
  showSecrets = true,
  showGuide,
  showOptions = true,
}: ProviderConnectionFieldsProps) {
  const definition = providerDefinition(provider);
  const shouldShowGuide = showGuide ?? showSecrets;

  if (definition.authMode === 'qr_session') {
    return (
      <div className="space-y-4">
        {shouldShowGuide && (
          <ProviderSetupGuide
            id={`${idPrefix}-setup-guide`}
            guide={definition.setupGuide}
          />
        )}
        <p className="text-xs leading-5 text-muted-foreground">
          {provider === 'wechat'
            ? '扫码结果由 CommerceAgent 安全保存，无需填写 Token、Bot ID 或服务地址。'
            : '账号和会话密钥由 CommerceAgent 管理，无需填写手机号或账号标识。'}
        </p>
        {provider === 'wechat' && showOptions && (
          <OptionSwitch
            id={`${idPrefix}-bypass-proxy`}
            label="绕过 CommerceAgent HTTP 代理"
            description="开启后不使用 HTTP(S)_PROXY；Clash TUN、VPN 等系统级网络仍可能接管流量。"
            checked={(values.bypassProxy ?? 'true') !== 'false'}
            disabled={disabled}
            onCheckedChange={(checked) =>
              onChange('bypassProxy', String(checked))
            }
          />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {shouldShowGuide && (
        <ProviderSetupGuide
          id={`${idPrefix}-setup-guide`}
          guide={definition.setupGuide}
        />
      )}
      {showSecrets && (
        <div className="grid gap-4 sm:grid-cols-2">
          {definition.credentials.map((field) => {
            const id = `${idPrefix}-${field.key}`;
            return (
              <div
                key={field.key}
                className={
                  definition.credentials.length === 1 ? 'sm:col-span-2' : ''
                }
              >
                <Label htmlFor={id}>
                  {field.label}
                  {field.required && (
                    <span aria-hidden="true" className="text-error">
                      {' '}
                      *
                    </span>
                  )}
                </Label>
                <Input
                  id={id}
                  className="mt-1.5"
                  type={field.secret ? 'password' : 'text'}
                  value={values[field.key] ?? ''}
                  disabled={disabled}
                  onChange={(event) => onChange(field.key, event.target.value)}
                  placeholder={field.placeholder}
                  autoComplete={field.secret ? 'new-password' : 'off'}
                  aria-required={field.required}
                  aria-describedby={field.help ? `${id}-help` : undefined}
                />
                {field.help && (
                  <p
                    id={`${id}-help`}
                    className="mt-1 text-xs leading-5 text-muted-foreground"
                  >
                    {field.help}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {showOptions && provider === 'dingtalk' && (
        <OptionSwitch
          id={`${idPrefix}-streaming-card`}
          label="流式卡片"
          description="开启后以卡片实时更新回复；关闭后发送普通文本。"
          checked={(values.streamingMode ?? 'card') === 'card'}
          disabled={disabled}
          onCheckedChange={(checked) =>
            onChange('streamingMode', checked ? 'card' : 'text')
          }
        />
      )}

      {showOptions && provider === 'discord' && (
        <OptionSwitch
          id={`${idPrefix}-streaming-edit`}
          label="流式编辑"
          description="开启后持续编辑同一条消息；关闭后完成生成再发送。"
          checked={(values.streamingMode ?? 'off') === 'edit'}
          disabled={disabled}
          onCheckedChange={(checked) =>
            onChange('streamingMode', checked ? 'edit' : 'off')
          }
        />
      )}
    </div>
  );
}

function ProviderSetupGuide({
  id,
  guide,
}: {
  id: string;
  guide: ChannelSetupGuide;
}) {
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="rounded-lg border border-border bg-muted/35 px-4 py-3"
    >
      <div className="flex flex-col items-start justify-between gap-2 sm:flex-row sm:gap-4">
        <h4 id={`${id}-title`} className="text-sm font-medium text-foreground">
          {guide.title}
        </h4>
        {guide.action && (
          <a
            href={guide.action.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
          >
            {guide.action.label}
            <ExternalLink className="size-3.5" aria-hidden="true" />
          </a>
        )}
      </div>
      <ol className="mt-2.5 space-y-2">
        {guide.steps.map((step, index) => (
          <li
            key={step}
            className="flex items-start gap-2 text-xs leading-5 text-muted-foreground"
          >
            <span
              aria-hidden="true"
              className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-border text-[10px] font-medium text-foreground"
            >
              {index + 1}
            </span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
      <p className="mt-3 border-t border-border pt-2.5 text-xs leading-5 text-foreground/80">
        <span className="font-medium text-foreground">创建后：</span>
        {guide.nextStep}
      </p>
    </section>
  );
}

function OptionSwitch({
  id,
  label,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border border-border px-4 py-3">
      <div>
        <Label htmlFor={id} className="text-sm font-medium">
          {label}
        </Label>
        <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
          {description}
        </p>
      </div>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </div>
  );
}
