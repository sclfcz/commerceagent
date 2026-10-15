import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { hash } from './contracts.js';

const promptSections = new Set([
  'identity_prompt',
  'soul_prompt',
  'agents_prompt',
  'tools_prompt',
]);

function mergeObjects(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    const existing = result[key];
    result[key] =
      existing &&
      value &&
      typeof existing === 'object' &&
      !Array.isArray(existing) &&
      typeof value === 'object' &&
      !Array.isArray(value)
        ? mergeObjects(
            existing as Record<string, unknown>,
            value as Record<string, unknown>,
          )
        : structuredClone(value);
  }
  return result;
}

export interface LoadedProfileVariant {
  id: string;
  description: string;
  profile: Record<string, unknown>;
  profileYaml: string;
  profileHash: string;
  definitionHash: string;
  sourceHashes: { baseProfile: string; variant: string };
}

export function loadProfileVariant(
  id: string,
  benchmarkDirectory = fileURLToPath(new URL('../', import.meta.url)),
): LoadedProfileVariant {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))
    throw new Error('profile_variant_id_invalid');
  const baseFile = path.join(benchmarkDirectory, 'profile.yaml');
  const variantFile = path.join(benchmarkDirectory, 'profiles', `${id}.yaml`);
  if (!fs.existsSync(baseFile) || !fs.existsSync(variantFile))
    throw new Error('profile_variant_missing');
  const baseText = fs.readFileSync(baseFile, 'utf8');
  const variantText = fs.readFileSync(variantFile, 'utf8');
  const profile = parse(baseText) as Record<string, unknown>;
  const definition = parse(variantText) as Record<string, unknown>;
  if (
    !profile ||
    !definition ||
    definition.id !== id ||
    typeof definition.description !== 'string' ||
    !definition.description.trim()
  )
    throw new Error('profile_variant_definition_invalid');

  const promptAppend = definition.prompt_append ?? {};
  if (
    !promptAppend ||
    typeof promptAppend !== 'object' ||
    Array.isArray(promptAppend) ||
    Object.keys(promptAppend).some((key) => !promptSections.has(key))
  )
    throw new Error('profile_variant_prompt_override_invalid');
  for (const [key, addition] of Object.entries(
    promptAppend as Record<string, unknown>,
  )) {
    if (typeof addition !== 'string')
      throw new Error('profile_variant_prompt_override_invalid');
    const current = profile[key];
    if (typeof current !== 'string')
      throw new Error('profile_variant_base_prompt_invalid');
    profile[key] = [current.trimEnd(), addition.trim()]
      .filter(Boolean)
      .join('\n\n');
  }

  const runtimeOverrides = definition.runtime_policy_overrides ?? {};
  if (
    !runtimeOverrides ||
    typeof runtimeOverrides !== 'object' ||
    Array.isArray(runtimeOverrides)
  )
    throw new Error('profile_variant_runtime_override_invalid');
  if (Object.keys(runtimeOverrides as object).length > 0) {
    const currentPolicy = (profile.runtime_policy ?? {}) as Record<
      string,
      unknown
    >;
    profile.runtime_policy = mergeObjects(
      currentPolicy,
      runtimeOverrides as Record<string, unknown>,
    );
  }

  const profileYaml = stringify(profile);
  const sourceHashes = {
    baseProfile: hash(baseText),
    variant: hash(variantText),
  };
  return {
    id,
    description: definition.description,
    profile,
    profileYaml,
    profileHash: hash(profile),
    definitionHash: hash({ id, sourceHashes, profileHash: hash(profile) }),
    sourceHashes,
  };
}

export function loadProfileVariants(
  ids: string[],
  benchmarkDirectory?: string,
) {
  if (!ids.length || new Set(ids).size !== ids.length)
    throw new Error('profile_variant_list_invalid');
  return ids.map((id) => loadProfileVariant(id, benchmarkDirectory));
}
