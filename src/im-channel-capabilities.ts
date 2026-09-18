export interface ImChannelCapabilities {
  channel_type: string;
  label: string;
  can_bind_workspace: boolean;
  can_bind_session: boolean;
  supports_thread_map: boolean;
  supports_activation_modes: boolean;
  supports_owner_mention: boolean;
  supports_streaming_updates: boolean;
  supports_file_send: boolean;
}

export const IM_CHANNEL_CAPABILITIES: Record<string, ImChannelCapabilities> = {
  feishu: {
    channel_type: 'feishu',
    label: '飞书',
    can_bind_workspace: true,
    can_bind_session: true,
    supports_thread_map: true,
    supports_activation_modes: true,
    supports_owner_mention: true,
    supports_streaming_updates: true,
    supports_file_send: true,
  },
  dingtalk: {
    channel_type: 'dingtalk',
    label: '钉钉',
    can_bind_workspace: true,
    can_bind_session: true,
    supports_thread_map: false,
    supports_activation_modes: true,
    supports_owner_mention: true,
    supports_streaming_updates: true,
    supports_file_send: true,
  },
  telegram: {
    channel_type: 'telegram',
    label: 'Telegram',
    can_bind_workspace: true,
    can_bind_session: true,
    supports_thread_map: true,
    supports_activation_modes: false,
    supports_owner_mention: true,
    supports_streaming_updates: false,
    supports_file_send: true,
  },
  qq: {
    channel_type: 'qq',
    label: 'QQ',
    can_bind_workspace: true,
    can_bind_session: true,
    supports_thread_map: false,
    supports_activation_modes: false,
    supports_owner_mention: true,
    supports_streaming_updates: true,
    supports_file_send: true,
  },
  wechat: {
    channel_type: 'wechat',
    label: '微信',
    can_bind_workspace: true,
    can_bind_session: true,
    supports_thread_map: false,
    supports_activation_modes: false,
    supports_owner_mention: false,
    supports_streaming_updates: false,
    supports_file_send: false,
  },
  discord: {
    channel_type: 'discord',
    label: 'Discord',
    can_bind_workspace: true,
    can_bind_session: true,
    supports_thread_map: false,
    supports_activation_modes: true,
    supports_owner_mention: true,
    supports_streaming_updates: true,
    supports_file_send: true,
  },
  whatsapp: {
    channel_type: 'whatsapp',
    label: 'WhatsApp',
    can_bind_workspace: true,
    can_bind_session: true,
    supports_thread_map: false,
    supports_activation_modes: true,
    supports_owner_mention: true,
    supports_streaming_updates: false,
    supports_file_send: true,
  },
};

export function getImChannelCapabilities(
  channelType: string | null | undefined,
): ImChannelCapabilities | undefined {
  return channelType ? IM_CHANNEL_CAPABILITIES[channelType] : undefined;
}

export function isThreadMapCapableChat(info?: {
  channel_type?: string | null;
  chat_mode?: string | null;
  group_message_type?: string | null;
  /** Generic native-context metadata. Persisted on the container chat. */
  native_context_type?: string | null;
  /** Compatibility input for transports that only expose a boolean. */
  thread_capable?: boolean | null;
}): boolean {
  if (!info?.channel_type) return false;
  const caps = getImChannelCapabilities(info.channel_type);
  if (!caps?.supports_thread_map) return false;
  return (
    info.thread_capable === true ||
    info.native_context_type === 'thread' ||
    info.chat_mode === 'topic' ||
    info.group_message_type === 'thread'
  );
}
