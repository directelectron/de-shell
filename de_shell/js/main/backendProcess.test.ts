/**
 * backendProcess.test.ts — node:test unit tests for the sidecar spawn-error path.
 *
 * Guards the `spawn uv ENOENT` trap: a backend command that does not exist must
 * surface a READABLE stream line and a synthetic `backend_exited` message — not
 * crash the Electron main process with an unhandled ChildProcess 'error' event,
 * which is exactly what an unlisted 'error' emitter does.
 *
 * Run: `node --test src/backendProcess.test.ts` (from packages/shell-main/), or
 * via the `test:unit` npm script.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { configureShell } from './config.ts'
import { startBackend, stopBackend } from './backendProcess.ts'

configureShell({
  appId: 'testapp',
  appName: 'Test App',
  pythonModule: 'testapp',
})

function collectBackend(cmd: string[]) {
  const streams: string[] = []
  const messages: Array<Record<string, unknown>> = []
  startBackend(cmd, {
    onMessage: (m) => messages.push(m),
    onStream: (t) => streams.push(t),
  })
  return { streams, messages }
}

async function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now()
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 25))
  }
}

test('a nonexistent backend command reports readably instead of crashing', async () => {
  const { streams, messages } = collectBackend(['definitely-not-a-real-command-xyz'])
  try {
    await waitFor(() => messages.some((m) => m.type === 'backend_exited'))
  } finally {
    stopBackend()
  }
  const text = streams.join('')
  // The failing command is named — "something went wrong" is not a report.
  assert.match(text, /definitely-not-a-real-command-xyz/)
  // And the cause is stated in words, not only an errno.
  assert.match(text, /not found|could not be started/i)
})

test('a missing uv names uv and says how to fix it', async () => {
  // The dev-mode backend command is `uv run …`; when uv is absent the operator
  // needs "install uv / put it on PATH", not a bare ENOENT stack.
  const { streams, messages } = collectBackend([
    'uv-definitely-not-installed-xyz.exe', 'run', 'python', '-m', 'testapp',
  ])
  try {
    await waitFor(() => messages.some((m) => m.type === 'backend_exited'))
  } finally {
    stopBackend()
  }
  const exited = messages.find((m) => m.type === 'backend_exited')
  assert.ok(exited, 'no backend_exited message arrived')
  const text = streams.join('')
  assert.match(text, /PATH/i)
})

test('a clean exit is reported once, after the output closes', async () => {
  const { messages } = collectBackend([process.execPath, '-e', 'process.exit(3)'])
  try {
    await waitFor(() => messages.some((m) => m.type === 'backend_exited'))
    await new Promise((r) => setTimeout(r, 1500))
  } finally {
    stopBackend()
  }
  const exits = messages.filter((m) => m.type === 'backend_exited')
  assert.deepEqual(exits, [{ type: 'backend_exited', code: 3 }])
})

// On Windows a child's pipes report closed when it exits, even while a
// process it started still writes to them, so there is no case to construct.
const outputOutlivesExit = process.platform !== 'win32'

test('an exit whose output a child keeps open is reported without waiting for it',
  { skip: !outputOutlivesExit && 'pipes close at exit on Windows' }, async () => {
  // The packaged layout: the spawned launcher exits while the interpreter it
  // started still holds the same stdout and stderr.
  const holdsOutput = "require('child_process').spawn(process.execPath, " +
    "['-e', 'setTimeout(() => {}, 6000)'], { stdio: 'inherit' }); process.exit(0)"
  const started = Date.now()
  const { messages } = collectBackend([process.execPath, '-e', holdsOutput])
  try {
    await waitFor(() => messages.some((m) => m.type === 'backend_exited'))
  } finally {
    stopBackend()
  }
  assert.ok(Date.now() - started < 5000, 'the exit waited for the output to close')
  const exited = messages.find((m) => m.type === 'backend_exited')
  assert.deepEqual(exited, { type: 'backend_exited', code: 0, stdio_open: true })
})
