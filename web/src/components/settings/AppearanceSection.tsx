import { useEffect, useState } from 'react';
import { AppWindow, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { useAuthStore } from '../../stores/auth';
import { api } from '../../api/client';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { getErrorMessage } from './types';
import { SettingsCard as Section } from './SettingsCard';
import type { AppearanceConfig } from '../../stores/auth';

export function AppearanceSection() {
  const { hasPermission } = useAuthStore();

  const [appName, setAppName] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const canManage = hasPermission('manage_system_config');

  useEffect(() => {
    if (!canManage) {
      setLoading(false);
      return;
    }
    (async () => {
      setLoading(true);
      try {
        const data = await api.get<AppearanceConfig>('/api/config/appearance');
        setAppName(data.appName);
      } catch (err) {
        toast.error(getErrorMessage(err, '加载外观配置失败'));
      } finally {
        setLoading(false);
      }
    })();
  }, [canManage]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const data = await api.put<AppearanceConfig>('/api/config/appearance', {
        appName: appName.trim(),
      });
      setAppName(data.appName);
      useAuthStore.setState({ appearance: data });
      toast.success('外观设置已保存');
    } catch (err) {
      toast.error(getErrorMessage(err, '保存外观设置失败'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!canManage) {
    return (
      <div className="text-sm text-muted-foreground">
        需要系统配置权限才能修改全局外观设置。
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground bg-muted rounded-lg px-4 py-3">
        系统品牌只影响站点标题和欢迎文案，不会改变 CommerceAgent 或自定义智能体
        的名称。
      </p>

      <Section
        icon={AppWindow}
        title="站点名称"
        desc="显示在浏览器标题和欢迎页面中"
      >
        <div>
          <Label
            htmlFor="system-brand-name"
            className="text-xs text-muted-foreground mb-1"
          >
            名称
          </Label>
          <Input
            id="system-brand-name"
            type="text"
            value={appName}
            onChange={(e) => setAppName(e.target.value)}
            maxLength={32}
            placeholder="CommerceAgent"
          />
        </div>
      </Section>

      <Button
        onClick={handleSave}
        disabled={saving || !appName.trim()}
        className="w-full sm:w-auto"
      >
        {saving && <Loader2 className="size-4 animate-spin" />}
        保存系统品牌
      </Button>
    </div>
  );
}
