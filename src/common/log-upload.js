// Uploads test logs to the development server (tools/serve.mjs, POST /api/logs).

export const LOG_ENDPOINT = 'api/logs';

export async function uploadLog(data) {
  const res = await fetch(LOG_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body.file;
}

// For page hide / unload, where an awaited fetch may be cancelled.
// text/plain because some browsers reject non-CORS-safelisted Blob types in
// sendBeacon; the server accepts it as JSON.
export function beaconLog(data) {
  if (!navigator.sendBeacon) return false;
  return navigator.sendBeacon(LOG_ENDPOINT, new Blob([JSON.stringify(data)], { type: 'text/plain' }));
}
