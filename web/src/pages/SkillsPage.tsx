import { useEffect, useState, useMemo } from 'react';
import { Plus, RefreshCw, Puzzle, Trash2 } from 'lucide-react';
import { SearchInput } from '@/components/common';
import { PageHeader } from '@/components/common/PageHeader';
import { SkeletonCardList } from '@/components/common/Skeletons';
import { EmptyState } from '@/components/common/EmptyState';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { toast } from 'sonner';
import { useSkillsStore } from '../stores/skills';
import { SkillCard } from '../components/skills/SkillCard';
import { SkillDetail } from '../components/skills/SkillDetail';
import { InstallSkillDialog } from '../components/skills/InstallSkillDialog';

export function SkillsPage() {
  const {
    skills,
    loading,
    error,
    installing,
    loadSkills,
    installSkill,
    importSkillFromGit,
    importSkillArchive,
    deleteAllUserSkills,
  } = useSkillsStore();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showInstallDialog, setShowInstallDialog] = useState(false);
  const [deletingAll, setDeletingAll] = useState(false);
  const [sourceFilter, setSourceFilter] = useState<
    'all' | 'user' | 'project' | 'external'
  >('all');

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  const filtered = useMemo(() => {
    const q = searchQuery.toLowerCase();
    return skills.filter(
      (s) =>
        (sourceFilter === 'all' || s.source === sourceFilter) &&
        (!q ||
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q)),
    );
  }, [skills, searchQuery, sourceFilter]);

  const userSkills = filtered.filter((s) => s.source === 'user');
  const externalSkills = filtered.filter((s) => s.source === 'external');
  const projectSkills = filtered.filter((s) => s.source === 'project');

  const enabledCount = skills.filter((s) => s.enabled).length;

  const handleInstall = async (pkg: string) => {
    await installSkill(pkg);
  };

  return (
    <div className="min-h-full bg-background">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="bg-background border-b border-border px-6 py-4">
          <PageHeader
            title="Skills"
            subtitle={`我的 ${skills.filter((item) => item.source === 'user').length} · CommerceAgent 内置 ${skills.filter((item) => item.source === 'project').length} · 宿主机 ${skills.filter((item) => item.source === 'external').length} · 启用 ${enabledCount}`}
            actions={
              <div className="flex items-center gap-3">
                <Button
                  variant="outline"
                  onClick={loadSkills}
                  disabled={loading}
                >
                  <RefreshCw
                    size={18}
                    className={loading ? 'animate-spin' : ''}
                  />
                  刷新
                </Button>
                <Button onClick={() => setShowInstallDialog(true)}>
                  <Plus size={18} />
                  安装技能
                </Button>
              </div>
            }
          />
        </div>

        <div className="mx-6 mt-4 rounded-lg bg-muted px-4 py-3 text-xs leading-5 text-muted-foreground">
          “我的 Skills”可安装和管理；CommerceAgent 内置与宿主机 Skills 只读。智能体
          可以独立选择不使用、使用部分或使用全部宿主机
          Skills，不必同时继承宿主机 Prompt 或
          Rules。不同来源的同名项会并列显示。
        </div>

        {/* Content */}
        <div className="flex gap-6 p-4">
          {/* 左侧列表 */}
          <div className="w-full lg:w-1/2 xl:w-2/5">
            <div className="mb-4">
              <SearchInput
                value={searchQuery}
                onChange={setSearchQuery}
                placeholder="搜索技能名称或描述"
              />
              <div
                className="mt-3 flex gap-1 overflow-x-auto"
                aria-label="Skill 来源筛选"
              >
                {(
                  [
                    ['all', '全部'],
                    ['user', '我的'],
                    ['project', 'CommerceAgent 内置'],
                    ['external', '宿主机'],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setSourceFilter(value)}
                    className={`shrink-0 rounded-full px-3 py-1.5 text-xs transition-colors ${sourceFilter === value ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-6">
              {loading && skills.length === 0 ? (
                <SkeletonCardList count={3} />
              ) : error ? (
                <Card className="border-error/20">
                  <CardContent className="text-center">
                    <p className="text-error">{error}</p>
                  </CardContent>
                </Card>
              ) : filtered.length === 0 ? (
                <EmptyState
                  icon={Puzzle}
                  title={searchQuery ? '没有找到匹配的技能' : '暂无技能'}
                />
              ) : (
                <>
                  {userSkills.length > 0 && (
                    <div>
                      <div className="flex items-center justify-between mb-3">
                        <h2 className="text-sm font-semibold text-muted-foreground">
                          我的 Skills ({userSkills.length})
                        </h2>
                        <button
                          className="text-xs text-muted-foreground hover:text-error flex items-center gap-1 cursor-pointer"
                          disabled={deletingAll}
                          onClick={async () => {
                            if (
                              !confirm(
                                '确定删除所有用户级技能？宿主机技能不受影响。',
                              )
                            )
                              return;
                            setDeletingAll(true);
                            try {
                              const n = await deleteAllUserSkills();
                              setSelectedId(null);
                              toast.success(`已删除 ${n} 个用户级技能`);
                            } catch {
                              /* handled by store */
                            }
                            setDeletingAll(false);
                          }}
                        >
                          <Trash2 size={12} />
                          {deletingAll ? '删除中...' : '删除全部用户 Skills'}
                        </button>
                      </div>
                      <div className="space-y-2">
                        {userSkills.map((skill) => (
                          <SkillCard
                            key={skill.sourceKey}
                            skill={skill}
                            selected={selectedId === skill.sourceKey}
                            onSelect={() => setSelectedId(skill.sourceKey)}
                          />
                        ))}
                      </div>
                    </div>
                  )}

                  {externalSkills.length > 0 && (
                    <div>
                      <h2 className="text-sm font-semibold text-muted-foreground mb-3">
                        宿主机 Skills ({externalSkills.length})
                      </h2>
                      <div className="space-y-2">
                        {externalSkills.map((skill) => (
                          <SkillCard
                            key={skill.sourceKey}
                            skill={skill}
                            selected={selectedId === skill.sourceKey}
                            onSelect={() => setSelectedId(skill.sourceKey)}
                          />
                        ))}
                      </div>
                    </div>
                  )}

                  {projectSkills.length > 0 && (
                    <div>
                      <h2 className="text-sm font-semibold text-muted-foreground mb-3">
                        CommerceAgent 内置 ({projectSkills.length})
                      </h2>
                      <div className="space-y-2">
                        {projectSkills.map((skill) => (
                          <SkillCard
                            key={skill.sourceKey}
                            skill={skill}
                            selected={selectedId === skill.sourceKey}
                            onSelect={() => setSelectedId(skill.sourceKey)}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {/* 右侧详情（桌面端） */}
          <div className="hidden lg:block lg:w-1/2 xl:w-3/5">
            <SkillDetail
              skillId={selectedId}
              onDeleted={() => setSelectedId(null)}
            />
          </div>
        </div>

        {/* 移动端详情 */}
        {selectedId && (
          <div className="lg:hidden p-4">
            <SkillDetail
              skillId={selectedId}
              onDeleted={() => setSelectedId(null)}
            />
          </div>
        )}
      </div>

      <InstallSkillDialog
        open={showInstallDialog}
        onClose={() => setShowInstallDialog(false)}
        onInstall={handleInstall}
        onImportGit={importSkillFromGit}
        onImportArchive={importSkillArchive}
        installing={installing}
      />
    </div>
  );
}
