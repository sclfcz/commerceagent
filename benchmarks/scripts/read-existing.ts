import { requiresGatewayAudit } from '../lib/identity.js';
// Run only as an IPC child with COMMERCEAGENT_DATA_DIR pointing at a private
// COPY of provider config. Imports/migrations never touch the production copy.
import { getProviders } from '../../src/runtime-config.js';

try {
  const providers = getProviders().filter(
    (provider) =>
      provider.enabled &&
      provider.anthropicModel &&
      (provider.anthropicApiKey || provider.anthropicAuthToken),
  );
  process.send?.(
    providers.map((provider, index) => {
      const baseUrl = provider.anthropicBaseUrl || 'https://api.anthropic.com';
      const billingRegion =
        /^qwen/i.test(provider.anthropicModel || '') &&
        ['maas.qianwenaiapi.com', 'dashscope.aliyuncs.com'].includes(
          new URL(baseUrl).hostname,
        )
          ? 'cn-mainland'
          : undefined;
      return {
        alias: `candidate-${index + 1}`,
        model: provider.anthropicModel,
        baseUrl,
        apiKeyEnv: `BENCH_IMPORTED_${index + 1}`,
        credentialKind: provider.anthropicApiKey ? 'apiKey' : 'authToken',
        credential: provider.anthropicApiKey || provider.anthropicAuthToken,
        gatewayDeclared: false,
        gateway: requiresGatewayAudit(baseUrl, false, provider.anthropicModel),
        ...(billingRegion ? { billingRegion } : {}),
      };
    }),
  );
} catch {
  process.exitCode = 1;
}
process.disconnect?.();
