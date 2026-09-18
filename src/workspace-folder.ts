/**
 * Workspace folders are persisted identifiers, not arbitrary filesystem paths.
 *
 * Keep this contract shared by registration and every runtime path builder so a
 * folder accepted at creation can always be handled safely during cleanup.
 */
const WORKSPACE_FOLDER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isValidWorkspaceFolderName(value: unknown): value is string {
  return typeof value === 'string' && WORKSPACE_FOLDER_NAME_RE.test(value);
}

export function assertValidWorkspaceFolderName(
  value: unknown,
  label = 'workspace folder',
): string {
  if (!isValidWorkspaceFolderName(value)) {
    throw new Error(`Invalid ${label} for filesystem isolation`);
  }
  return value;
}
