/**
 * screenRecorderCore.ts — the screen recorder's IPC with the Electron and file
 * system pieces injected, so it runs under node --test. screenRecorder.ts binds
 * it to the real `ipcMain`, the save dialog and the disk.
 *
 * The file is named BEFORE the recording starts and each chunk is appended as
 * it arrives: a few minutes of video is hundreds of MB and must never cross IPC
 * as one message. The path lives here, in main, rather than coming from the
 * renderer with each chunk, so the bytes can only ever land in the file the
 * user named in the dialog.
 */
import type { IpcLike } from './shellIpcCore'

/** Channel suffixes, joined to `<appId>:` by the caller. preload/index.ts
 *  spells the same names; screenRecorderCore.test.ts pins them. */
export const RECORDER_CHANNELS = {
  start: 'record-start',
  chunk: 'record-chunk',
  stop: 'record-stop',
} as const

export type RecordingFormat = 'mp4' | 'webm'

export interface RecorderDeps {
  channel: (name: string) => string
  /** Ask the user where to save; null when they cancel. `sender` is the
   *  asking webContents, so the dialog can be parented to its window. */
  choosePath: (format: RecordingFormat, sender: unknown) => Promise<string | null>
  /** Create (or truncate) the file. */
  create: (path: string) => Promise<void>
  append: (path: string, bytes: Uint8Array) => Promise<void>
  remove: (path: string) => Promise<void>
}

/** `<appId>-2026-11-15-14-03-22.<format>`, local time, safe on every OS. */
export function recordingName(appId: string, when: Date, format: RecordingFormat): string {
  const two = (n: number) => String(n).padStart(2, '0')
  const stamp = [
    when.getFullYear(), two(when.getMonth() + 1), two(when.getDate()),
    two(when.getHours()), two(when.getMinutes()), two(when.getSeconds()),
  ].join('-')
  return `${appId}-${stamp}.${format}`
}

function replaceHandle(ipc: IpcLike, ch: string, fn: (e: unknown, ...a: any[]) => unknown) {
  ipc.removeHandler(ch)
  ipc.handle(ch, fn)
}

export function bindRecorderIpc(ipc: IpcLike, d: RecorderDeps): void {
  let path: string | null = null
  let written = 0

  // RETURNS the path, or null when the user cancelled.
  replaceHandle(ipc, d.channel(RECORDER_CHANNELS.start), async (event, format: unknown) => {
    // The renderer is untrusted input: anything but the two containers is refused.
    if (format !== 'mp4' && format !== 'webm') return null
    const chosen = await d.choosePath(format, (event as { sender?: unknown } | null)?.sender)
    if (!chosen) return null
    await d.create(chosen)
    path = chosen
    written = 0
    return chosen
  })

  // Awaited by the renderer, which chains the chunks, so the file is written in
  // recording order. A chunk with no recording open is dropped, not written.
  replaceHandle(ipc, d.channel(RECORDER_CHANNELS.chunk), async (_e, bytes: unknown) => {
    if (!path || !(bytes instanceof Uint8Array) || !bytes.length) return
    await d.append(path, bytes)
    written += bytes.length
  })

  // Closes the recording. One that never got a byte (the capture failed after
  // the file was named) leaves no empty file behind. RETURNS the bytes written.
  replaceHandle(ipc, d.channel(RECORDER_CHANNELS.stop), async () => {
    const closing = path
    const bytes = written
    path = null
    written = 0
    if (closing && bytes === 0) await d.remove(closing)
    return bytes
  })
}
