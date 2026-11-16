/**
 * screenRecorder.ts — capturing the app's own window to a video file (a demo, a
 * bug report, a scrub someone else needs to see), registered with one call.
 *
 * What is captured is the window's own web contents, not a display: the
 * display-media request is answered with the asking frame, so no source picker
 * appears, nothing outside the app can end up in the file, and macOS never asks
 * for Screen Recording permission. The trade-off is that anything the OS draws
 * on top — a native menu, a file dialog — is not in the recording.
 *
 * The renderer half is `<ScreenRecorder>` from @de/shell-renderer, over the
 * preload bridge's `recorder`.
 */
import { BrowserWindow, app, dialog, ipcMain } from 'electron'
import { appendFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'

import { channel, shellConfig } from './config'
import { bindRecorderIpc, recordingName } from './screenRecorderCore'

/** Let `win` record itself, and wire the save-and-append channels. Call once
 *  the window exists. Safe to call again for a new window: the handlers are
 *  replaced, not stacked. */
export function registerScreenRecorder(win: BrowserWindow): void {
  win.webContents.session.setDisplayMediaRequestHandler((request, callback) =>
    callback({ video: request.frame ?? win.webContents.mainFrame }),
  )

  bindRecorderIpc(ipcMain, {
    channel,
    choosePath: async (format, sender) => {
      const parent = BrowserWindow.fromWebContents(sender as Electron.WebContents) ?? win
      const result = await dialog.showSaveDialog(parent, {
        defaultPath: join(app.getPath('videos'), recordingName(shellConfig().appId, new Date(), format)),
        filters: [{ name: 'Video', extensions: [format] }],
      })
      return result.canceled || !result.filePath ? null : result.filePath
    },
    create: (path) => writeFile(path, new Uint8Array(0)),
    append: (path, bytes) => appendFile(path, bytes),
    remove: (path) => rm(path, { force: true }),
  })
}
