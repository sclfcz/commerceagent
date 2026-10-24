import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectLangfuseDraftBundle,
  isSafeDraftEndpoint,
  writeLangfuseDraftBundle,
} from '../lib/langfuse-drafts.js';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const benchmarkDirectory = path.join(repository, 'benchmarks');

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function parseDate(value: string | undefined, fallback: Date): Date {
  if (value === undefined) return fallback;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()))
    throw new Error('langfuse_time_range_invalid');
  return date;
}

async function readCredentials() {
  // runtime-config derives the main data directory from cwd, so select the
  // repository before loading it. It reads encrypted local settings and then
  // the existing COMMERCEAGENT_OTEL_* environment fallbacks.
  process.chdir(repository);
  const runtime = await import('../../src/runtime-config.js');
  const settings = runtime.getSystemSettings();
  const endpoint = settings.observabilityEndpoint;
  const publicKey = settings.observabilityPublicKey;
  const secretKey = runtime.getObservabilitySecret();
  if (!endpoint || !publicKey || !secretKey)
    throw new Error('langfuse_credentials_missing');
  if (!isSafeDraftEndpoint(endpoint))
    throw new Error('langfuse_endpoint_invalid');
  return { endpoint, publicKey, secretKey };
}

export async function runLangfuseDraftExport(args = process.argv.slice(2)) {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(
      'Usage: npm run bench:langfuse-drafts -- [--from ISO] [--to ISO] [--min-score 4]\n' +
        'Reads metadata-only failures and low numeric scores; writes skeleton drafts under benchmarks/results/langfuse-drafts/.\n',
    );
    return null;
  }
  const to = parseDate(option(args, '--to'), new Date());
  const from = parseDate(
    option(args, '--from'),
    new Date(to.getTime() - 7 * 24 * 60 * 60 * 1_000),
  );
  const minScore = Number(option(args, '--min-score') ?? '4');
  if (!Number.isFinite(minScore) || minScore <= 1 || minScore > 5)
    throw new Error('langfuse_min_score_invalid');

  const credentials = await readCredentials();
  const bundle = await collectLangfuseDraftBundle({
    ...credentials,
    from,
    to,
    minScore,
  });
  const outputDirectory = writeLangfuseDraftBundle(benchmarkDirectory, bundle);
  const relativeOutput = path.relative(repository, outputDirectory);
  process.stdout.write(
    JSON.stringify({
      ...bundle.selection,
      outputDirectory: relativeOutput,
      automaticPromotion: false,
    }) + '\n',
  );
  return { bundle, outputDirectory };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  try {
    await runLangfuseDraftExport();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error && /^[a-z0-9_:-]+$/i.test(error.message) ? error.message : 'langfuse_draft_export_failed'}\n`,
    );
    process.exitCode = 1;
  }
