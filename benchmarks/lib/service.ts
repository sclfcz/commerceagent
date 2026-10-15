import { databaseState, inspectSession } from './fresh-state.js';
import { cleanupServiceSecrets } from './secrets.js';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import {
  candidateEnvironment,
  type Candidate,
  privateJson,
} from './contracts.js';

const ownedServices = new Set<ChildProcess>();
const ownedData = new Map<ChildProcess, string>();
export async function stopOwnedServices(): Promise<void> {
  await Promise.allSettled([...ownedServices].map(stopService));
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export async function stopService(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    const data = ownedData.get(child);
    if (data) {
      cleanupServiceSecrets(data);
      ownedData.delete(child);
    }
    return;
  }
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  // The application allows 15s for GroupQueue cleanup and 30s overall.
  const force = setTimeout(() => child.kill('SIGKILL'), 35000);
  try {
    await exited;
  } finally {
    clearTimeout(force);
    const data = ownedData.get(child);
    if (data) {
      cleanupServiceSecrets(data);
      ownedData.delete(child);
    }
  }
}

export async function startService(options: {
  repository: string;
  directory: string;
  image: string;
  timeoutMs: number;
}) {
  // Own the process and its fresh cwd: never attach to an arbitrary base URL,
  // load the production .env, migrate legacy data, or inherit host credentials.
  if (fs.existsSync(options.directory))
    throw new Error('service_directory_exists');
  fs.mkdirSync(options.directory, { mode: 0o700 });
  const home = path.join(options.directory, 'home');
  const data = path.join(options.directory, 'data-eval');
  fs.mkdirSync(data, { mode: 0o700 });
  const initialDataEntries = fs.readdirSync(data).length;
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(path.join(home, '.claude'), { mode: 0o700 });
  fs.symlinkSync(
    path.join(options.repository, 'container'),
    path.join(options.directory, 'container'),
    'dir',
  );
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: process.env.TMPDIR,
    COMMERCEAGENT_DATA_DIR: data,
    EXTERNAL_CLAUDE_DIR: path.join(home, '.claude'),
    WEB_PORT: String(port),
    WEB_SESSION_SECRET: randomBytes(32).toString('hex'),
    LOG_LEVEL: 'silent',
    TZ: 'UTC',
    ADMIN_HOST_ONLY_MODE: 'false',
    MAIN_AGENT_CONTEXT_SOURCE: 'managed',
    COMMERCEAGENT_BENCHMARK_MODE: '1',
    COMMERCEAGENT_BENCHMARK_ALWAYS_LOAD_MCP_SERVER: 'commerce_fixture',
    FALLBACK_MODEL: '',
    PLUGIN_AUTO_SCAN: 'false',
    CONTAINER_IMAGE: options.image,
    CONTAINER_TIMEOUT: String(options.timeoutMs),
    IDLE_TIMEOUT: String(options.timeoutMs),
  };
  // Docker Desktop's CLI may need its original client config/context. This is
  // host orchestration only, never mounted into the Runner.
  env.DOCKER_CONFIG =
    process.env.DOCKER_CONFIG || path.join(process.env.HOME || '', '.docker');
  for (const key of [
    'DOCKER_HOST',
    'DOCKER_CONTEXT',
    'DOCKER_TLS_VERIFY',
    'DOCKER_CERT_PATH',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
  ])
    if (process.env[key]) env[key] = process.env[key];
  const child = spawn(
    process.execPath,
    [
      '--import',
      pathToFileURL(
        path.join(options.repository, 'node_modules/tsx/dist/loader.mjs'),
      ).href,
      path.join(options.repository, 'src/index.ts'),
    ],
    {
      cwd: options.directory,
      env,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    },
  );
  ownedServices.add(child);
  ownedData.set(child, data);
  child.once('exit', () => ownedServices.delete(child));
  let spawnFailed = false;
  let runtimeReady = false;
  child.on('message', (message) => {
    if (
      message &&
      typeof message === 'object' &&
      'type' in message &&
      message.type === 'commerceagent_ready'
    )
      runtimeReady = true;
  });
  child.on('error', () => {
    spawnFailed = true;
  });
  try {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (spawnFailed || child.exitCode !== null || child.signalCode !== null)
        throw new Error('service_start_failed');
      try {
        const response = await fetch(new URL('/api/auth/status', baseUrl), {
          signal: AbortSignal.timeout(500),
        });
        if (response.ok && runtimeReady)
          return {
            child,
            data,
            baseUrl,
            creationEvidence: {
              serviceDirectoryCreated: fs
                .lstatSync(options.directory)
                .isDirectory(),
              dataDirectoryCreated: fs.lstatSync(data).isDirectory(),
              initialDataEntries,
            },
          };
      } catch {
        /* bounded startup polling */
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('service_start_timeout');
  } catch (error) {
    await stopService(child);
    throw error;
  }
}

export class EvalApi {
  cookie = '';
  constructor(
    readonly baseUrl: string,
    readonly requestTimeoutMs = 20000,
  ) {}
  async request<T = Record<string, any>>(
    route: string,
    body?: unknown,
  ): Promise<T> {
    const response = await fetch(new URL(route, this.baseUrl), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.cookie ? { Cookie: this.cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`api_status_${response.status}`);
    const cookie = response.headers.get('set-cookie');
    if (cookie) this.cookie = cookie.split(';')[0];
    return (await response.json()) as T;
  }
}

export async function provisionProfiles(
  api: EvalApi,
  profile: Record<string, any>,
  candidates: Candidate[],
  onStage?: (stage: string) => void,
) {
  const bindings: Array<{
    alias: string;
    providerId: string;
    profile: Record<string, any>;
  }> = [];
  for (const [index, configured] of candidates.entries()) {
    onStage?.(`provider_upsert_${index + 1}`);
    const provider = await api.request('/api/config/claude/providers', {
      name: configured.alias,
      type: 'third_party',
      enabled: true,
      anthropicBaseUrl: configured.baseUrl,
      anthropicModel: configured.model,
      [configured.credentialKind === 'authToken'
        ? 'anthropicAuthToken'
        : 'anthropicApiKey']: process.env[configured.apiKeyEnv],
      customEnv: candidateEnvironment(configured),
    });
    onStage?.(`profile_create_${index + 1}`);
    const created = await api.request('/api/agent-profiles', {
      ...profile,
      model_config_id: provider.id,
    });
    bindings.push({
      alias: configured.alias,
      providerId: provider.id,
      profile: created.profile,
    });
  }
  return bindings;
}

export async function bootstrap(
  api: EvalApi,
  candidate: Candidate,
  profile: Record<string, any>,
  data: string,
  candidates: Candidate[] = [candidate],
  onStage?: (stage: string) => void,
) {
  onStage?.('initial_database');
  const initialDatabase = databaseState(data);
  onStage?.('auth_setup');
  const auth = await api.request('/api/auth/setup', {
    username: 'benchmark',
    password: randomBytes(24).toString('base64url'),
  });
  onStage?.('fixture_mcp_register');
  await api.request('/api/mcp-servers', {
    id: 'commerce_fixture',
    scope: 'user',
    command: 'node',
    args: ['/workspace/group/fixture-bridge.mjs'],
    description: 'Synthetic commerce fixture',
  });
  const bindings = await provisionProfiles(api, profile, candidates, onStage);
  const selected = bindings.find(
    (binding) => binding.alias === candidate.alias,
  );
  if (!selected || selected.profile.model_config_id !== selected.providerId)
    throw new Error('profile_binding');
  const created = { profile: selected.profile };
  const provider = { id: selected.providerId };
  onStage?.('workspace_create');
  const workspace = await api.request('/api/groups', {
    name: 'Benchmark workspace',
    agent_profile_id: created.profile.id,
    execution_mode: 'container',
  });
  if (
    workspace.group.execution_mode !== 'container' ||
    workspace.group.is_my_home
  )
    throw new Error('workspace_isolation');
  const jid = encodeURIComponent(workspace.jid);
  // Workspace creation automatically prewarms its main Runner. Quiesce it
  // before measuring a separate cold Runtime Session or taking the baseline.
  onStage?.('prewarm_runner_stop');
  await api.request(`/api/groups/${jid}/stop`, {});
  const folder = workspace.group.folder;
  const groupDir = path.join(data, 'groups', folder);
  fs.rmSync(path.join(groupDir, 'logs'), { recursive: true, force: true });
  // Explicit title avoids the auto_pending → sdkQuery title path.
  const beforeSession = databaseState(data);
  onStage?.('session_create');
  const session = await api.request(`/api/groups/${jid}/sessions`, {
    name: 'Benchmark attempt',
  });
  privateJson(path.join(groupDir, 'business-context.json'), {
    businessDate: '2026-09-10',
  });
  onStage?.('bootstrap_complete');
  return {
    initialDatabase,
    userAbsentBeforeSetup: !initialDatabase.users.includes(auth.user.id),
    sessionAbsentBeforeCreate: !beforeSession.sessions.includes(
      session.session.id,
    ),
    ...inspectSession(data, auth.user.id, workspace.jid, session.session.id),
    bindings: bindings.map((b) => ({
      alias: b.alias,
      providerId: b.providerId,
      profileId: b.profile.id,
      modelConfigId: b.profile.model_config_id,
    })),
    userId: auth.user.id as string,
    providerId: provider.id as string,
    profile: created.profile,
    workspaceJid: workspace.jid as string,
    folder: folder as string,
    groupDir,
    sessionId: session.session.id as string,
  };
}
