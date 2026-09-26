// Whether the page is served by the development server (tools/serve.mjs),
// which receives logs and raw captures. A static host (GitHub Pages) has no
// API: the pages then keep logs on the device instead of uploading them.

let probe = null;

export function hasDevServer() {
  probe ??= fetch('api/health', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => j?.vdl === true)
    .catch(() => false);
  return probe;
}
