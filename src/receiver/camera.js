// Camera access via getUserMedia (SPEC §14, §14.1).

// Capabilities worth recording for Experiment 0 / later lock experiments.
export const CAPABILITY_KEYS = Object.freeze([
  'width',
  'height',
  'frameRate',
  'resizeMode',
  'facingMode',
  'exposureMode',
  'exposureCompensation',
  'exposureTime',
  'iso',
  'focusMode',
  'focusDistance',
  'whiteBalanceMode',
  'colorTemperature',
  'zoom',
  'torch',
]);

export function isCameraApiAvailable() {
  return !!navigator.mediaDevices?.getUserMedia;
}

export function isVideoFrameCallbackAvailable() {
  return 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
}

export async function listVideoInputs() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'videoinput');
}

// Landscape request by default. Phones held in portrait may still deliver a
// portrait stream; the actual settings are what gets logged.
export function buildConstraints({ deviceId, width, height, frameRate }) {
  const video = {
    width: { ideal: width },
    height: { ideal: height },
    frameRate: { ideal: frameRate },
  };
  if (deviceId) video.deviceId = { exact: deviceId };
  else video.facingMode = { ideal: 'environment' };
  return { audio: false, video };
}

export async function openCamera(options) {
  const constraints = buildConstraints(options);
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  const track = stream.getVideoTracks()[0];
  return {
    stream,
    track,
    constraints,
    label: track.label,
    settings: track.getSettings(),
    capabilities: pickCapabilities(track.getCapabilities?.()),
  };
}

// iOS Safari may settle on 30 fps for an `ideal` 60 fps request. Retry with a
// hard minimum and report what happened; failure leaves the track unchanged.
export async function upgradeFrameRate(track, frameRate) {
  const before = track.getSettings().frameRate ?? null;
  const result = { requested: frameRate, before, after: before, attempted: false, error: null };
  if (before === null || before >= frameRate - 1) return result;
  result.attempted = true;
  try {
    await track.applyConstraints({ ...track.getConstraints(), frameRate: { min: frameRate - 1, ideal: frameRate } });
  } catch (e) {
    result.error = `${e.name}: ${e.message}`;
  }
  result.after = track.getSettings().frameRate ?? null;
  return result;
}

// Estimated camera px/cell if the monitor fills `occupancy` of the camera
// image across its horizontal axis (EXPERIMENTS Experiment 4). A landscape
// monitor seen by a portrait stream only spans the short side.
export function estimatePixelsPerCell(videoWidth, gridWidth, occupancy = 0.9) {
  return (videoWidth * occupancy) / gridWidth;
}

export function pickCapabilities(caps) {
  if (!caps) return null;
  const out = {};
  for (const k of CAPABILITY_KEYS) if (k in caps) out[k] = caps[k];
  return out;
}

export function stopStream(stream) {
  for (const t of stream?.getTracks() ?? []) t.stop();
}
