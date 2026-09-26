// Test-log export helpers (EXPERIMENTS "Data logging").

export function collectEnvironment() {
  const uaData = navigator.userAgentData;
  return {
    userAgent: navigator.userAgent,
    userAgentData: uaData ? { brands: uaData.brands, mobile: uaData.mobile, platform: uaData.platform } : null,
    language: navigator.language,
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    devicePixelRatio: window.devicePixelRatio,
    screen: {
      width: screen.width,
      height: screen.height,
      availWidth: screen.availWidth,
      availHeight: screen.availHeight,
      colorDepth: screen.colorDepth,
      orientation: screen.orientation?.type ?? null,
    },
    isSecureContext: window.isSecureContext,
  };
}

export function timestampForFilename(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

export function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
