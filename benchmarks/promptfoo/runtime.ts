import fs from 'node:fs';
import path from 'node:path';

export function configurePromptfooStorage(promptfooDirectory: string) {
  const configDirectory = path.join(promptfooDirectory, 'config');
  const cacheDirectory = path.join(promptfooDirectory, 'cache');
  fs.mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 });
  Object.assign(process.env, {
    PROMPTFOO_CONFIG_DIR: configDirectory,
    PROMPTFOO_CACHE_PATH: cacheDirectory,
    PROMPTFOO_CACHE_ENABLED: 'false',
    PROMPTFOO_DISABLE_TELEMETRY: '1',
    PROMPTFOO_DISABLE_UPDATE: '1',
    PROMPTFOO_DISABLE_SHARING: '1',
  });
  return { configDirectory, cacheDirectory };
}
