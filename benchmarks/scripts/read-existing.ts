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
    providers.map((provider, index) => ({
      alias: `candidate-${index + 1}`,
      model: provider.anthropicModel,
      baseUrl: provider.anthropicBaseUrl || 'https://api.anthropic.com',
      apiKeyEnv: `BENCH_IMPORTED_${index + 1}`,
      credentialKind: provider.anthropicApiKey ? 'apiKey' : 'authToken',
      credential: provider.anthropicApiKey || provider.anthropicAuthToken,
      gatewayDeclared: false,
      gateway: requiresGatewayAudit(
        provider.anthropicBaseUrl || 'https://api.anthropic.com',
        false,
        provider.anthropicModel,
      ),
    })),
  );
} catch {
  process.exitCode = 1;
}
process.disconnect?.();
