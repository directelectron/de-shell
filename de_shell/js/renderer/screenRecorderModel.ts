/**
 * screenRecorderModel.ts — the screen recorder's decisions, free of React and
 * of the browser, so they run under node --test.
 */

/** mp4 where Chromium can mux it, webm everywhere else; best first. */
export const RECORDING_TYPES = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm'] as const

/** Long enough that the per-chunk IPC is negligible, short enough that a crash
 *  costs seconds of video rather than the whole clip. */
export const CHUNK_MS = 3000

/** The window event that starts or stops a recording. It must be dispatched
 *  from a real click handler: Chromium only grants `getDisplayMedia` with user
 *  activation, which a native menu item routed through main does not carry. */
export const TOGGLE_RECORDING_EVENT = 'de-shell:toggle-recording'

/** The best type this browser can record, and the file extension it needs. */
export function pickRecordingType(
  supported: (mimeType: string) => boolean,
): { mimeType: string; format: 'mp4' | 'webm' } {
  const mimeType = RECORDING_TYPES.find(supported) ?? ''
  return { mimeType, format: mimeType.startsWith('video/mp4') ? 'mp4' : 'webm' }
}

/** Elapsed seconds as m:ss. */
export function recordingClock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** The last segment of a path, on either separator. */
export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}
