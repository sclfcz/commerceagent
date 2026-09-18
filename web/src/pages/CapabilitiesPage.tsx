import { NavLink, Navigate, useParams } from 'react-router-dom';
import { Plug, Puzzle, Server } from 'lucide-react';

import { McpServersPage } from './McpServersPage';
import { PluginsPage } from './PluginsPage';
import { SkillsPage } from './SkillsPage';

const sections = [
  { key: 'skills', label: 'Skills', icon: Puzzle },
  { key: 'mcp', label: 'MCP', icon: Server },
  { key: 'plugins', label: 'Plugins', icon: Plug },
] as const;

export function CapabilitiesPage() {
  const { section } = useParams<{ section?: string }>();
  if (!section) return <Navigate to="/capabilities/skills" replace />;
  if (!sections.some((item) => item.key === section)) {
    return <Navigate to="/capabilities/skills" replace />;
  }

  return (
    <div className="min-h-full bg-background">
      <div className="sticky top-0 z-20 border-b border-border bg-background/95 px-4 py-3 backdrop-blur lg:px-6">
        <div className="mx-auto flex max-w-7xl items-center gap-2">
          <span className="mr-2 text-sm font-semibold text-foreground">
            能力库
          </span>
          {sections.map(({ key, label, icon: Icon }) => (
            <NavLink
              key={key}
              to={`/capabilities/${key}`}
              className={({ isActive }) =>
                `inline-flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                  isActive
                    ? 'bg-brand-50 font-medium text-primary'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                }`
              }
            >
              <Icon className="size-4" />
              {label}
            </NavLink>
          ))}
        </div>
      </div>

      <div className="border-b border-border/70 bg-muted/30 px-4 py-2.5 lg:px-6">
        <p className="mx-auto max-w-7xl text-xs leading-5 text-muted-foreground">
          在这里安装和管理可复用资源；到具体智能体的“能力配置”中决定是否启用。
          工作区自带的 CLAUDE.md、.claude/skills 与项目 MCP 不在这里分配。
        </p>
      </div>

      {section === 'skills' && <SkillsPage />}
      {section === 'mcp' && <McpServersPage />}
      {section === 'plugins' && <PluginsPage />}
    </div>
  );
}
