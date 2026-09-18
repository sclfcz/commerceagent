export const ACTIVATION_MODE_OPTIONS = [
  { value: 'always', label: '响应允许成员的所有消息' },
  { value: 'when_mentioned', label: '仅在 @机器人时响应' },
  { value: 'owner_mentioned', label: '仅在所有者 @机器人时响应' },
  { value: 'auto', label: '沿用该群默认设置' },
  { value: 'disabled', label: '暂停响应' },
] as const;

export const AUDIENCE_MODE_OPTIONS = [
  { value: 'everyone', label: '响应所有人' },
  { value: 'owner_only', label: '仅响应主人' },
] as const;
