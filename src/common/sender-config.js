// Test-harness channel for the sender's current test pattern (tools/serve.mjs).
// The receiver uses it as ground truth for BER measurement so that grid, seed,
// and frame number need not be typed on the phone. Payload data never uses it.

export const SENDER_CONFIG_ENDPOINT = 'api/sender-config';

export async function publishSenderConfig(config) {
  const res = await fetch(SENDER_CONFIG_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'vdl-sender-config', ...config }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
}

// Returns the last published config, or null if none has been published.
export async function fetchSenderConfig() {
  const res = await fetch(SENDER_CONFIG_ENDPOINT, { cache: 'no-store' });
  if (res.status === 404) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}
