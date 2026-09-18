import { useState } from 'react';
import {
  Loader2,
  Search,
  ExternalLink,
  Download,
  ChevronDown,
  ChevronUp,
  GitBranch,
  FileArchive,
  Package,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useSkillsStore, type SearchResult } from '@/stores/skills';
import { MarkdownRenderer } from '../chat/MarkdownRenderer';

interface InstallSkillDialogProps {
  open: boolean;
  onClose: () => void;
  onInstall: (pkg: string) => Promise<void>;
  onImportGit: (options: {
    url: string;
    ref?: string;
    subdirectory?: string;
    replace?: boolean;
  }) => Promise<string[]>;
  onImportArchive: (file: File, replace?: boolean) => Promise<string[]>;
  installing: boolean;
}

type Tab = 'search' | 'manual' | 'git' | 'zip';

function formatInstalls(n?: number): string {
  if (n === undefined || n === null) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function SearchResultItem({
  result,
  isInstalling,
  installingPkg,
  onInstall,
}: {
  result: SearchResult;
  isInstalling: boolean;
  installingPkg: string | null;
  onInstall: (result: SearchResult) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { searchDetails, searchDetailLoading, fetchSearchDetail } =
    useSkillsStore();

  const key = result.package;
  const detail = searchDetails[key];
  const loading = searchDetailLoading[key];

  const handleToggle = () => {
    if (!expanded && !(key in searchDetails)) {
      fetchSearchDetail(result);
    }
    setExpanded(!expanded);
  };

  const installCount = formatInstalls(result.installs);

  return (
    <div className="rounded-lg border border-border hover:bg-muted/50 transition-colors overflow-hidden">
      <div className="flex items-center justify-between p-3">
        <button
          type="button"
          className="min-w-0 flex-1 text-left flex items-center gap-2"
          onClick={handleToggle}
        >
          {expanded ? (
            <ChevronUp className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <div className="min-w-0 flex-1">
            <span className="text-sm font-medium text-foreground truncate block">
              {result.package}
            </span>
            {installCount && (
              <span className="text-xs text-muted-foreground">
                {installCount} 次安装
              </span>
            )}
          </div>
        </button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => onInstall(result)}
          disabled={isInstalling}
          className="ml-3 shrink-0"
        >
          {installingPkg === result.package ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Download className="size-3.5" />
          )}
          <span className="ml-1">安装</span>
        </Button>
      </div>

      {expanded && (
        <div className="px-3 pb-3 pt-0 border-t border-border/50">
          {loading && (
            <div className="flex items-center gap-2 py-3 text-muted-foreground text-xs">
              <Loader2 className="size-3 animate-spin" />
              加载详情...
            </div>
          )}

          {!loading && detail && (
            <div className="space-y-2 pt-2">
              {detail.description && (
                <p className="text-xs text-foreground/80 leading-relaxed">
                  {detail.description}
                </p>
              )}

              {detail.readme && (
                <div className="mt-2 border border-border/50 rounded-md p-3 max-h-64 overflow-y-auto bg-muted/30">
                  <MarkdownRenderer content={detail.readme} variant="docs" />
                </div>
              )}

              {!detail.readme &&
                detail.features &&
                detail.features.length > 0 && (
                  <ul className="space-y-0.5">
                    {detail.features.map((f, i) => (
                      <li
                        key={i}
                        className="text-xs text-muted-foreground flex gap-1.5"
                      >
                        <span className="text-primary/60 shrink-0">-</span>
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>
                )}
            </div>
          )}

          {!loading && detail === null && (
            <p className="text-xs text-muted-foreground py-2">无法加载详情</p>
          )}

          {result.url && (
            <a
              href={result.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-muted-foreground hover:text-primary inline-flex items-center gap-1 mt-2"
            >
              在 skills.sh 查看
              <ExternalLink className="size-3" />
            </a>
          )}
        </div>
      )}
    </div>
  );
}

export function InstallSkillDialog({
  open,
  onClose,
  onInstall,
  onImportGit,
  onImportArchive,
  installing,
}: InstallSkillDialogProps) {
  const [tab, setTab] = useState<Tab>('search');
  const [pkg, setPkg] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [installingPkg, setInstallingPkg] = useState<string | null>(null);
  const [gitUrl, setGitUrl] = useState('');
  const [gitRef, setGitRef] = useState('');
  const [gitSubdirectory, setGitSubdirectory] = useState('');
  const [archive, setArchive] = useState<File | null>(null);
  const [replaceExisting, setReplaceExisting] = useState(false);

  const { searching, searchResults, searchSkills } = useSkillsStore();

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = searchQuery.trim();
    if (!trimmed) return;
    await searchSkills(trimmed);
  };

  const handleInstallFromSearch = async (result: SearchResult) => {
    try {
      setInstallingPkg(result.package);
      await onInstall(result.package);
      setInstallingPkg(null);
      onClose();
    } catch (err) {
      setInstallingPkg(null);
      toast.error(err instanceof Error ? err.message : '安装失败');
    }
  };

  const handleManualSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = pkg.trim();
    if (!trimmed) {
      toast.error('请输入技能包名称');
      return;
    }

    try {
      await onInstall(trimmed);
      setPkg('');
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '安装失败');
    }
  };

  const handleGitSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!gitUrl.trim()) return;
    try {
      const installed = await onImportGit({
        url: gitUrl.trim(),
        ref: gitRef.trim() || undefined,
        subdirectory: gitSubdirectory.trim() || undefined,
        replace: replaceExisting,
      });
      toast.success(`已导入 ${installed.length} 个技能`);
      handleClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Git 导入失败');
    }
  };

  const handleArchiveSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!archive) return;
    try {
      const installed = await onImportArchive(archive, replaceExisting);
      toast.success(`已导入 ${installed.length} 个技能`);
      handleClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'ZIP 导入失败');
    }
  };

  const handleClose = () => {
    if (!installing) {
      setPkg('');
      setSearchQuery('');
      setInstallingPkg(null);
      setGitUrl('');
      setGitRef('');
      setGitSubdirectory('');
      setArchive(null);
      setReplaceExisting(false);
      onClose();
    }
  };

  const isInstalling = installing || !!installingPkg;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="sm:max-w-lg max-h-[80vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>安装技能</DialogTitle>
        </DialogHeader>

        {/* Tabs */}
        <div
          className="flex overflow-x-auto border-b border-border shrink-0"
          role="tablist"
          aria-label="技能导入方式"
        >
          <button
            type="button"
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === 'search'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => {
              setTab('search');
            }}
            disabled={isInstalling}
            role="tab"
            aria-selected={tab === 'search'}
          >
            <Search className="size-3.5 inline-block mr-1.5 -mt-0.5" />
            搜索市场
          </button>
          <button
            type="button"
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === 'manual'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => {
              setTab('manual');
            }}
            disabled={isInstalling}
            role="tab"
            aria-selected={tab === 'manual'}
          >
            <Package className="size-3.5 inline-block mr-1.5 -mt-0.5" />
            手动安装
          </button>
          <button
            type="button"
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === 'git'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => {
              setTab('git');
            }}
            disabled={isInstalling}
            role="tab"
            aria-selected={tab === 'git'}
          >
            <GitBranch className="size-3.5 inline-block mr-1.5 -mt-0.5" />
            Git
          </button>
          <button
            type="button"
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === 'zip'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => {
              setTab('zip');
            }}
            disabled={isInstalling}
            role="tab"
            aria-selected={tab === 'zip'}
          >
            <FileArchive className="size-3.5 inline-block mr-1.5 -mt-0.5" />
            ZIP
          </button>
        </div>

        {/* Search Tab */}
        {tab === 'search' && (
          <div className="space-y-3 min-h-0 flex flex-col overflow-hidden">
            <form onSubmit={handleSearch} className="flex gap-2 shrink-0">
              <Input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索关键词..."
                disabled={searching || isInstalling}
                className="flex-1"
              />
              <Button
                type="submit"
                variant="outline"
                disabled={searching || isInstalling || !searchQuery.trim()}
              >
                {searching ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Search className="size-4" />
                )}
              </Button>
            </form>

            {/* Results */}
            <div className="overflow-y-auto space-y-2 min-h-0 flex-1">
              {searching && (
                <div className="flex items-center justify-center py-8 text-muted-foreground">
                  <Loader2 className="size-4 animate-spin mr-2" />
                  搜索中...
                </div>
              )}

              {!searching &&
                searchResults.length === 0 &&
                searchQuery.trim() && (
                  <div className="text-center py-8 text-muted-foreground text-sm">
                    未找到相关技能
                  </div>
                )}

              {!searching &&
                searchResults.map((result) => (
                  <SearchResultItem
                    key={result.package}
                    result={result}
                    isInstalling={isInstalling}
                    installingPkg={installingPkg}
                    onInstall={handleInstallFromSearch}
                  />
                ))}
            </div>

            {!searching &&
              searchResults.length === 0 &&
              !searchQuery.trim() && (
                <p className="text-xs text-muted-foreground text-center py-4">
                  在 skills.sh 市场中搜索可用的技能包
                </p>
              )}
          </div>
        )}

        {/* Manual Tab */}
        {tab === 'manual' && (
          <form onSubmit={handleManualSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="skill-pkg"
                className="block text-sm font-medium text-foreground mb-2"
              >
                技能包名称
              </label>
              <Input
                id="skill-pkg"
                type="text"
                value={pkg}
                onChange={(e) => setPkg(e.target.value)}
                placeholder="owner/repo、owner/repo@skill 或 GitHub URL"
                disabled={isInstalling}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                支持格式：owner/repo、owner/repo@skill 或 GitHub URL
              </p>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <Button
                type="button"
                variant="ghost"
                onClick={handleClose}
                disabled={isInstalling}
              >
                取消
              </Button>
              <Button type="submit" disabled={isInstalling || !pkg.trim()}>
                {isInstalling && <Loader2 className="size-4 animate-spin" />}
                安装
              </Button>
            </div>
          </form>
        )}

        {tab === 'git' && (
          <form onSubmit={handleGitSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="skill-git-url"
                className="block text-sm font-medium text-foreground mb-2"
              >
                HTTPS Git 仓库地址
              </label>
              <Input
                id="skill-git-url"
                type="url"
                value={gitUrl}
                onChange={(e) => setGitUrl(e.target.value)}
                placeholder="https://github.com/owner/repo.git"
                disabled={isInstalling}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="skill-git-ref"
                  className="block text-xs font-medium text-muted-foreground mb-1.5"
                >
                  分支或 Tag（可选）
                </label>
                <Input
                  id="skill-git-ref"
                  value={gitRef}
                  onChange={(e) => setGitRef(e.target.value)}
                  placeholder="main"
                  disabled={isInstalling}
                />
              </div>
              <div>
                <label
                  htmlFor="skill-git-subdirectory"
                  className="block text-xs font-medium text-muted-foreground mb-1.5"
                >
                  子目录（可选）
                </label>
                <Input
                  id="skill-git-subdirectory"
                  value={gitSubdirectory}
                  onChange={(e) => setGitSubdirectory(e.target.value)}
                  placeholder="skills/review"
                  disabled={isInstalling}
                />
              </div>
            </div>
            <ReplaceExistingCheckbox
              checked={replaceExisting}
              onChange={setReplaceExisting}
              disabled={isInstalling}
            />
            <DialogActions
              onCancel={handleClose}
              disabled={!gitUrl.trim() || isInstalling}
              loading={isInstalling}
              submitLabel="从 Git 导入"
            />
          </form>
        )}

        {tab === 'zip' && (
          <form onSubmit={handleArchiveSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="skill-archive"
                className="block text-sm font-medium text-foreground mb-2"
              >
                技能 ZIP 文件
              </label>
              <Input
                id="skill-archive"
                type="file"
                accept=".zip,application/zip"
                onChange={(e) => setArchive(e.target.files?.[0] ?? null)}
                disabled={isInstalling}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                最大 10 MB，可包含一个或多个带 SKILL.md 的技能目录。
              </p>
            </div>
            <ReplaceExistingCheckbox
              checked={replaceExisting}
              onChange={setReplaceExisting}
              disabled={isInstalling}
            />
            <DialogActions
              onCancel={handleClose}
              disabled={isInstalling || !archive}
              loading={isInstalling}
              submitLabel="导入 ZIP"
            />
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ReplaceExistingCheckbox({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled: boolean;
}) {
  return (
    <label className="flex items-start gap-2 text-xs text-muted-foreground">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        disabled={disabled}
        className="mt-0.5 size-4 accent-primary"
      />
      <span>覆盖同名用户级技能（默认遇到冲突时停止，不修改现有技能）</span>
    </label>
  );
}

function DialogActions({
  onCancel,
  disabled,
  loading,
  submitLabel,
}: {
  onCancel: () => void;
  disabled: boolean;
  loading: boolean;
  submitLabel: string;
}) {
  return (
    <div className="flex items-center justify-end gap-3 pt-2">
      <Button
        type="button"
        variant="ghost"
        onClick={onCancel}
        disabled={disabled}
      >
        取消
      </Button>
      <Button type="submit" disabled={disabled}>
        {loading && <Loader2 className="size-4 animate-spin" />}
        {submitLabel}
      </Button>
    </div>
  );
}
