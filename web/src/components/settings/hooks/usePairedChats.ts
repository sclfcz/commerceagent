import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../../api/client';
import { getErrorMessage } from '../types';

export interface PairedChat {
  jid: string;
  name: string;
  addedAt: string;
}

interface UsePairedChatsOptions {
  /** Base API path, e.g. '/api/config/user-im/telegram/paired-chats' */
  endpoint: string;
}

export function usePairedChats({ endpoint }: UsePairedChatsOptions) {
  const [chats, setChats] = useState<PairedChat[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removingJid, setRemovingJid] = useState<string | null>(null);
  const [renamingJid, setRenamingJid] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<{ chats: PairedChat[] }>(endpoint);
      setChats(data.chats);
    } catch (err) {
      setChats([]);
      setError(getErrorMessage(err, '加载已配对聊天失败'));
    } finally {
      setLoading(false);
    }
  }, [endpoint]);

  const remove = useCallback(
    async (jid: string) => {
      setRemovingJid(jid);
      setError(null);
      try {
        await api.delete(`${endpoint}/${encodeURIComponent(jid)}`);
        setChats((prev) => prev.filter((c) => c.jid !== jid));
        toast.success('已删除接入记录与本地历史');
      } catch (err) {
        setError(getErrorMessage(err, '解除配对失败'));
        toast.error(getErrorMessage(err, '删除接入记录失败'));
      } finally {
        setRemovingJid(null);
      }
    },
    [endpoint],
  );

  const rename = useCallback(
    async (jid: string, name: string) => {
      setRenamingJid(jid);
      try {
        await api.put(`${endpoint}/${encodeURIComponent(jid)}`, { name });
        setChats((prev) =>
          prev.map((c) => (c.jid === jid ? { ...c, name } : c)),
        );
        toast.success('已重命名');
      } catch (err) {
        toast.error(getErrorMessage(err, '重命名失败'));
      } finally {
        setRenamingJid(null);
      }
    },
    [endpoint],
  );

  return {
    chats,
    loading,
    error,
    removingJid,
    renamingJid,
    load,
    remove,
    rename,
  };
}
