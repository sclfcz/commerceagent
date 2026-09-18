import { useEffect, useRef, useState } from 'react';
import { Loader2, RotateCcw, Upload } from 'lucide-react';
import { toast } from 'sonner';

import { api, apiFetch } from '../../api/client';
import { useAuthStore, type AppearanceConfig } from '../../stores/auth';
import { EmojiAvatar } from '../common/EmojiAvatar';
import { EmojiPicker } from '../common/EmojiPicker';
import { ColorPicker } from '../common/ColorPicker';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { getErrorMessage } from './types';

const MAX_AVATAR_BYTES = 3 * 1024 * 1024;
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

export function MainAgentIdentitySection() {
  const appearance = useAuthStore((state) => state.appearance);
  const fetchAppearance = useAuthStore((state) => state.fetchAppearance);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [emoji, setEmoji] = useState('🐱');
  const [color, setColor] = useState('#0d9488');
  const [mode, setMode] = useState<'brand' | 'emoji'>('brand');
  const [styleEditorOpen, setStyleEditorOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setAvatarUrl(appearance?.aiAvatarUrl ?? null);
    setEmoji(appearance?.aiAvatarEmoji || '🐱');
    setColor(appearance?.aiAvatarColor || '#0d9488');
    setMode(appearance?.aiAvatarMode || 'brand');
    setStyleEditorOpen(appearance?.aiAvatarMode === 'emoji');
  }, [appearance]);

  const saveFallback = async () => {
    setSaving(true);
    try {
      await api.put<AppearanceConfig>('/api/config/appearance', {
        aiAvatarEmoji: emoji,
        aiAvatarColor: color,
        aiAvatarMode: 'emoji',
      });
      await fetchAppearance();
      setMode('emoji');
      setStyleEditorOpen(true);
      toast.success('主 CommerceAgent 头像已保存');
    } catch (error) {
      toast.error(getErrorMessage(error, '保存头像失败'));
    } finally {
      setSaving(false);
    }
  };

  const upload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > MAX_AVATAR_BYTES) {
      toast.error('图片文件不能超过 3MB');
      return;
    }
    if (!ALLOWED_TYPES.includes(file.type)) {
      toast.error('仅支持 jpg、png、gif、webp 格式');
      return;
    }
    const body = new FormData();
    body.append('avatar', file);
    setUploading(true);
    try {
      const result = await apiFetch<{ avatarUrl: string }>(
        '/api/config/appearance/avatar',
        { method: 'POST', body },
      );
      setAvatarUrl(result.avatarUrl);
      await fetchAppearance();
      setMode('emoji');
      setStyleEditorOpen(true);
      toast.success('主 CommerceAgent 头像已更新');
    } catch (error) {
      toast.error(getErrorMessage(error, '上传头像失败'));
    } finally {
      setUploading(false);
    }
  };

  const restoreBrandAvatar = async () => {
    try {
      if (avatarUrl) await api.delete('/api/config/appearance/avatar');
      await api.put<AppearanceConfig>('/api/config/appearance', {
        aiAvatarMode: 'brand',
      });
      setAvatarUrl(null);
      setMode('brand');
      setStyleEditorOpen(false);
      await fetchAppearance();
      toast.success('已恢复 CommerceAgent 默认头像');
    } catch (error) {
      toast.error(getErrorMessage(error, '恢复默认头像失败'));
    }
  };

  const removeImage = async () => {
    try {
      await api.delete('/api/config/appearance/avatar');
      setAvatarUrl(null);
      await fetchAppearance();
      toast.success('已改用 Emoji 头像');
    } catch (error) {
      toast.error(getErrorMessage(error, '移除头像失败'));
    }
  };

  return (
    <section className="space-y-4 border-b border-border pb-6">
      <div>
        <h3 className="text-sm font-semibold text-foreground">头像</h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          这是全局主 CommerceAgent 的头像。未单独设置头像的自定义智能体
          会自动继承它。
        </p>
      </div>

      <div className="flex items-center gap-4">
        <EmojiAvatar
          imageUrl={
            avatarUrl ||
            (mode === 'brand'
              ? `${import.meta.env.BASE_URL}icons/commerceagent-icon.png`
              : undefined)
          }
          emoji={mode === 'emoji' ? emoji : undefined}
          color={mode === 'emoji' ? color : undefined}
          fallbackChar="H"
          size="lg"
          className="!h-14 !w-14 !text-2xl"
        />
        <div className="flex flex-wrap gap-2">
          <input
            ref={inputRef}
            type="file"
            accept={ALLOWED_TYPES.join(',')}
            className="hidden"
            onChange={upload}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={uploading}
            onClick={() => inputRef.current?.click()}
          >
            {uploading ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Upload className="size-3.5" />
            )}
            上传图片
          </Button>
          {!styleEditorOpen && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setStyleEditorOpen(true)}
            >
              使用 Emoji
            </Button>
          )}
          {avatarUrl && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={removeImage}
            >
              <RotateCcw className="size-3.5" />
              改用 Emoji
            </Button>
          )}
          {(avatarUrl || mode === 'emoji') && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={restoreBrandAvatar}
            >
              <RotateCcw className="size-3.5" />
              恢复默认头像
            </Button>
          )}
        </div>
      </div>

      {styleEditorOpen && (
        <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label className="mb-1.5 text-xs text-muted-foreground">
                Emoji
              </Label>
              <EmojiPicker value={emoji} onChange={setEmoji} />
            </div>
            <div>
              <Label className="mb-1.5 text-xs text-muted-foreground">
                背景色
              </Label>
              <ColorPicker value={color} onChange={setColor} />
            </div>
          </div>

          <Button
            type="button"
            size="sm"
            onClick={saveFallback}
            disabled={saving}
          >
            {saving && <Loader2 className="size-3.5 animate-spin" />}
            保存 Emoji 头像
          </Button>
        </div>
      )}
    </section>
  );
}
