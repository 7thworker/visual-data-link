// Address of a receive page for the phone (top page and send page QR codes).
// The phone needs HTTPS (camera): through the dev server's tunnel when the
// page is opened via localhost, otherwise this origin (the public site).

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/;

// page: 'receive.html' (simple) or 'receiver.html' (measurements); null when
// the dev server has no HTTPS tunnel.
export async function receivePageUrl(page = 'receive.html') {
  if (!LOCAL.test(location.hostname)) return new URL(page, location.href).href;
  const r = await fetch('/api/public-url', { cache: 'no-store' }).catch(() => null);
  if (!r?.ok) return null;
  const { url } = await r.json();
  return new URL(page, `${url}/`).href;
}
