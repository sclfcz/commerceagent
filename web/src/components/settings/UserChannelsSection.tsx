import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AtSign, MessagesSquare } from 'lucide-react';
import { toast } from 'sonner';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuthStore } from '../../stores/auth';
import { BindingsSection } from './BindingsSection';
import { ChannelAccountsManager } from './ChannelAccountsManager';
import { SettingsCard as Section } from './SettingsCard';
import { getErrorMessage } from './types';

export function UserChannelsSection() {
  const { user, updateProfile } = useAuthStore();
  const [searchParams, setSearchParams] = useSearchParams();
  const [requireMention, setRequireMention] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setRequireMention(user?.default_require_mention ?? false);
  }, [user?.default_require_mention]);

  const handleDefaultChange = async (next: boolean) => {
    const previous = requireMention;
    setRequireMention(next);
    setSaving(true);
    try {
      await updateProfile({ default_require_mention: next });
      toast.success('新群默认响应方式已保存');
    } catch (error) {
      setRequireMention(previous);
      toast.error(getErrorMessage(error, '保存新群默认响应方式失败'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Tabs
      value={searchParams.get('view') === 'bindings' ? 'bindings' : 'accounts'}
      onValueChange={(view) => {
        const next = new URLSearchParams(searchParams);
        if (view === 'bindings') next.set('view', 'bindings');
        else next.delete('view');
        setSearchParams(next, { replace: true });
      }}
      className="space-y-4"
    >
      <TabsList aria-label="消息渠道设置">
        <TabsTrigger value="accounts">渠道账号与默认规则</TabsTrigger>
        <TabsTrigger value="bindings">已接入会话</TabsTrigger>
      </TabsList>

      <TabsContent value="accounts" className="space-y-4">
        <Section
          icon={MessagesSquare}
          title="新群默认响应方式"
          desc="仅影响之后自动注册的群聊；已有群聊继续使用各自的响应设置"
        >
          <div
            role="radiogroup"
            aria-label="新群默认响应方式"
            className="grid gap-2 sm:grid-cols-2"
          >
            <button
              type="button"
              role="radio"
              aria-checked={requireMention}
              disabled={saving}
              onClick={() => handleDefaultChange(true)}
              className={`min-h-20 rounded-xl border px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                requireMention
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:bg-muted'
              }`}
            >
              <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                <AtSign className="size-4" />
                仅在 @机器人时回复（推荐）
              </span>
              <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                降低误触发、无关消息处理和额外费用。
              </span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={!requireMention}
              disabled={saving}
              onClick={() => handleDefaultChange(false)}
              className={`min-h-20 rounded-xl border px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                !requireMention
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:bg-muted'
              }`}
            >
              <span className="text-sm font-medium text-foreground">
                响应允许成员的所有消息
              </span>
              <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                实际可触发成员仍受该渠道与群聊的权限规则限制。
              </span>
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            已有群聊可在“已接入会话”中单独修改，也可在群里使用 /require_mention
            快捷命令。
          </p>
        </Section>

        <ChannelAccountsManager />
      </TabsContent>

      <TabsContent value="bindings">
        <BindingsSection />
      </TabsContent>
    </Tabs>
  );
}
