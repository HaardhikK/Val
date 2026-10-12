// The page's knobs that are tuned to one phone (the app's are in DeviceProfile.kt). Tuned for a Realme 3 Pro:
// Snapdragon 710 (Adreno 616 GPU), 1080x2340 screen, WebView 94 (the build target is in build.mjs). On a faster phone,
// raise the pixel cap and the idle frame rate; on a slower one, lower them.

export const DEVICE = {
  /** Highest canvas pixel ratio (3D, map, seismograph): 2 drew 78 % more pixels on this phone's GPU. */
  maxPixelRatio: 1.5,
  /** Frame rate of the corner bubble and of the full-screen loop while nothing moves fast (the screen runs 60 Hz). */
  idleFps: 30,
  /** Minimum time between drawn frames while asleep (~20 fps). */
  sleepFrameMs: 50,
  /** The map warms itself this long after start-up, once model servers and shader warm-up have settled. */
  mapPrewarmMs: 10_000,
};

/** The canvas pixel ratio for this screen, capped at [DEVICE.maxPixelRatio]. */
export function pixelRatio(): number {
  return Math.min(window.devicePixelRatio || 1, DEVICE.maxPixelRatio);
}
