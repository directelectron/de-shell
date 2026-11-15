/**
 * screenRecorderCore.test.ts — channel names, input validation, chunk order and
 * the empty-file cleanup of the screen recorder's IPC, against a fake ipcMain.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { bindRecorderIpc, recordingName, RECORDER_CHANNELS } from './screenRecorderCore.ts'
import type { RecorderDeps } from './screenRecorderCore.ts'
import type { IpcLike } from './shellIpcCore.ts'

function fakeIpc() {
  const handlers = new Map<string, (e: unknown, ...a: any[]) => unknown>()
  const ipc: IpcLike = {
    handle(ch, fn) {
      if (handlers.has(ch)) throw new Error(`second handler for ${ch}`)   // Electron does this
      handlers.set(ch, fn)
    },
    on() { throw new Error('the recorder only uses invoke') },
    removeHandler(ch) { handlers.delete(ch) },
    removeAllListeners() {},
  }
  const invoke = (name: string, ...a: unknown[]) => handlers.get(`app:${name}`)!({ sender: 'wc' }, ...a)
  return { ipc, handlers, invoke }
}

function fakeDisk(chosen: string | null = 'C:/v/app.mp4') {
  const files = new Map<string, number[]>()
  const asked: unknown[] = []
  const deps: RecorderDeps = {
    channel: n => `app:${n}`,
    choosePath: async (format, sender) => { asked.push([format, sender]); return chosen },
    create: async p => { files.set(p, []) },
    append: async (p, b) => { files.get(p)!.push(...b) },
    remove: async p => { files.delete(p) },
  }
  return { deps, files, asked }
}

test('the channels are the ones the preload spells', () => {
  const { ipc, handlers } = fakeIpc()
  bindRecorderIpc(ipc, fakeDisk().deps)
  assert.deepEqual([...handlers.keys()].sort(),
    Object.values(RECORDER_CHANNELS).map(n => `app:${n}`).sort())
})

test('registering twice replaces the handlers instead of throwing', () => {
  const { ipc } = fakeIpc()
  bindRecorderIpc(ipc, fakeDisk().deps)
  assert.doesNotThrow(() => bindRecorderIpc(ipc, fakeDisk().deps))
})

test('chunks land in the named file, in order, and stop counts them', async () => {
  const { ipc, invoke } = fakeIpc()
  const disk = fakeDisk()
  bindRecorderIpc(ipc, disk.deps)
  assert.equal(await invoke(RECORDER_CHANNELS.start, 'mp4'), 'C:/v/app.mp4')
  assert.deepEqual(disk.asked, [['mp4', 'wc']])
  await invoke(RECORDER_CHANNELS.chunk, new Uint8Array([1, 2]))
  await invoke(RECORDER_CHANNELS.chunk, new Uint8Array([3]))
  assert.equal(await invoke(RECORDER_CHANNELS.stop), 3)
  assert.deepEqual(disk.files.get('C:/v/app.mp4'), [1, 2, 3])
  // Closed: a late chunk is dropped rather than appended.
  await invoke(RECORDER_CHANNELS.chunk, new Uint8Array([9]))
  assert.deepEqual(disk.files.get('C:/v/app.mp4'), [1, 2, 3])
})

test('an unknown format is refused without asking the user', async () => {
  const { ipc, invoke } = fakeIpc()
  const disk = fakeDisk()
  bindRecorderIpc(ipc, disk.deps)
  assert.equal(await invoke(RECORDER_CHANNELS.start, '../../evil.exe'), null)
  assert.deepEqual(disk.asked, [])
})

test('a cancelled dialog opens nothing, and chunks are dropped', async () => {
  const { ipc, invoke } = fakeIpc()
  const disk = fakeDisk(null)
  bindRecorderIpc(ipc, disk.deps)
  assert.equal(await invoke(RECORDER_CHANNELS.start, 'webm'), null)
  await invoke(RECORDER_CHANNELS.chunk, new Uint8Array([1]))
  assert.equal(disk.files.size, 0)
})

test('a recording that never got a byte leaves no empty file', async () => {
  const { ipc, invoke } = fakeIpc()
  const disk = fakeDisk()
  bindRecorderIpc(ipc, disk.deps)
  await invoke(RECORDER_CHANNELS.start, 'webm')
  assert.ok(disk.files.has('C:/v/app.mp4'))
  assert.equal(await invoke(RECORDER_CHANNELS.stop), 0)
  assert.equal(disk.files.size, 0)
})

test('a chunk that is not bytes is ignored', async () => {
  const { ipc, invoke } = fakeIpc()
  const disk = fakeDisk()
  bindRecorderIpc(ipc, disk.deps)
  await invoke(RECORDER_CHANNELS.start, 'mp4')
  await invoke(RECORDER_CHANNELS.chunk, 'not bytes')
  await invoke(RECORDER_CHANNELS.chunk, [1, 2])
  assert.deepEqual(disk.files.get('C:/v/app.mp4'), [])
})

test('the file name is the app, the local time and the format', () => {
  assert.equal(recordingName('autopilot', new Date(2026, 10, 5, 9, 3, 7), 'mp4'),
    'autopilot-2026-11-05-09-03-07.mp4')
})
