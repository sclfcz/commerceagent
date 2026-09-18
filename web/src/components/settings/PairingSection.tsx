import { Link as RouterLink } from 'react-router-dom';
import {
  Loader2,
  Copy,
  Check,
  Link as ChainLink,
  ArrowRight,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { PairedChat } from './hooks/usePairedChats';

interface PairingSectionProps {
  channelName: string;
  pairing: {
    code: string | null;
    countdown: number;
    generating: boolean;
    copied: boolean;
    generate: () => void;
    copyCommand: () => void;
  };
  paired: {
    chats: PairedChat[];
    loading: boolean;
    error?: string | null;
    removingJid: string | null;
    renamingJid?: string | null;
    load: () => void;
    remove: (jid: string) => void;
    rename?: (jid: string, name: string) => void;
  };
}

export function PairingSection({
  channelName,
  pairing,
  paired,
}: PairingSectionProps) {
  return (
    <div className="mt-4 border-t border-border pt-4">
      <div className="flex items-center gap-2 mb-3">
        <ChainLink className="w-4 h-4 text-muted-foreground" />
        <h4 className="text-sm font-medium text-foreground">聊天配对</h4>
      </div>

      {pairing.code && pairing.countdown > 0 ? (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <code className="text-2xl font-mono font-bold tracking-widest text-primary bg-primary/5 px-4 py-2 rounded-lg select-all">
              {pairing.code}
            </code>
            <div className="text-sm text-muted-foreground">
              {Math.floor(pairing.countdown / 60)}:
              {String(pairing.countdown % 60).padStart(2, '0')} 后过期
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              className="cursor-pointer"
              onClick={pairing.copyCommand}
            >
              {pairing.copied ? (
                <Check className="w-3.5 h-3.5 text-emerald-500" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
              {pairing.copied ? '已复制' : '复制配对命令'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={pairing.generate}
              disabled={pairing.generating}
            >
              {pairing.generating && (
                <Loader2 className="size-3.5 animate-spin" />
              )}
              重新生成
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            在 {channelName} 中向 Bot 发送{' '}
            <code className="bg-muted px-1 rounded">/pair {pairing.code}</code>{' '}
            完成配对
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          <Button
            variant="outline"
            onClick={pairing.generate}
            disabled={pairing.generating}
          >
            {pairing.generating && <Loader2 className="size-4 animate-spin" />}
            生成配对码
          </Button>
          <p className="text-xs text-muted-foreground">
            生成一次性配对码，在 {channelName} 聊天中发送{' '}
            <code className="bg-muted px-1 rounded">/pair &lt;code&gt;</code>{' '}
            将聊天绑定到此账号
          </p>
        </div>
      )}

      {/* Paired chats list */}
      <div className="mt-4">
        <div className="flex items-center justify-between mb-2">
          <h5 className="text-xs font-medium text-muted-foreground">
            已配对的聊天
          </h5>
          <button
            type="button"
            onClick={() => paired.load()}
            disabled={paired.loading}
            className="min-h-9 rounded px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
            aria-label={`刷新 ${channelName} 已配对聊天`}
          >
            {paired.loading ? '加载中…' : '刷新'}
          </button>
        </div>
        {paired.error && (
          <p role="alert" className="mb-2 text-xs text-error">
            {paired.error}
          </p>
        )}
        {paired.loading ? (
          <div className="text-xs text-muted-foreground">加载中...</div>
        ) : paired.chats.length === 0 ? (
          <div className="text-xs text-muted-foreground">暂无已配对的聊天</div>
        ) : (
          <div className="space-y-2">
            {paired.chats.map((chat) => (
              <div
                key={chat.jid}
                className="flex items-center gap-3 rounded-lg bg-muted px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-foreground">
                    {chat.name}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {new Date(chat.addedAt).toLocaleString('zh-CN')}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="shrink-0 text-error hover:text-error"
                  disabled={paired.removingJid === chat.jid}
                  onClick={() => {
                    if (
                      window.confirm(
                        `解除「${chat.name}」与这个 ${channelName} 账号的配对？`,
                      )
                    )
                      paired.remove(chat.jid);
                  }}
                  aria-label={`解除配对 ${chat.name}`}
                >
                  {paired.removingJid === chat.jid ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="size-3.5" />
                  )}
                </Button>
              </div>
            ))}
            <RouterLink
              to="/settings?tab=my-channels&view=bindings"
              className="inline-flex min-h-9 items-center gap-1.5 text-xs font-medium text-primary hover:underline"
            >
              到“已接入会话”管理路由、响应方式和删除
              <ArrowRight className="size-3.5" />
            </RouterLink>
          </div>
        )}
      </div>
    </div>
  );
}
