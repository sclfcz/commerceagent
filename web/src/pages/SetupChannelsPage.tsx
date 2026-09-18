import { useEffect } from 'react';
import { ArrowRight, MessageSquare, SkipForward } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { ChannelAccountsManager } from '../components/settings/ChannelAccountsManager';
import { useAuthStore } from '../stores/auth';

/**
 * First-run setup intentionally reuses the same account-level onboarding as
 * Settings. Maintaining a second set of legacy provider forms caused QR and
 * pairing protocols to diverge from the product after onboarding.
 */
export function SetupChannelsPage() {
  const navigate = useNavigate();
  const { user, initialized } = useAuthStore();

  useEffect(() => {
    if (user === null && initialized) navigate('/login', { replace: true });
  }, [initialized, navigate, user]);

  return (
    <main className="min-h-screen overflow-y-auto bg-background px-4 py-8">
      <div className="mx-auto w-full max-w-4xl space-y-6">
        <header className="flex items-start gap-4">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10">
            <MessageSquare className="size-5 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-foreground">
              接入消息渠道（可选）
            </h1>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
              添加飞书、Telegram、QQ、微信、钉钉、Discord 或 WhatsApp
              账号。凭证、扫码和聊天配对会按照各渠道自己的协议完成。
            </p>
          </div>
        </header>

        <ChannelAccountsManager />

        <footer className="flex flex-wrap justify-end gap-2 border-t border-border pt-5">
          <Button
            type="button"
            variant="ghost"
            onClick={() => navigate('/chat', { replace: true })}
          >
            <SkipForward className="size-4" />
            稍后设置
          </Button>
          <Button
            type="button"
            onClick={() => navigate('/chat', { replace: true })}
          >
            完成并进入 CommerceAgent
            <ArrowRight className="size-4" />
          </Button>
        </footer>
      </div>
    </main>
  );
}
