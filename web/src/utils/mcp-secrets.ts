export type McpSecretKind = 'env' | 'headers';

export interface McpSecretRow {
  key: string;
  value: string;
}

export function buildMcpSecretReplacement(
  kind: McpSecretKind,
  rows: McpSecretRow[] | null,
): { env?: Record<string, string>; headers?: Record<string, string> } {
  if (rows === null) return {};
  const values = rows.reduce<Record<string, string>>((result, row) => {
    const key = row.key.trim();
    if (key) result[key] = row.value;
    return result;
  }, {});
  return kind === 'headers' ? { headers: values } : { env: values };
}

export function buildMcpSecretClear(kind: McpSecretKind): {
  env?: null;
  headers?: null;
} {
  return kind === 'headers' ? { headers: null } : { env: null };
}
