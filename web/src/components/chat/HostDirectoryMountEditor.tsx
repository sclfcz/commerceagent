import { useId } from 'react';
import { FolderSymlink, LockKeyhole, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { AdditionalMountInput } from '../../types';
import { DirectoryBrowser } from '../shared/DirectoryBrowser';

export const MAX_HOST_DIRECTORY_MOUNTS = 8;
export const CONTAINER_MOUNT_ROOT = '/workspace/extra/';
const RESERVED_CONTAINER_SUFFIX_COMPONENTS = new Set(['.npm-global']);

let mountDraftSequence = 0;

export interface HostDirectoryMountDraft {
  id: string;
  hostPath: string;
  containerPath: string;
  containerPathTouched: boolean;
}

export function createHostDirectoryMountDraft(): HostDirectoryMountDraft {
  mountDraftSequence += 1;
  return {
    id: `host-mount-${mountDraftSequence}`,
    hostPath: '',
    containerPath: '',
    containerPathTouched: false,
  };
}

function basename(directoryPath: string): string {
  return (
    directoryPath.replace(/\/+$/, '').split('/').filter(Boolean).at(-1) ?? ''
  );
}

function isSafeContainerSuffix(value: string): boolean {
  if (!value || value.startsWith('/') || value.endsWith('/')) return false;
  if (
    value.length > 512 ||
    value.includes('\\') ||
    value.includes(':') ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return false;
  }
  const segments = value.split('/');
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      segment !== '.' &&
      segment !== '..' &&
      !RESERVED_CONTAINER_SUFFIX_COMPONENTS.has(segment),
  );
}

export function validateHostDirectoryMounts(
  mounts: HostDirectoryMountDraft[],
): Record<string, string> {
  const errors: Record<string, string> = {};
  const targets = new Map<string, number>();
  if (mounts.length > MAX_HOST_DIRECTORY_MOUNTS) {
    errors.additional_mounts = `最多只能挂载 ${MAX_HOST_DIRECTORY_MOUNTS} 个宿主机目录`;
  }

  mounts.forEach((mount, index) => {
    const hostPath = mount.hostPath.trim();
    const containerPath = mount.containerPath.trim();
    if (!hostPath) {
      errors[`additional_mounts.${index}.host_path`] =
        '请选择 CommerceAgent 服务器上的宿主机目录';
    } else if (!hostPath.startsWith('/')) {
      errors[`additional_mounts.${index}.host_path`] =
        '宿主机目录必须是服务器上的绝对路径';
    }

    if (!containerPath) {
      errors[`additional_mounts.${index}.container_path`] = '请输入容器内目录';
    } else if (!isSafeContainerSuffix(containerPath)) {
      errors[`additional_mounts.${index}.container_path`] =
        '请输入安全的相对路径，不能以 / 开头、以 / 结尾或包含 .、..、反斜杠、冒号及运行时保留目录';
    } else {
      const existingIndex = targets.get(containerPath);
      if (existingIndex !== undefined) {
        errors[`additional_mounts.${existingIndex}.container_path`] =
          '容器内目录不能重复';
        errors[`additional_mounts.${index}.container_path`] =
          '容器内目录不能重复';
      } else {
        targets.set(containerPath, index);
      }
    }
  });

  const validTargets = Array.from(targets.entries());
  for (let first = 0; first < validTargets.length; first += 1) {
    const [firstTarget, firstIndex] = validTargets[first];
    for (let second = first + 1; second < validTargets.length; second += 1) {
      const [secondTarget, secondIndex] = validTargets[second];
      const nested =
        firstTarget.startsWith(`${secondTarget}/`) ||
        secondTarget.startsWith(`${firstTarget}/`);
      if (!nested) continue;
      errors[`additional_mounts.${firstIndex}.container_path`] =
        '容器内目录不能与另一个挂载目录相互嵌套';
      errors[`additional_mounts.${secondIndex}.container_path`] =
        '容器内目录不能与另一个挂载目录相互嵌套';
    }
  }

  return errors;
}

export function toAdditionalMountInputs(
  mounts: HostDirectoryMountDraft[],
): AdditionalMountInput[] {
  return mounts.map((mount) => ({
    host_path: mount.hostPath.trim(),
    container_path: mount.containerPath.trim(),
    readonly: true,
  }));
}

interface HostDirectoryMountEditorProps {
  mounts: HostDirectoryMountDraft[];
  onChange: (mounts: HostDirectoryMountDraft[]) => void;
  fieldErrors?: Record<string, string>;
  disabled?: boolean;
}

export function HostDirectoryMountEditor({
  mounts,
  onChange,
  fieldErrors = {},
  disabled = false,
}: HostDirectoryMountEditorProps) {
  const headingId = useId();
  const mountListError = fieldErrors.additional_mounts;

  const updateMount = (
    index: number,
    update: Partial<HostDirectoryMountDraft>,
  ) => {
    onChange(
      mounts.map((mount, mountIndex) =>
        mountIndex === index ? { ...mount, ...update } : mount,
      ),
    );
  };

  const removeMount = (index: number) => {
    onChange(mounts.filter((_, mountIndex) => mountIndex !== index));
  };

  const addMount = () => {
    if (mounts.length >= MAX_HOST_DIRECTORY_MOUNTS) return;
    onChange([...mounts, createHostDirectoryMountDraft()]);
  };

  return (
    <section aria-labelledby={headingId} className="space-y-3 pt-1">
      <div className="flex items-start gap-2">
        <FolderSymlink className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <h3 id={headingId} className="text-sm font-medium text-foreground">
            宿主机目录挂载
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            仅管理员可用。选择 CommerceAgent/Docker
            服务器上的目录，并实时挂载到容器；这不是复制，源目录后续变化会直接反映到容器中。
          </p>
        </div>
      </div>
      {mountListError && (
        <p className="text-xs text-error" role="alert">
          {mountListError}
        </p>
      )}

      {mounts.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-3 py-4">
          <p className="text-xs leading-5 text-muted-foreground">
            当前不挂载额外目录。添加后，目录会出现在
            <code className="mx-1 rounded bg-muted px-1 py-0.5 text-[11px]">
              /workspace/extra/
            </code>
            下，并固定为只读。
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addMount}
            disabled={disabled}
            className="mt-3 h-10"
          >
            <Plus className="h-4 w-4" />
            添加宿主机目录
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {mounts.map((mount, index) => {
            const hostError =
              fieldErrors[`additional_mounts.${index}.host_path`];
            const containerError =
              fieldErrors[`additional_mounts.${index}.container_path`];
            const containerInputId = `${mount.id}-container-path`;
            const containerErrorId = `${containerInputId}-error`;
            return (
              <fieldset
                key={mount.id}
                className="space-y-3 rounded-lg border border-border bg-background p-3"
                disabled={disabled}
              >
                <legend className="sr-only">宿主机目录挂载 {index + 1}</legend>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-foreground">
                    挂载目录 {index + 1}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <span className="inline-flex min-h-7 items-center gap-1 rounded-md bg-muted px-2 text-[11px] font-medium text-muted-foreground">
                      <LockKeyhole className="h-3 w-3" />
                      固定只读
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => removeMount(index)}
                      className="h-10 w-10 text-muted-foreground hover:text-destructive"
                      aria-label={`删除挂载目录 ${index + 1}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                <DirectoryBrowser
                  value={mount.hostPath}
                  onChange={(nextPath, source) => {
                    const nextUpdate: Partial<HostDirectoryMountDraft> = {
                      hostPath: nextPath,
                    };
                    if (
                      (source === 'browser' || source === 'created') &&
                      !mount.containerPathTouched
                    ) {
                      nextUpdate.containerPath = basename(nextPath);
                    }
                    updateMount(index, nextUpdate);
                  }}
                  inputId={`${mount.id}-host-path`}
                  label="宿主机目录"
                  description="这里浏览的是 CommerceAgent/Docker 服务器目录，不是当前浏览器设备上的文件夹。"
                  placeholder="/srv/projects/example"
                  purpose="mount"
                  allowCreateFolder={false}
                  disabled={disabled}
                />
                {hostError && (
                  <p className="text-xs text-error" role="alert">
                    {hostError}
                  </p>
                )}

                <div>
                  <Label htmlFor={containerInputId} className="mb-1.5">
                    容器内目录
                  </Label>
                  <div className="flex min-w-0 items-stretch">
                    <span className="inline-flex h-10 flex-shrink-0 items-center rounded-l-lg border border-r-0 border-input bg-muted px-2 text-xs text-muted-foreground">
                      {CONTAINER_MOUNT_ROOT}
                    </span>
                    <Input
                      id={containerInputId}
                      value={mount.containerPath}
                      onChange={(event) =>
                        updateMount(index, {
                          containerPath: event.target.value,
                          containerPathTouched: true,
                        })
                      }
                      placeholder="project-data"
                      className="h-10 min-w-0 rounded-l-none"
                      aria-invalid={!!containerError}
                      aria-describedby={
                        containerError ? containerErrorId : undefined
                      }
                      autoComplete="off"
                    />
                  </div>
                  <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
                    只能填写
                    <code className="mx-1 rounded bg-muted px-1 py-0.5">
                      /workspace/extra/
                    </code>
                    下的相对路径。
                  </p>
                  {containerError && (
                    <p
                      id={containerErrorId}
                      className="mt-1 text-xs text-error"
                      role="alert"
                    >
                      {containerError}
                    </p>
                  )}
                </div>
              </fieldset>
            );
          })}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addMount}
              disabled={disabled || mounts.length >= MAX_HOST_DIRECTORY_MOUNTS}
              className="h-10"
            >
              <Plus className="h-4 w-4" />
              添加另一个目录
            </Button>
            <span className="text-xs text-muted-foreground" aria-live="polite">
              {mounts.length} / {MAX_HOST_DIRECTORY_MOUNTS}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
