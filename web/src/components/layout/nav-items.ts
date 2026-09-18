import {
  MessageCircle,
  Clock4,
  Bot,
  Puzzle,
  BarChart3,
  Wallet,
  Settings,
} from 'lucide-react';

interface NavItem {
  path: string;
  icon: typeof MessageCircle;
  label: string;
  requiresBilling?: boolean;
  hideOnMobile?: boolean;
}

export const baseNavItems: NavItem[] = [
  { path: '/chat', icon: MessageCircle, label: '运营工作台' },
  { path: '/agent-profiles', icon: Bot, label: '运营智能体' },
  { path: '/capabilities', icon: Puzzle, label: '运营能力' },
  { path: '/tasks', icon: Clock4, label: '任务中心' },
  { path: '/usage', icon: BarChart3, label: '数据分析', hideOnMobile: true },
  { path: '/billing', icon: Wallet, label: '费用中心', requiresBilling: true },
  { path: '/settings', icon: Settings, label: '系统设置' },
];

export function filterNavItems(billingEnabled: boolean) {
  return baseNavItems.filter((item) => !item.requiresBilling || billingEnabled);
}
