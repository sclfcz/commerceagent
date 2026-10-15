// Exact HTTPS origins and documented Anthropic paths. Unknown endpoints remain
// gateways even if a local YAML incorrectly sets gateway:false. See docs/BENCHMARK.md.
const official = new Map([
  ['https://api.anthropic.com', 'anthropic'],
  ['https://api.deepseek.com/anthropic', 'deepseek'],
  ['https://open.bigmodel.cn/api/anthropic', 'glm'],
  ['https://api.z.ai/api/anthropic', 'glm'],
  ['https://api.moonshot.cn/anthropic', 'kimi'],
  ['https://api.moonshot.ai/anthropic', 'kimi'],
  ['https://dashscope.aliyuncs.com/apps/anthropic', 'qwen'],
  ['https://maas.qianwenaiapi.com/apps/anthropic', 'qwen'],
]);
export function officialVendor(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    if (url.username || url.password || url.search || url.hash) return null;
    return official.get(url.origin + url.pathname.replace(/\/+$/, '')) ?? null;
  } catch {
    return null;
  }
}
export function requiresGatewayAudit(
  baseUrl: string,
  explicitGateway = false,
  model?: string,
): boolean {
  const vendor = officialVendor(baseUrl);
  // Model Studio also serves other vendors. Only Qwen targets use the
  // first-party Qwen trust contract; other hosted models remain gateways.
  return (
    explicitGateway ||
    vendor === null ||
    (vendor === 'qwen' && !/^qwen(?:[0-9-])/i.test(model ?? ''))
  );
}
