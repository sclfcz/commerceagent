/**
 * Reliable file download utilities using fetch + blob.
 *
 * The old pattern `<a href="url" download="name">.click()` breaks on:
 *   - iOS Safari / PWA standalone mode (download attr ignored for server URLs)
 *   - Large data URLs (browser size limits)
 *   - Some mobile browsers (programmatic click not honoured)
 *
 * This module always goes through fetch → Blob → ObjectURL which works
 * consistently across all modern browsers and PWA modes.
 */

import { withBasePath } from './url';

export class DownloadError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'DownloadError';
  }
}

async function readDownloadErrorMessage(response: Response): Promise<string> {
  const fallback = `下载失败 (${response.status})`;
  const contentType = response.headers.get('content-type') || '';

  try {
    if (contentType.includes('application/json')) {
      const body = (await response.json()) as {
        error?: unknown;
        message?: unknown;
      };
      const message =
        typeof body.error === 'string'
          ? body.error
          : typeof body.message === 'string'
            ? body.message
            : null;
      return message?.trim() || fallback;
    }

    if (contentType.startsWith('text/plain')) {
      return (await response.text()).trim() || fallback;
    }
  } catch {
    // Keep a safe status-based message when the response body is malformed.
  }

  return fallback;
}

/**
 * Trigger a browser download from a Blob.
 */
function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke after a short delay so the browser has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

/** Download UTF-8 text generated in the browser (for example a CSV export). */
export function downloadTextFile(
  content: string,
  filename: string,
  mimeType = 'text/plain;charset=utf-8',
): void {
  triggerBlobDownload(new Blob([content], { type: mimeType }), filename);
}

/**
 * Download a file from an API endpoint (or any same-origin URL).
 * Uses fetch with credentials so auth cookies are always included.
 */
export async function downloadFromUrl(
  url: string,
  filename: string,
): Promise<void> {
  const fullUrl = url.startsWith('http') ? url : withBasePath(url);
  const res = await fetch(fullUrl, { credentials: 'include' });
  if (!res.ok) {
    throw new DownloadError(res.status, await readDownloadErrorMessage(res));
  }
  const blob = await res.blob();
  triggerBlobDownload(blob, filename);
}

/**
 * Download a data-URL (e.g. from html-to-image / canvas) as a file.
 * Converts to Blob first to avoid browser data-URL size limits.
 */
export async function downloadFromDataUrl(
  dataUrl: string,
  filename: string,
): Promise<void> {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  triggerBlobDownload(blob, filename);
}
