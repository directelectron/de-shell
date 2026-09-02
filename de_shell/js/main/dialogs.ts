/**
 * dialogs.ts — native open/save dialogs, on the shell's channel.
 *
 * A sandboxed renderer cannot open a file dialog and has no filesystem paths,
 * so this is the only way an app can ask the user for a file. Registered once
 * per app by `registerShellDialogs`, on `<appId>:open-file` /
 * `<appId>:open-directory` / `<appId>:save-file`.
 *
 * All resolve to a PATH or null. Null means cancelled, which is a normal
 * outcome and not an error — the caller should do nothing rather than report a
 * failure.
 */
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'

import { channel } from './config'

export interface FileFilter { name: string; extensions: string[] }

/** Protocols a renderer may hand to the OS browser. Deliberately no `file:` —
 *  the web allowlist must never be talked into opening a local path. */
const EXTERNAL_PROTOCOLS = new Set(['https:', 'http:', 'mailto:'])

/** Wire the open/save dialog handlers and the external-link opener. Call
 *  once, after `configureShell`. */
export function registerShellDialogs(): void {
  // Unprefixed on purpose: the preload sends on 'open-external' for every app.
  ipcMain.on('open-external', (_e, url: string) => {
    try {
      if (EXTERNAL_PROTOCOLS.has(new URL(String(url)).protocol)) void shell.openExternal(url)
    } catch { /* not a URL — ignore */ }
  })

  ipcMain.handle(channel('open-file'), async (event, filters?: FileFilter[]) => {
    // Parent the dialog to the window that asked, so it is modal to that
    // window rather than floating free of the app.
    const win = BrowserWindow.fromWebContents(event.sender)
    const opts = { properties: ['openFile' as const], filters }
    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts)
    return result.canceled || !result.filePaths.length ? null : result.filePaths[0]
  })

  ipcMain.handle(channel('open-directory'), async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const opts = { properties: ['openDirectory' as const] }
    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts)
    return result.canceled || !result.filePaths.length ? null : result.filePaths[0]
  })

  ipcMain.handle(channel('save-file'),
    async (event, filters?: FileFilter[], defaultPath?: string) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const opts = { filters, defaultPath }
      const result = win
        ? await dialog.showSaveDialog(win, opts)
        : await dialog.showSaveDialog(opts)
      return result.canceled || !result.filePath ? null : result.filePath
    })
}
