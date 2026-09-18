import { lazy, Suspense, useCallback, useMemo, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { Menu } from 'lucide-react';
import { toast } from 'sonner';

import { useAuthStore } from '../stores/auth';
import { SettingsNav } from '../components/settings/SettingsNav';
import { ClaudeProviderSection } from '../components/settings/ClaudeProviderSection';
import { RegistrationSection } from '../components/settings/RegistrationSection';
import { ProfileSection } from '../components/settings/ProfileSection';
import { PreferencesSection } from '../components/settings/PreferencesSection';
import { SecuritySection } from '../components/settings/SecuritySection';
import { AboutSection } from '../components/settings/AboutSection';
import { AppearanceSection } from '../components/settings/AppearanceSection';
import { MainAgentIdentitySection } from '../components/settings/MainAgentIdentitySection';
import { MainAgentCapabilitiesSection } from '../components/settings/MainAgentCapabilitiesSection';
import {
  HostIntegrationSettingsSection,
  SystemSettingsSection,
} from '../components/settings/SystemSettingsSection';
import { UserChannelsSection } from '../components/settings/UserChannelsSection';
import { UsersPage } from './UsersPage';
import { MonitorPage } from './MonitorPage';
import type { SettingsTab } from '../components/settings/types';

const BillingPage = lazy(() => import('./BillingPage'));

const VALID_TABS: SettingsTab[] = [
  'claude',
  'registration',
  'appearance',
  'system',
  'main-agent',
  'host-integration',
  'billing',
  'profile',
  'preferences',
  'my-channels',
  'security',
  'groups',
  'agent-profiles',
  'memory',
  'skills',
  'mcp-servers',
  'plugins',
  'users',
  'about',
  'bindings',
  'usage',
  'monitor',
];
const SYSTEM_TABS: SettingsTab[] = [
  'claude',
  'registration',
  'appearance',
  'system',
  'main-agent',
  'host-integration',
];
const FULLPAGE_TABS: SettingsTab[] = ['users', 'monitor', 'billing'];

const LEGACY_TAB_ROUTES: Partial<Record<SettingsTab, string>> = {
  groups: '/chat',
  'agent-profiles': '/agent-profiles',
  memory: '/memory',
  skills: '/capabilities/skills',
  'mcp-servers': '/capabilities/mcp',
  plugins: '/capabilities/plugins',
  bindings: '/settings?tab=my-channels&view=bindings',
  usage: '/usage',
};

export function SettingsPage() {
  const { user: currentUser } = useAuthStore();
  const hasBillingPermission = useAuthStore((state) =>
    state.hasPermission('manage_billing'),
  );
  const [searchParams, setSearchParams] = useSearchParams();
  const [navOpen, setNavOpen] = useState(false);

  const hasSystemConfigPermission =
    currentUser?.role === 'admin' ||
    !!currentUser?.permissions.includes('manage_system_config');
  const mustChangePassword = !!currentUser?.must_change_password;
  const canManageSystemConfig =
    hasSystemConfigPermission && !mustChangePassword;
  const canManageBilling = hasBillingPermission && !mustChangePassword;
  const canManageUsers =
    currentUser?.role === 'admin' ||
    !!currentUser?.permissions.includes('manage_users') ||
    !!currentUser?.permissions.includes('manage_invites') ||
    !!currentUser?.permissions.includes('view_audit_log');

  const defaultTab: SettingsTab = canManageSystemConfig ? 'claude' : 'profile';
  const rawTabValue = searchParams.get('tab');
  // Keep bookmarks and already-open tabs from the retired automation page on
  // the closest remaining settings surface instead of falling back to models.
  const rawTab = (
    rawTabValue === 'automation' ? 'system' : rawTabValue
  ) as SettingsTab | null;

  const activeTab = useMemo((): SettingsTab => {
    if (mustChangePassword) return 'security';
    const raw = rawTab;
    if (raw && VALID_TABS.includes(raw)) {
      if (SYSTEM_TABS.includes(raw) && !canManageSystemConfig)
        return defaultTab;
      if (
        (raw === 'main-agent' || raw === 'host-integration') &&
        currentUser?.role !== 'admin'
      ) {
        return defaultTab;
      }
      if (raw === 'monitor' && !canManageSystemConfig) return defaultTab;
      if (raw === 'billing' && !canManageBilling) return defaultTab;
      if (raw === 'users' && !canManageUsers) return defaultTab;
      return raw;
    }
    return defaultTab;
  }, [
    rawTab,
    canManageSystemConfig,
    canManageUsers,
    canManageBilling,
    mustChangePassword,
    defaultTab,
    currentUser?.role,
  ]);

  const handleTabChange = useCallback(
    (tab: SettingsTab) => {
      setNavOpen(false);
      setSearchParams({ tab }, { replace: true });
    },
    [setSearchParams],
  );

  const sectionTitle: Record<SettingsTab, string> = {
    claude: '模型配置',
    registration: '注册策略',
    appearance: '常规与品牌',
    system: '运行与容量',
    'main-agent': '主 CommerceAgent',
    'host-integration': '宿主机集成',
    billing: '计费管理',
    profile: '个人资料',
    preferences: '常规',
    'my-channels': '消息渠道',
    security: '安全与设备',
    groups: '会话管理',
    'agent-profiles': '智能体',
    memory: 'Workspace Memory',
    skills: '技能(Skill)管理',
    'mcp-servers': 'MCP 服务器',
    plugins: '插件 (Plugins)',
    users: '用户与访问',
    about: '关于',
    bindings: '渠道绑定',
    usage: '用量统计',
    monitor: '运行状态',
  };

  const sectionDescription: Partial<Record<SettingsTab, string>> = {
    'main-agent':
      '管理主智能体的头像、系统附加能力、宿主机配置继承和上下文压缩策略。',
    'host-integration':
      '管理宿主机 Claude 目录以及共享 Plugin Catalog 的来源。',
  };

  const legacyRoute =
    !mustChangePassword && rawTab ? LEGACY_TAB_ROUTES[rawTab] : undefined;
  if (legacyRoute) return <Navigate to={legacyRoute} replace />;

  return (
    <div
      data-settings-page="true"
      className="min-h-full bg-background lg:flex lg:items-start"
    >
      {/* Mobile header */}
      <div className="lg:hidden sticky top-0 z-10 flex items-center bg-background border-b border-border px-4 h-12">
        <button
          onClick={() => setNavOpen(true)}
          className="-ml-2 flex size-11 items-center justify-center rounded-lg transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          aria-label="打开导航"
        >
          <Menu className="w-5 h-5 text-muted-foreground" />
        </button>
        <span className="ml-3 text-sm font-semibold text-foreground truncate">
          {sectionTitle[activeTab]}
        </span>
      </div>

      <SettingsNav
        activeTab={activeTab}
        onTabChange={handleTabChange}
        canManageSystemConfig={canManageSystemConfig}
        canManageBilling={canManageBilling}
        canManageUsers={!!canManageUsers}
        isAdmin={currentUser?.role === 'admin'}
        mustChangePassword={mustChangePassword}
        open={navOpen}
        onOpenChange={setNavOpen}
      />

      <div data-settings-content="true" className="min-w-0 flex-1">
        {FULLPAGE_TABS.includes(activeTab) ? (
          <>
            {activeTab === 'users' && <UsersPage />}
            {activeTab === 'monitor' && <MonitorPage />}
            {activeTab === 'billing' && (
              <Suspense fallback={null}>
                <BillingPage managementOnly />
              </Suspense>
            )}
          </>
        ) : (
          <div className="px-4 py-6 sm:px-6 lg:px-10 lg:py-8">
            <div className="mx-auto max-w-6xl">
              <header className="mb-6">
                <h1 className="text-2xl font-bold text-foreground">
                  {sectionTitle[activeTab]}
                </h1>
                {sectionDescription[activeTab] && (
                  <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
                    {sectionDescription[activeTab]}
                  </p>
                )}
              </header>

              {mustChangePassword && (
                <div className="mb-6 rounded-xl border border-warning/20 bg-warning-bg px-4 py-3 text-sm text-warning">
                  检测到首次登录或管理员重置密码，请先在“安全与设备”中修改密码；完成前其他设置暂不可用。
                </div>
              )}

              {activeTab === 'system' ? (
                <SystemSettingsSection scope="runtime" />
              ) : activeTab === 'main-agent' ||
                activeTab === 'host-integration' ? (
                <div>
                  {activeTab === 'main-agent' && <MainAgentIdentitySection />}
                  {activeTab === 'main-agent' && (
                    <MainAgentCapabilitiesSection />
                  )}
                  <div className={activeTab === 'main-agent' ? 'pt-6' : ''}>
                    <HostIntegrationSettingsSection
                      scope={activeTab === 'main-agent' ? 'main-agent' : 'host'}
                    />
                  </div>
                </div>
              ) : (
                <>
                  {activeTab === 'claude' && (
                    <ClaudeProviderSection
                      setNotice={(message) => message && toast.success(message)}
                      setError={(message) => message && toast.error(message)}
                    />
                  )}
                  {activeTab === 'registration' && (
                    <div className="space-y-8">
                      <RegistrationSection />
                      <div className="border-t border-border pt-6">
                        <SystemSettingsSection scope="security" />
                      </div>
                    </div>
                  )}
                  {activeTab === 'appearance' && <AppearanceSection />}
                  {activeTab === 'profile' && <ProfileSection />}
                  {activeTab === 'preferences' && <PreferencesSection />}
                  {activeTab === 'my-channels' && <UserChannelsSection />}
                  {activeTab === 'security' && <SecuritySection />}
                  {activeTab === 'about' && <AboutSection />}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
