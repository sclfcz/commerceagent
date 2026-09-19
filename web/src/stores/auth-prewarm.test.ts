import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * 回归测试：登录页不在 AuthGuard 内，index.html 预发的 /api/auth/me（未登录 → 401）
 * 会在登录成功后才被消费，从而用「登录前的 401」覆盖刚建立的会话，表现为
 * 「第一次登录闪一下被弹回登录页，第二次才成功」。
 */

const USER = {
  id: 'u1',
  username: 'alice',
  display_name: 'Alice',
  role: 'member' as const,
  status: 'active' as const,
  permissions: [],
};

vi.mock('../api/client', () => ({
  api: { get: vi.fn(), post: vi.fn() },
  apiFetch: vi.fn(),
}));
vi.mock('../utils/messageSnapshotCache', () => ({
  clearMessageSnapshotCache: vi.fn(async () => undefined),
}));

import { api } from '../api/client';
import { useAuthStore } from './auth';

const authedUser = () => useAuthStore.getState().user;

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as { window?: unknown }).window = {} as never;
  useAuthStore.setState({
    authenticated: false,
    user: null,
    initialized: true,
    checking: false,
  });
});

describe('auth prewarm race', () => {
  test('a stale pre-login 401 does not clear a session created by login()', async () => {
    // 登录前 HTML 阶段预发的请求：未登录 → 401，一直挂在 window 上
    (window as unknown as { __authPrewarm?: unknown }).__authPrewarm =
      Promise.resolve(new Response('{}', { status: 401 }));
    // 新请求能拿到真实用户（登录成功后 cookie 已生效）
    vi.mocked(api.get).mockResolvedValue({
      user: USER,
      setupStatus: null,
      appearance: null,
    } as never);

    useAuthStore.setState({ authenticated: true, user: USER as never });

    await useAuthStore.getState().checkAuth();

    expect(useAuthStore.getState().authenticated).toBe(true);
    expect(authedUser()?.username).toBe('alice');
    expect(api.get).toHaveBeenCalledWith('/api/auth/me');
  });

  test('login() discards the pre-login prewarm', async () => {
    (window as unknown as { __authPrewarm?: unknown }).__authPrewarm =
      Promise.resolve(new Response('{}', { status: 401 }));
    vi.mocked(api.post).mockResolvedValue({
      success: true,
      user: USER,
      setupStatus: null,
      appearance: null,
    } as never);

    await useAuthStore.getState().login('alice', 'secret');

    expect(useAuthStore.getState().authenticated).toBe(true);
    expect(
      (window as unknown as { __authPrewarm?: unknown }).__authPrewarm,
    ).toBeUndefined();
  });
});
