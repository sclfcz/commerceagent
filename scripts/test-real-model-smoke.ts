import '../src/load-env.js';

import { getClaudeProviderConfig } from '../src/runtime-config.js';
import { sdkQuery } from '../src/sdk-query.js';

const EXPECTED = 'COMMERCEAGENT_REAL_SMOKE_OK_20260721';

async function main(): Promise<void> {
  const config = getClaudeProviderConfig();
  const startedAt = Date.now();
  const response = await sdkQuery(
    `这是 CommerceAgent 的真实模型连通性测试。请只回复下面这一行，不要添加标点、解释或代码块：\n${EXPECTED}`,
    { timeout: 90_000 },
  );
  const completed = typeof response === 'string' && response.length > 0;
  const exactMatch = response === EXPECTED;

  // Never print provider values, endpoints, models, credentials, or unexpected
  // response text. The booleans are sufficient for reproducible smoke evidence.
  process.stdout.write(
    `${JSON.stringify(
      {
        providerConfigured: Boolean(
          config.anthropicApiKey ||
          config.anthropicAuthToken ||
          config.claudeCodeOauthToken ||
          config.claudeOAuthCredentials,
        ),
        baseUrlPresent: Boolean(config.anthropicBaseUrl),
        modelPresent: Boolean(config.anthropicModel),
        completed,
        exactMatch,
        responseLength: response?.length ?? 0,
        elapsedMs: Date.now() - startedAt,
      },
      null,
      2,
    )}\n`,
  );

  if (!exactMatch) process.exitCode = 1;
}

void main().catch(() => {
  // Provider errors can contain endpoints or upstream response fragments.
  process.stderr.write('real-model smoke failed\n');
  process.exitCode = 1;
});
