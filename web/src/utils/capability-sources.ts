import type { CapabilityLayerSource } from '../types';

const SOURCE_LABELS: Record<CapabilityLayerSource, string> = {
  builtin: '内置',
  host: '宿主机',
  project: '系统强制',
  workspace: '工作区项目',
  plugin: '插件',
  managed: '系统附加',
  system: '系统 MCP',
  user: '我的 MCP',
};

export function capabilitySourceLabel(source: CapabilityLayerSource): string {
  return SOURCE_LABELS[source];
}
