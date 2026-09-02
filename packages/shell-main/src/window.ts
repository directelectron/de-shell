/**
 * window.ts — the app window, and getting backend messages into it.
 *
 * Both live apps had written this identically: create a BrowserWindow with the
 * preload attached, buffer backend messages until the renderer is listening,
 * flush them in order, and tee renderer console output to the terminal.
 *
 * The buffering is the part that is not obvious. Backend messages can arrive
 * before the renderer has finished loading and registered its `ipcRenderer`
 * listener, and `webContents.send()` DROPS anything sent before then — silently.
 * That swallowed the first message after any quiet period: in SpyDE, the
 * nav-shape prompt on opening a file (the dialog only appeared once a later load
 * pushed more messages); in a live app, the very first figure. So messages queue
 * until `did-finish-load` and are then flushed in order.
 */
import { BrowserWindow } from 'electron'
import { join } from 'path'
import { channel, shellConfig } from './config'

export interface ShellWindowOptions {
  /** Directory of the running main bundle — normally `__dirname`. Preload and
   *  renderer are resolved relative to it (`../preload`, `../renderer`). */
  mainDir: string
  width?: number
  height?: number
  backgroundColor?: string
  /** Extra BrowserWindow options, merged last. */
  browserWindow?: Electron.BrowserWindowConstructorOptions
  /** Tee renderer + figure-iframe console output to this process's stdout.
   *  Warnings and errors always; `logFilter` opts extra lines in. */
  teeConsole?: boolean
  /** Return true to tee a console message that is below warning level. */
  logFilter?: (message: string) => boolean
}

export interface ShellWindow {
  /** The window. Null once it has been closed. */
  get(): BrowserWindow | null
  /** Send a backend message to the renderer, buffering until it is listening. */
  sendToRenderer(msg: Record<string, unknown>): void
  /** Raw backend stdout/stderr, on the preload's `onStream` channel. Not
   *  buffered: a line that arrives before the renderer listens is a line
   *  nobody was going to read. */
  sendStream(text: string, kind: 'stdout' | 'stderr'): void
  /** True when there is a live window whose webContents is not destroyed. */
  alive(): boolean
}

/**
 * Create the app's window and its message pipe.
 *
 * Loads `ELECTRON_RENDERER_URL` when electron-vite's dev server set it, and the
 * built `../renderer/index.html` otherwise.
 */
export function createShellWindow(opts: ShellWindowOptions): ShellWindow {
  const cfg = shellConfig()
  const messageChannel = channel('message')
  const streamChannel = channel('stream')

  let win: BrowserWindow | null = null
  let rendererReady = false
  const pending: Array<Record<string, unknown>> = []

  const alive = () =>
    !!win && !win.isDestroyed() && !win.webContents.isDestroyed()

  const flush = () => {
    if (!alive()) return
    while (pending.length) win!.webContents.send(messageChannel, pending.shift())
  }

  const sendToRenderer = (msg: Record<string, unknown>) => {
    if (!rendererReady || !alive()) { pending.push(msg); return }
    win!.webContents.send(messageChannel, msg)
  }
  const sendStream = (text: string, kind: 'stdout' | 'stderr') => {
    if (rendererReady && alive()) win!.webContents.send(streamChannel, text, kind)
  }

  win = new BrowserWindow({
    width: opts.width ?? 1280,
    height: opts.height ?? 860,
    backgroundColor: opts.backgroundColor ?? '#14161c',
    // Shown on ready-to-show rather than immediately, so the user never sees an
    // empty white frame while the renderer boots.
    show: false,
    webPreferences: {
      preload: join(opts.mainDir, '..', 'preload', 'index.js'),
      sandbox: false,
    },
    ...opts.browserWindow,
  })

  win.once('ready-to-show', () => win?.show())
  win.webContents.on('did-finish-load', () => { rendererReady = true; flush() })
  // A reload (dev HMR, Ctrl+R) tears the listener down with the page. Close the
  // gate again so messages queue for the NEW page instead of being sent into a
  // frame that is going away — the exact loss the buffering exists to prevent.
  win.webContents.on('did-start-navigation', (_e, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) rendererReady = false
  })
  win.on('closed', () => { win = null; rendererReady = false })

  if (opts.teeConsole !== false) {
    // Renderer AND figure-iframe console output, so a JS error inside a figure
    // frame is visible without opening devtools and switching frame context.
    //
    // TWO event signatures, and getting this wrong fails SILENTLY — the tee
    // simply stops teeing, which is the worst way for a diagnostic to break.
    // Electron <35: (event, level: number, message, line, sourceId), where
    // level is 0=log 1=warning 2=error 3=info. Electron >=35: (event, details)
    // with a STRING level. Reading `level >= 1` off the details OBJECT is
    // always false, so every message is dropped.
    win.webContents.on('console-message', (...args: unknown[]) => {
      const [, second, third] = args
      let message: string
      let warnOrWorse: boolean
      if (second !== null && typeof second === 'object') {
        const d = second as { message?: string; level?: string | number }
        message = String(d.message ?? '')
        warnOrWorse = typeof d.level === 'number'
          ? d.level >= 1
          : d.level === 'warning' || d.level === 'error'
      } else {
        message = String(third ?? '')
        warnOrWorse = Number(second) >= 1
      }
      if (warnOrWorse || opts.logFilter?.(message)) {
        console.log(`[${cfg.appId} renderer] ${message}`)
      }
    })
  }

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(opts.mainDir, '..', 'renderer', 'index.html'))
  }

  return { get: () => win, sendToRenderer, sendStream, alive }
}
