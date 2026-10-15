import fs from 'node:fs';
import path from 'node:path';

// Only call after this driver's owned service has exited. Never follow symlinks.
export function cleanupServiceSecrets(data: string): void {
  if (path.basename(data) !== 'data-eval' || !fs.existsSync(data)) return;
  if (fs.lstatSync(data).isSymbolicLink())
    throw new Error('secret_cleanup_symlink');
  for (const name of ['config', 'env'])
    fs.rmSync(path.join(data, name), { recursive: true, force: true });
  const visit = (directory: string, mcpSecrets = false) => {
    if (!fs.existsSync(directory) || fs.lstatSync(directory).isSymbolicLink())
      return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(file, mcpSecrets);
      else if (
        /^(?:settings(?:\.local)?\.json|\.credentials\.json|\.commerceagent-native-settings\.json|\.claude\.json(?:\..*)?|\.fixture-connection\.json)$/.test(
          entry.name,
        ) ||
        (mcpSecrets && entry.name === 'secrets.json')
      )
        fs.rmSync(file, { force: true });
    }
  };
  visit(path.join(data, 'sessions'));
  visit(path.join(data, 'groups'));
  visit(path.join(data, 'mcp-servers'), true);
}

export function cleanupHistoricalSecrets(results: string): void {
  if (!fs.existsSync(results) || fs.lstatSync(results).isSymbolicLink()) return;
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const folder = path.join(directory, entry.name);
      if (entry.name === 'provider-snapshot')
        fs.rmSync(folder, { recursive: true, force: true });
      else if (entry.name === 'data-eval') cleanupServiceSecrets(folder);
      else visit(folder);
    }
  };
  visit(results);
}
