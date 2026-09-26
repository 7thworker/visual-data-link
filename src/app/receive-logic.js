// What the receive page does after a camera frame (receive.js), kept free of
// the DOM so that it can be tested. m1: M1Controller-like object.
//
// The reception completes asynchronously (SHA-256), between camera frames,
// so the received file is checked before another reception is started;
// otherwise the page would start again from 0% right after 100%.
export function frameAction({ done, stopped, starting }, m1) {
  if (done) return null;
  if (m1.receivedObject() && !m1.transfer) return 'finish';
  if (!stopped && !starting && !m1.transfer && m1.quad && m1.locked && m1.profileConfirmed) return 'start';
  return null;
}
