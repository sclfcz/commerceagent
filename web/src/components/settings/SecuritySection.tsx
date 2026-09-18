import { useCallback, useEffect, useState } from 'react';
import {
  KeyRound,
  Loader2,
  LogOut,
  RefreshCw,
  Shield,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '../../api/client';
import { useAuthStore } from '../../stores/auth';
import { SettingsCard as Section } from './SettingsCard';
import { getErrorMessage, type SessionInfo } from './types';

export function SecuritySection() {
  const { logout, changePassword } = useAuthStore();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const loadSessions = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await api.get<{ sessions: SessionInfo[] }>(
        '/api/auth/sessions',
      );
      setSessions(data.sessions);
    } catch (error) {
      setLoadError(
        getErrorMessage(error, '无法加载登录设备，请检查网络后重试。'),
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  const handleChangePassword = async () => {
    setChangingPassword(true);
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      toast.success('密码已修改，其他设备的登录会话已撤销');
      void loadSessions();
    } catch (error) {
      toast.error(getErrorMessage(error, '修改密码失败'));
    } finally {
      setChangingPassword(false);
    }
  };

  const handleRevoke = async (shortId: string) => {
    if (!confirm('撤销这台设备的登录会话？该设备需要重新登录。')) return;
    setRevokingId(shortId);
    try {
      await api.delete(`/api/auth/sessions/${encodeURIComponent(shortId)}`);
      toast.success('设备会话已撤销');
      await loadSessions();
    } catch (error) {
      toast.error(getErrorMessage(error, '撤销设备会话失败'));
    } finally {
      setRevokingId(null);
    }
  };

  const handleLogout = () => {
    if (confirm('退出当前账户？')) void logout();
  };

  return (
    <div className="space-y-4">
      <Section
        icon={KeyRound}
        title="修改密码"
        desc="修改后会撤销其他设备的登录状态，当前设备保持登录"
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label
              htmlFor="current-password"
              className="mb-1 text-xs text-muted-foreground"
            >
              当前密码
            </Label>
            <Input
              id="current-password"
              type="password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              autoComplete="current-password"
            />
          </div>
          <div>
            <Label
              htmlFor="new-password"
              className="mb-1 text-xs text-muted-foreground"
            >
              新密码
            </Label>
            <Input
              id="new-password"
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              placeholder="至少 8 位"
              autoComplete="new-password"
            />
          </div>
        </div>
        <Button
          onClick={handleChangePassword}
          disabled={
            changingPassword || !currentPassword || newPassword.length < 8
          }
          size="sm"
        >
          {changingPassword && <Loader2 className="size-4 animate-spin" />}
          修改密码
        </Button>
      </Section>

      <Section
        icon={Shield}
        title="登录设备"
        desc="查看并撤销当前账户在其他设备上的会话"
      >
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            onClick={loadSessions}
            disabled={loading}
          >
            <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />
            刷新
          </Button>
        </div>

        {loadError ? (
          <div
            role="alert"
            className="rounded-lg border border-error/20 bg-error-bg px-4 py-3"
          >
            <p className="text-sm text-error">{loadError}</p>
            <Button
              className="mt-2"
              variant="outline"
              size="sm"
              onClick={loadSessions}
            >
              重新加载
            </Button>
          </div>
        ) : loading && sessions.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            正在加载登录设备…
          </div>
        ) : sessions.length === 0 ? (
          <div className="py-6 text-center text-sm text-muted-foreground">
            没有可显示的设备会话
          </div>
        ) : (
          <div className="divide-y divide-border">
            {sessions.map((session) => (
              <div
                key={session.shortId}
                className="flex min-w-0 items-center justify-between gap-3 py-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="max-w-xs truncate text-foreground">
                      {session.user_agent?.split(' ').slice(0, 3).join(' ') ||
                        '未知设备'}
                    </span>
                    {session.is_current && (
                      <span className="rounded bg-success-bg px-1.5 py-0.5 text-xs text-success">
                        当前设备
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    IP：{session.ip_address || '未知'} · 最后活跃：
                    {new Date(session.last_active_at).toLocaleString('zh-CN')}
                  </div>
                </div>
                {!session.is_current && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={revokingId === session.shortId}
                    onClick={() => handleRevoke(session.shortId)}
                    aria-label="撤销该设备会话"
                    title="撤销该设备会话"
                    className="shrink-0 text-muted-foreground hover:text-error"
                  >
                    {revokingId === session.shortId ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Trash2 className="size-4" />
                    )}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section
        icon={LogOut}
        title="退出登录"
        desc="退出当前设备，不影响其他设备"
      >
        <Button
          type="button"
          variant="outline"
          onClick={handleLogout}
          className="text-error"
        >
          <LogOut className="size-4" />
          退出当前设备
        </Button>
      </Section>
    </div>
  );
}
