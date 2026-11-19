/**
 * pythonEnv.test.ts — node:test unit tests for uv resolution.
 *
 * The dev-mode backend command used to be a bare 'uv', resolved by the OS at
 * spawn time — so a uv that is installed but not on the app's PATH (the winget
 * per-user install under an npm-run environment, the recurring case) failed as
 * an opaque `spawn uv ENOENT`. `findUv` resolves uv to an absolute path up
 * front: the PATH itself first, then the standard per-user install locations.
 *
 * The packaged branch has a second contract, and it is a Windows one: the
 * sidecar must not RUN OUT OF the install directory. A working directory is an
 * open handle that every process it spawns inherits, so a sidecar rooted there
 * keeps the installer from removing the old version — while staying invisible
 * to the app-running check, which can only match on executable path and finds
 * this interpreter in the managed env instead. That dead-ended a Windows
 * auto-update in "cannot be closed. Please close it manually and click Retry".
 *
 * Run: `node --test de_shell/js/main/pythonEnv.test.ts`, or via the `test:unit`
 * npm script.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { createHash } from 'crypto'
import { configureShell } from './config.ts'
import { parseUvLine } from './envProgress.ts'
import {
  findUv, resolvePythonEnv, hasNvidiaGpu, readWheelhouse, findWheelhouse,
  wheelhouseCandidates, lockStamp, buildSyncArgs, offlinePlan, effectiveExtras,
  gpuEnvOverride, platformMatches, fileUrl, checkWheelhouseExtras, venvPython, clearBrokenEnv,
  withoutPythonDownloadLines, uvNetworkEnv,
} from './pythonEnv.ts'
import {
  readTorchSetup, torchInstallArgs, probeTorch, ensureTorchPerMachine, recordEnvStamp,
  setupHasTorchStep,
} from './pythonEnv.ts'
import type { CommandRunner } from './pythonEnv.ts'

configureShell({
  appId: 'testapp',
  appName: 'Test App',
  pythonModule: 'testapp',
})

/** Every temp directory these tests make, removed when the file is done. */
const tempDirs: string[] = []
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** A directory containing a uv stub under both spellings, so these tests do not
 *  fork on the host platform. */
function dirWithUv(): string {
  const dir = tempDir('uv-stub-')
  writeFileSync(join(dir, 'uv'), '')
  writeFileSync(join(dir, 'uv.exe'), '')
  return dir
}

function emptyDir(): string {
  return tempDir('uv-none-')
}

/** An env whose PATH and every fallback root point somewhere we control. */
function envWith(overrides: Record<string, string>): Record<string, string> {
  const nowhere = emptyDir()
  return {
    PATH: '',
    HOME: nowhere,
    USERPROFILE: nowhere,
    LOCALAPPDATA: nowhere,
    ...overrides,
  }
}

test('findUv resolves uv from a PATH entry', () => {
  const dir = dirWithUv()
  const found = findUv(envWith({ PATH: dir }))
  assert.ok(found, 'uv not found on PATH')
  assert.ok(found.startsWith(dir), `${found} is not under ${dir}`)
})

test('findUv falls back to the standard per-user install dirs off PATH', () => {
  const home = emptyDir()
  mkdirSync(join(home, '.local', 'bin'), { recursive: true })
  writeFileSync(join(home, '.local', 'bin', 'uv'), '')
  writeFileSync(join(home, '.local', 'bin', 'uv.exe'), '')
  const found = findUv(envWith({ HOME: home, USERPROFILE: home }))
  assert.ok(found, 'uv not found in ~/.local/bin')
  assert.ok(found.startsWith(join(home, '.local', 'bin')))
})

test('findUv finds a winget-linked uv via LOCALAPPDATA', () => {
  const localAppData = emptyDir()
  const links = join(localAppData, 'Microsoft', 'WinGet', 'Links')
  mkdirSync(links, { recursive: true })
  writeFileSync(join(links, 'uv'), '')
  writeFileSync(join(links, 'uv.exe'), '')
  const found = findUv(envWith({ LOCALAPPDATA: localAppData }))
  assert.ok(found, 'uv not found in the winget Links dir')
  assert.ok(found.startsWith(links))
})

test('findUv returns null when uv is nowhere', () => {
  assert.equal(findUv(envWith({})), null)
})

test('dev-mode resolvePythonEnv spawns the resolved absolute uv', async () => {
  const dir = dirWithUv()
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME,
                  USERPROFILE: process.env.USERPROFILE, LOCALAPPDATA: process.env.LOCALAPPDATA }
  try {
    Object.assign(process.env, envWith({ PATH: dir }))
    const resolved = await resolvePythonEnv({
      isPackaged: false,
      resourcesPath: emptyDir(),
      projectRoot: emptyDir(),
      userData: emptyDir(),
    })
    assert.ok(resolved.cmd[0].startsWith(dir),
      `expected an absolute uv under ${dir}, got ${resolved.cmd[0]}`)
    assert.deepEqual(resolved.cmd.slice(1), ['run', 'python', '-m', 'testapp'])
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})

test('dev-mode resolvePythonEnv leaves a bare uv when none is found (the spawn trap reports it)', async () => {
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME,
                  USERPROFILE: process.env.USERPROFILE, LOCALAPPDATA: process.env.LOCALAPPDATA }
  try {
    Object.assign(process.env, envWith({}))
    const resolved = await resolvePythonEnv({
      isPackaged: false,
      resourcesPath: emptyDir(),
      projectRoot: emptyDir(),
      userData: emptyDir(),
    })
    assert.equal(resolved.cmd[0], 'uv')
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})

// ── extras, GPU probe, stamp ─────────────────────────────────────────────────

test('lockStamp is the bare hash with no extras (existing installs do not re-sync)', () => {
  assert.equal(lockStamp('abc', []), 'abc')
})

test('lockStamp appends sorted extras, order-insensitively', () => {
  assert.equal(lockStamp('abc', ['gpu', 'cuda']), 'abc+extras=cuda,gpu')
  assert.equal(lockStamp('abc', ['cuda', 'gpu']), lockStamp('abc', ['gpu', 'cuda']))
})

test('effectiveExtras adds gpuExtras only with a GPU, de-duplicated', () => {
  assert.deepEqual(effectiveExtras(['a'], ['gpu'], false), ['a'])
  assert.deepEqual(effectiveExtras(['a'], ['gpu'], true), ['a', 'gpu'])
  assert.deepEqual(effectiveExtras(['gpu'], ['gpu'], true), ['gpu'])
  assert.deepEqual(effectiveExtras(undefined, undefined, true), [])
})

test('buildSyncArgs passes --extra for each extra, torch skip last', () => {
  assert.deepEqual(
    buildSyncArgs(['--no-install-project'], ['gpu', 'x'], ['torch']),
    ['sync', '--frozen', '--no-dev', '--no-install-project',
     '--extra', 'gpu', '--extra', 'x', '--no-install-package', 'torch'])
  assert.deepEqual(buildSyncArgs([], []), ['sync', '--frozen', '--no-dev'])
})

const runner = (code: number | null, stdout = '') => async () => ({ code, stdout })

test('hasNvidiaGpu parses nvidia-smi -L output', async () => {
  assert.equal(await hasNvidiaGpu(runner(0, 'GPU 0: NVIDIA RTX A4000 (UUID: GPU-1)\n')), true)
  assert.equal(await hasNvidiaGpu(runner(0, '')), false)
  assert.equal(await hasNvidiaGpu(runner(0, 'No devices were found')), false)
  assert.equal(await hasNvidiaGpu(runner(9, 'GPU 0: x')), false)
  assert.equal(await hasNvidiaGpu(runner(null)), false)
})

test('hasNvidiaGpu never throws and asks for a ~5 s timeout', async () => {
  assert.equal(await hasNvidiaGpu(async () => { throw new Error('ENOENT') }), false)
  let seen: unknown[] = []
  await hasNvidiaGpu(async (cmd, args, t) => { seen = [cmd, args, t]; return { code: 1, stdout: '' } })
  assert.deepEqual(seen, ['nvidia-smi', ['-L'], 5000])
})

test('gpuEnvOverride reads <APPID>_GPU', () => {
  assert.equal(gpuEnvOverride({ TESTAPP_GPU: '0' }), false)
  assert.equal(gpuEnvOverride({ TESTAPP_GPU: '1' }), true)
  assert.equal(gpuEnvOverride({ TESTAPP_GPU: '' }), undefined)
  assert.equal(gpuEnvOverride({}), undefined)
})

// ── wheelhouse ───────────────────────────────────────────────────────────────

function wheelhouseDir(manifest: unknown): string {
  const dir = tempDir('wheelhouse-')
  writeFileSync(join(dir, 'wheelhouse.json'),
    typeof manifest === 'string' ? manifest : JSON.stringify(manifest))
  return dir
}

const goodManifest = {
  app: 'testapp', version: '1.2.3', platform: 'win_amd64', python: '3.13.12', extras: ['gpu'],
}

test('readWheelhouse parses a valid manifest', () => {
  assert.deepEqual(readWheelhouse(wheelhouseDir(goodManifest)), goodManifest)
})

test('readWheelhouse is null for missing, unparseable, or foreign manifests', () => {
  assert.equal(readWheelhouse(emptyDir()), null)
  assert.equal(readWheelhouse(wheelhouseDir('{not json')), null)
  assert.equal(readWheelhouse(wheelhouseDir({ ...goodManifest, app: 'other' })), null)
})

test('findWheelhouse returns the first valid directory', () => {
  const a = wheelhouseDir({ ...goodManifest, app: 'other' })
  const b = wheelhouseDir(goodManifest)
  const c = wheelhouseDir({ ...goodManifest, version: '9' })
  const found = findWheelhouse([emptyDir(), a, b, c])
  assert.equal(found?.dir, b)
  assert.equal(found?.manifest.version, '1.2.3')
  assert.equal(findWheelhouse([emptyDir()]), null)
})

test('wheelhouseCandidates are ordered option, env, resources, userData, exec dir', () => {
  const got = wheelhouseCandidates(
    { wheelhouse: '/opt', resourcesPath: '/res', userData: '/ud' },
    { TESTAPP_WHEELHOUSE: '/env' },
    join('/bin', 'app.exe'),
  )
  assert.deepEqual(got, ['/opt', '/env', join('/res', 'wheelhouse'),
    join('/ud', 'wheelhouse'), join('/bin', 'wheelhouse')])
  // Unset option / env are skipped, not left as holes.
  assert.deepEqual(
    wheelhouseCandidates({ wheelhouse: null, resourcesPath: '/res', userData: '/ud' }, {}, '/bin/app'),
    [join('/res', 'wheelhouse'), join('/ud', 'wheelhouse'), join('/bin', 'wheelhouse')])
})

test('platformMatches is loose but os/arch aware', () => {
  assert.equal(platformMatches('win_amd64', 'win32', 'x64'), true)
  assert.equal(platformMatches('win_amd64', 'linux', 'x64'), false)
  assert.equal(platformMatches('manylinux_2_28_x86_64', 'linux', 'x64'), true)
  assert.equal(platformMatches('macosx_11_0_arm64', 'darwin', 'arm64'), true)
  assert.equal(platformMatches('macosx_11_0_arm64', 'darwin', 'x64'), false)
})

test('fileUrl uses forward slashes with a three-slash drive form', () => {
  assert.equal(fileUrl('C:\\wh\\python'), 'file:///C:/wh/python')
  assert.equal(fileUrl('/wh/python'), 'file:///wh/python')
})

test('offlinePlan builds the python, venv, export, pip-install sequence', () => {
  const plan = offlinePlan({
    wheelhouse: join('/wh'), manifest: { python: '3.13.12' },
    envDir: join('/ud', 'python-env'), userData: '/ud', extras: ['gpu'],
  })
  assert.equal(plan.env.UV_OFFLINE, '1')
  assert.equal(plan.env.UV_PYTHON_DOWNLOADS, 'automatic')
  assert.ok(plan.env.UV_PYTHON_INSTALL_MIRROR.startsWith('file://'))
  assert.ok(plan.env.UV_PYTHON_INSTALL_MIRROR.endsWith('/python'))
  assert.deepEqual(plan.python, ['python', 'install', '3.13.12'])
  assert.deepEqual(plan.venv, ['venv', '--python', '3.13.12', '--managed-python',
    '--allow-existing', join('/ud', 'python-env')])
  assert.deepEqual(plan.export.slice(0, 7),
    ['export', '--frozen', '--no-dev', '--no-emit-project', '--no-emit-workspace',
     '--extra', 'gpu'])
  assert.equal(plan.export.at(-1), plan.requirementsFile)
  assert.equal(plan.requirementsFile, join('/ud', 'requirements.offline.txt'))
  for (const flag of ['--offline', '--no-index', '--require-hashes']) {
    assert.ok(plan.install.includes(flag), flag)
  }
  assert.equal(plan.install[plan.install.indexOf('--find-links') + 1], join('/wh'))
  assert.equal(plan.install[plan.install.indexOf('-r') + 1], plan.requirementsFile)
  assert.equal(plan.install.at(-1), venvPython(join('/ud', 'python-env')))
})

/** uv 0.13.4's output for the wheelhouse's interpreter step, piped (de-shell #31). */
const UV_PYTHON_FROM_MIRROR =
  'Downloading cpython-3.13.12-windows-x86_64-none (download) (20.7MiB)\n' +
  ' Downloaded cpython-3.13.12-windows-x86_64-none (download)\n' +
  'Installed Python 3.13.12 in 1.22s\n' +
  ' + cpython-3.13.12-windows-x86_64-none\n'

function relayed(chunks: string[]): string {
  const out: string[] = []
  const python = withoutPythonDownloadLines((s) => out.push(s))
  for (const chunk of chunks) python.relay(chunk)
  python.flush()
  return out.join('')
}

test('the wheelhouse interpreter step drops uv\'s download lines and keeps the rest', () => {
  assert.equal(relayed([UV_PYTHON_FROM_MIRROR]),
    'Installed Python 3.13.12 in 1.22s\n + cpython-3.13.12-windows-x86_64-none\n')
})

test('a download line split across chunks is still dropped whole', () => {
  const cut = UV_PYTHON_FROM_MIRROR.indexOf('(download) (20.7MiB)')
  assert.equal(relayed([UV_PYTHON_FROM_MIRROR.slice(0, cut), UV_PYTHON_FROM_MIRROR.slice(cut)]),
    'Installed Python 3.13.12 in 1.22s\n + cpython-3.13.12-windows-x86_64-none\n')
})

test('an unfinished last line reaches the progress stream at flush', () => {
  assert.equal(relayed(['error: no Python in the mirror']), 'error: no Python in the mirror')
})

test('the setup window reads the offline interpreter step as an install, never a download', () => {
  const lines = ('[env-setup] installing Python 3.13.12 from the wheelhouse\n' +
    relayed([UV_PYTHON_FROM_MIRROR])).split('\n')
  const events = lines.map(parseUvLine).filter((e) => e !== null)
  assert.equal(events[0]?.step, 'Installing Python 3.13.12 from the wheelhouse')
  assert.deepEqual(events.filter((e) => e.phase === 'downloading'), [])
})

test('checkWheelhouseExtras names the missing extra', () => {
  const m = { ...goodManifest, extras: [] }
  assert.throws(() => checkWheelhouseExtras(['gpu'], m), /built without the 'gpu' extra/)
  checkWheelhouseExtras([], m)   // gpu disabled → not effective → fine
  checkWheelhouseExtras(['gpu'], goodManifest)
})

// ── torch: locked, or installed per machine ─────────────────────────────────

/** A lock that pins torch, as SpyDE's does: the cu124 entry and the PyPI one. */
const LOCK_PINS_TORCH = `version = 1

[[package]]
name = "torch"
version = "2.6.0+cu124"
source = { registry = "https://download.pytorch.org/whl/cu124" }

[[package]]
name = "torch"
version = "2.6.0"
source = { registry = "https://pypi.org/simple" }
`

/** A lock written with `[tool.uv] exclude-dependencies = ["torch"]` (uv 0.10). */
const LOCK_EXCLUDES_TORCH = `version = 1
revision = 3
requires-python = ">=3.13"

[options]
prerelease-mode = "allow"

[manifest]
excludes = ["torch"]

[[package]]
name = "testapp"
version = "0.1.0"
source = { editable = "." }
dependencies = [
    { name = "six" },
]

[package.metadata]
requires-dist = [
    { name = "pytest", marker = "extra == 'tests'" },
    { name = "six" },
    { name = "torch", marker = "extra == 'cuda'", specifier = ">=9" },
    { name = "torch", specifier = ">=2.4,<3" },
]
`

function projectWithLock(lock: string): string {
  const dir = tempDir('project-')
  writeFileSync(join(dir, 'uv.lock'), lock)
  return dir
}

test('readTorchSetup: a lock that pins torch is the locked two-step', () => {
  assert.deepEqual(readTorchSetup(projectWithLock(LOCK_PINS_TORCH)),
    { kind: 'locked', version: '2.6.0' })
})

test('readTorchSetup: a lock that excludes torch installs it per machine, with its specifier', () => {
  assert.deepEqual(readTorchSetup(projectWithLock(LOCK_EXCLUDES_TORCH)),
    { kind: 'per-machine', requirement: 'torch>=2.4,<3' })
})

test('readTorchSetup: a bare torch dependency, and a multi-line excludes list', () => {
  const lock = LOCK_EXCLUDES_TORCH
    .replace('excludes = ["torch"]', 'excludes = [\n    "numpy",\n    "torch",\n]')
    .replace('{ name = "torch", specifier = ">=2.4,<3" }', '{ name = "torch" }')
  assert.deepEqual(readTorchSetup(projectWithLock(lock)),
    { kind: 'per-machine', requirement: 'torch' })
})

test('readTorchSetup: no torch, another exclusion, or no lock at all is none', () => {
  assert.deepEqual(readTorchSetup(projectWithLock('version = 1\n')), { kind: 'none' })
  assert.deepEqual(
    readTorchSetup(projectWithLock(LOCK_EXCLUDES_TORCH.replace('["torch"]', '["numpy"]'))),
    { kind: 'none' })
  // `excludes` outside [manifest] is not uv's exclusion list.
  assert.deepEqual(
    readTorchSetup(projectWithLock('version = 1\n\n[options]\nexcludes = ["torch"]\n')),
    { kind: 'none' })
  assert.deepEqual(readTorchSetup(emptyDir()), { kind: 'none' })
})

test('readTorchSetup: excluding torch the app does not declare is none, not per machine', () => {
  // Only a torch the app names as a dependency is installed per machine.
  const lock = LOCK_EXCLUDES_TORCH
    .replace(/^ {4}\{ name = "torch".*\n/gm, '')
  assert.ok(!lock.includes('name = "torch"'))
  assert.deepEqual(readTorchSetup(projectWithLock(lock)), { kind: 'none' })
})

test('the PyTorch step: none for an app with no torch, shown for locked and per machine', () => {
  // Ground Crew (no torch), SpyDE (locked), Autopilot (per machine).
  assert.equal(setupHasTorchStep(projectWithLock('version = 1\n')), false)
  assert.equal(setupHasTorchStep(projectWithLock(LOCK_PINS_TORCH)), true)
  assert.equal(setupHasTorchStep(projectWithLock(LOCK_EXCLUDES_TORCH)), true)
})

test('buildSyncArgs syncs inexactly on request, so a per-machine torch survives', () => {
  assert.deepEqual(buildSyncArgs(['--no-install-project'], [], [], true),
    ['sync', '--frozen', '--no-dev', '--inexact', '--no-install-project'])
  assert.ok(!buildSyncArgs([], []).includes('--inexact'))
})

test('torchInstallArgs keeps the locked pin unchanged', () => {
  assert.deepEqual(torchInstallArgs({ kind: 'locked', version: '2.6.0' }, 'py'),
    ['pip', 'install', 'torch==2.6.0', '--torch-backend=auto', '--python', 'py'])
})

test('torchInstallArgs: per machine, no pin — the backend picks the build, the app config stays out', () => {
  const args = torchInstallArgs({ kind: 'per-machine', requirement: 'torch' }, 'py')
  assert.deepEqual(args,
    ['pip', 'install', '--no-config', 'torch', '--torch-backend=auto', '--python', 'py'])
  assert.ok(!args!.some((a) => a.startsWith('torch==')))
})

test('torchInstallArgs: reinstall replaces a damaged torch, upgrade a build without kernels', () => {
  const args = torchInstallArgs({ kind: 'per-machine', requirement: 'torch' }, 'py', { reinstall: true })
  assert.equal(args![args!.indexOf('--reinstall-package') + 1], 'torch')
  const upgrade = torchInstallArgs({ kind: 'per-machine', requirement: 'torch' }, 'py', { upgrade: true })
  assert.equal(upgrade![upgrade!.indexOf('--upgrade-package') + 1], 'torch')
  assert.ok(!upgrade!.includes('--reinstall-package'))
  const locked = torchInstallArgs({ kind: 'locked', version: '2.6.0' }, 'py', { reinstall: true })
  assert.ok(locked!.includes('--reinstall-package'))
})

test('torchInstallArgs: from a wheelhouse, offline from the folder and no backend probe', () => {
  const args = torchInstallArgs({ kind: 'per-machine', requirement: 'torch' }, 'py', { wheelhouse: '/wh' })!
  for (const flag of ['--offline', '--no-index', '--no-config']) assert.ok(args.includes(flag), flag)
  assert.equal(args[args.indexOf('--find-links') + 1], '/wh')
  assert.ok(!args.includes('--torch-backend=auto'))
})

test('torchInstallArgs is null for an app with no torch', () => {
  assert.equal(torchInstallArgs({ kind: 'none' }, 'py'), null)
})

/** A probe runner answering with each code in turn (stdout `out`), recording its calls. */
function probes(...answers: Array<[number | null, string?]>): CommandRunner & { calls: string[][] } {
  const calls: string[][] = []
  const run = async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args])
    const [code, out] = answers.shift() ?? [0, '2.9.1']
    return { code, stdout: out ?? '' }
  }
  return Object.assign(run, { calls })
}

test('probeTorch reads the probe exit code, isolated from PYTHONPATH', async () => {
  const run = probes([0, '2.9.1+cu128\n'], [3], [4, 'OSError: [WinError 126] c10.dll\n'],
    [5, '2.6.0+cu124\nNVIDIA GeForce RTX 5090\n'], [null], [1])
  assert.deepEqual(await probeTorch('py', run), { state: 'usable', version: '2.9.1+cu128' })
  assert.deepEqual(await probeTorch('py', run), { state: 'missing' })
  assert.deepEqual(await probeTorch('py', run),
    { state: 'broken', detail: 'OSError: [WinError 126] c10.dll' })
  assert.deepEqual(await probeTorch('py', run),
    { state: 'no-kernels', version: '2.6.0+cu124', device: 'NVIDIA GeForce RTX 5090' })
  assert.deepEqual(await probeTorch('py', run), { state: 'unknown' })   // timed out
  assert.deepEqual(await probeTorch('py', run), { state: 'unknown' })   // Python itself failed
  assert.deepEqual(run.calls[0].slice(0, 3), ['py', '-I', '-c'])
  assert.deepEqual(await probeTorch('py', async () => { throw new Error('ENOENT') }),
    { state: 'unknown' })
})

/** ensureTorchPerMachine with fakes: the uv calls it made and what it narrated. */
async function ensure(
  probe: CommandRunner,
  o: { uvFails?: boolean; wheelhouse?: boolean } = {},
): Promise<{
  ready: boolean; uv: string[][]; env: Array<Record<string, string> | undefined>; said: string
}> {
  const uv: string[][] = []
  const env: Array<Record<string, string> | undefined> = []
  const said: string[] = []
  const ready = await ensureTorchPerMachine({
    requirement: 'torch',
    pythonExe: 'py',
    wheelhouse: o.wheelhouse ? { dir: '/wh', env: { UV_OFFLINE: '1' } } : null,
    uv: async (args, _progress, extraEnv) => {
      uv.push(args)
      env.push(extraEnv)
      if (o.uvFails) throw new Error('uv pip exited with code 1')
    },
    onProgress: (line) => said.push(line),
    probe,
  })
  return { ready, uv, env, said: said.join('') }
}

test('ensureTorchPerMachine keeps a usable torch: an upgrade downloads nothing', async () => {
  const r = await ensure(probes([0, '2.9.1+cu128']))
  assert.equal(r.ready, true)
  assert.deepEqual(r.uv, [])
  assert.match(r.said, /keeping the installed PyTorch 2\.9\.1\+cu128/)
})

test('ensureTorchPerMachine installs a missing torch for this machine', async () => {
  const r = await ensure(probes([3], [0, '2.9.1+cu128']))
  assert.equal(r.ready, true)
  assert.deepEqual(r.uv,
    [['pip', 'install', '--no-config', 'torch', '--torch-backend=auto', '--python', 'py']])
  assert.match(r.said, /installing torch for this machine with --torch-backend=auto/)
})

test('ensureTorchPerMachine reinstalls a torch that does not load', async () => {
  const r = await ensure(probes([4, 'ImportError: x'], [0, '2.9.1+cu128']))
  assert.equal(r.ready, true)
  assert.ok(r.uv[0].includes('--reinstall-package'))
  assert.match(r.said, /does not load \(ImportError: x\)/)
})

test('ensureTorchPerMachine upgrades a torch with no kernels for this GPU (the sm_120 case)', async () => {
  const r = await ensure(probes([5, '2.6.0+cu124\nNVIDIA GeForce RTX 5090'], [0, '2.11.0+cu128']))
  assert.equal(r.ready, true)
  assert.ok(r.uv[0].includes('--upgrade-package'))
  assert.ok(!r.uv[0].includes('--reinstall-package'))
  assert.match(r.said, /2\.6\.0\+cu124 has no kernels for NVIDIA GeForce RTX 5090/)
})

test('ensureTorchPerMachine leaves a torch it could not check alone', async () => {
  const r = await ensure(probes([null]))
  assert.equal(r.ready, true)
  assert.deepEqual(r.uv, [])
})

test('a failed torch install is said, not thrown, and reports torch not ready', async () => {
  const r = await ensure(probes([3]), { uvFails: true })
  assert.equal(r.ready, false)
  assert.match(r.said,
    /PyTorch could not be installed \(uv pip exited with code 1\)\. Test App will start without it/)
})

test('a torch still missing or broken after the install is not ready', async () => {
  assert.equal((await ensure(probes([3], [3]))).ready, false)
  assert.equal((await ensure(probes([3], [4, 'ImportError: x']))).ready, false)
})

test('a build without kernels for this GPU after the install is kept, and says why', async () => {
  // A card the newer builds dropped (Pascal on cu128): retrying would not help.
  const r = await ensure(probes([3], [5, '2.11.0+cu128\nNVIDIA TITAN X (Pascal)']))
  assert.equal(r.ready, true)
  assert.match(r.said, /PyTorch 2\.11\.0\+cu128 has no kernels for NVIDIA TITAN X \(Pascal\)/)
  assert.match(r.said, /it will run on the CPU/)
})

test('from a wheelhouse, torch comes from the folder or not at all, and says so', async () => {
  const ok = await ensure(probes([3], [0, '2.9.1+cpu']), { wheelhouse: true })
  assert.equal(ok.ready, true)
  assert.ok(ok.uv[0].includes('--offline'))
  assert.deepEqual(ok.env[0], { UV_OFFLINE: '1' })

  const missing = await ensure(probes([3]), { wheelhouse: true, uvFails: true })
  assert.equal(missing.ready, false)
  assert.match(missing.said, /the wheelhouse has no torch wheel for this machine/)
  assert.match(missing.said, /Add the torch wheels for this machine to the wheelhouse folder/)

  // Offline, a torch without kernels for the GPU is kept: there is nothing to fetch.
  const kept = await ensure(probes([5, 'RTX 5090']), { wheelhouse: true })
  assert.equal(kept.ready, true)
  assert.deepEqual(kept.uv, [])
})

test('recordEnvStamp writes the stamp, or drops it when torch is not ready', () => {
  const stampFile = join(tempDir('stamp-'), 'python-env', '.testapp-lock-hash')
  recordEnvStamp(stampFile, 'abc', true)
  assert.equal(existsSync(stampFile), true)
  // Not ready: the next launch must run setup again to retry torch.
  recordEnvStamp(stampFile, 'def', false)
  assert.equal(existsSync(stampFile), false)
})

test('the setup window narrates the per-machine torch step', () => {
  const sync = parseUvLine('[env-setup] running uv sync (as locked, keeping the per-machine torch)')
  assert.equal(sync?.phase, 'resolving')
  const install = parseUvLine('[env-setup] installing torch for this machine with --torch-backend=auto')
  assert.equal(install?.step, 'Installing PyTorch for your GPU')
  assert.equal(parseUvLine('[env-setup] keeping the installed PyTorch 2.9.1')?.step,
    'Keeping the installed PyTorch 2.9.1')
  const failed = parseUvLine('[env-setup] PyTorch could not be installed (x). Test App will start without it.')
  assert.equal(failed?.phase, 'torch')
  assert.match(failed?.step ?? '', /could not be installed/)
})

/** A packaged layout whose managed env already matches the shipped lock, so
 *  resolvePythonEnv() answers from disk without shelling out to uv. */
function packagedLayout(): { resourcesPath: string; userData: string; envDir: string } {
  const root = tempDir('packaged-')
  const resourcesPath = join(root, 'resources')
  const userData = join(root, 'userData')
  const projectDir = join(resourcesPath, 'python')
  const envDir = join(userData, 'python-env')
  const lock = 'version = 1\n'

  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, 'uv.lock'), lock)

  const python = venvPython(envDir)
  mkdirSync(dirname(python), { recursive: true })
  writeFileSync(python, '')
  writeFileSync(
    join(envDir, '.testapp-lock-hash'),
    createHash('sha256').update(Buffer.from(lock)).digest('hex'),
  )
  return { resourcesPath, userData, envDir }
}

test('packaged resolvePythonEnv does not run out of the install directory', async () => {
  const { resourcesPath, userData } = packagedLayout()

  const resolved = await resolvePythonEnv({
    isPackaged: true, resourcesPath, projectRoot: '/unused', userData,
  })

  assert.ok(
    !resolved.cwd.startsWith(resourcesPath),
    `cwd ${resolved.cwd} is inside the install directory ${resourcesPath}`,
  )
})

test('packaged resolvePythonEnv runs from the managed env with the env interpreter', async () => {
  const { resourcesPath, userData, envDir } = packagedLayout()

  const resolved = await resolvePythonEnv({
    isPackaged: true, resourcesPath, projectRoot: '/unused', userData,
  })

  assert.equal(resolved.cwd, envDir)
  assert.deepEqual(resolved.cmd, [venvPython(envDir), '-m', 'testapp'])
})

// ── a half-removed env ───────────────────────────────────────────────────────

test('clearBrokenEnv removes an env dir with no pyvenv.cfg, past MAX_PATH', () => {
  // What an uninstall that could not delete long paths leaves behind: uv
  // refuses the directory, so first launch would fail until it is gone.
  const envDir = join(tempDir('broken-env-'), 'python-env')
  const deep = join(envDir, 'share', 'jupyter', 'labextensions', 'x'.repeat(120), 'y'.repeat(120))
  mkdirSync(deep, { recursive: true })
  writeFileSync(join(deep, 'z'.repeat(60) + '.js.map'), '')
  assert.equal(clearBrokenEnv(envDir), true)
  assert.equal(existsSync(envDir), false)
})

test('clearBrokenEnv keeps a real venv and ignores a missing dir', () => {
  const envDir = join(tempDir('venv-'), 'python-env')
  mkdirSync(envDir, { recursive: true })
  writeFileSync(join(envDir, 'pyvenv.cfg'), 'home = x\n')
  assert.equal(clearBrokenEnv(envDir), false)
  assert.equal(existsSync(join(envDir, 'pyvenv.cfg')), true)
  assert.equal(clearBrokenEnv(join(tempDir('none-'), 'python-env')), false)
})

test('uvNetworkEnv trusts the system certificate store under both spellings', () => {
  const added = uvNetworkEnv({}, false)
  assert.equal(added.UV_SYSTEM_CERTS, '1')
  assert.equal(added.UV_NATIVE_TLS, '1')
  assert.equal(added.GIT_CONFIG_COUNT, undefined)
})

test('uvNetworkEnv leaves a certificate choice the user made, including 0', () => {
  assert.deepEqual(uvNetworkEnv({ UV_SYSTEM_CERTS: '0' }, false), {})
  assert.deepEqual(uvNetworkEnv({ UV_NATIVE_TLS: '0' }, false), {})
})

test('uvNetworkEnv turns on git long paths on Windows', () => {
  const added = uvNetworkEnv({}, true)
  assert.equal(added.GIT_CONFIG_COUNT, '1')
  assert.equal(added.GIT_CONFIG_KEY_0, 'core.longpaths')
  assert.equal(added.GIT_CONFIG_VALUE_0, 'true')
})

test('uvNetworkEnv appends to git environment config already set', () => {
  const added = uvNetworkEnv({ GIT_CONFIG_COUNT: '2' }, true)
  assert.equal(added.GIT_CONFIG_COUNT, '3')
  assert.equal(added.GIT_CONFIG_KEY_2, 'core.longpaths')
  assert.equal(added.GIT_CONFIG_KEY_0, undefined)
})

test('the building step names the configured app, not SpyDE', () => {
  const event = parseUvLine('Building test-app @ file:///C:/app')
  assert.equal(event?.step, 'Building the Test App package')
})
