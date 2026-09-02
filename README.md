# DE Shell

The substrate Direct Electron's desktop apps are assembled from: **SpyDE**
(offline analysis), **Ground Crew** (manual camera control) and **Autopilot**
(automated acquisition). Each app is an Electron window over a Python
sidecar, and everything the three have in common lives here — the
Python↔JS message pipe, the window and its menus, the figure bridge over
anyplotlib, the sidecar process manager and its Python environment, the
updater, the problem reporter, the Playwright harness.

It contains **no domain logic**. No detectors, no microscopes, no signal
types, no analysis. `tests/test_boundary.py` enforces that in a clean
subprocess: the shell must stay installable without the science stack, so
the live in-memory apps never acquire it transitively.

## Layout

```
pyproject.toml          the Python package: de-shell
de_shell/               app loop, session base, actions, IPC, figures, compute, logging
tests/                  its suite (incl. the boundary test)
package.json            the npm workspace root: packages/*
packages/
  shell-main/           @de/shell-main     Electron main: window, sidecar, python env, updater, reports
  shell-preload/        @de/shell-preload  the contextBridge surface
  shell-renderer/       @de/shell-renderer React: figure bridge, FigureFrame, the chrome slice of state
  shell-testing/        @de/shell-testing  the Playwright harness (launchApp)
```

The npm packages ship as **source** (`main: src/index.ts`): the consuming
app's bundler compiles them, so editing the shell and running the app needs
no build step in between.

## Checking it

```bash
uv sync --extra tests && uv run pytest        # the Python suite
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install   # types only; drop the variable to run Electron
npm run typecheck                             # every package, tests included, under tsconfig.json
npm run test:unit                             # node --test, per package
```

The unit tests run under Node's native type stripping, which resolves
relative imports literally — so shell modules import their siblings with the
`.ts` extension spelled out, and every tsconfig that compiles them (this one
and each app's) sets `allowImportingTsExtensions`.

## Consuming it

**Python** — a path or git source in the app's `pyproject.toml`:

```toml
dependencies = ["de-shell"]

[tool.uv.sources]
de-shell = { path = "../de-shell", editable = true }   # a sibling checkout
# de-shell = { git = "https://github.com/directelectron/de-shell" }
```

**Electron** — the packages as `file:` (or git) dev dependencies of the
app's `electron/package.json`, resolved through node_modules and aliased to
their sources so the bundler compiles them:

```json
"@de/shell-main":     "file:../../de-shell/packages/shell-main",
"@de/shell-preload":  "file:../../de-shell/packages/shell-preload",
"@de/shell-renderer": "file:../../de-shell/packages/shell-renderer",
"@de/shell-testing":  "file:../../de-shell/packages/shell-testing"
```

```ts
// electron.vite.config.ts
import { createRequire } from 'node:module'
const req = createRequire(__filename)
const shellMain = req.resolve('@de/shell-main')          // …/src/index.ts, via exports
resolve: { alias: { '@de/shell-main': shellMain }, dedupe: ['react', 'react-dom'] }
```

`dedupe` matters: a shell checkout with its own `node_modules` would
otherwise hand the renderer a second React. The tsconfig `paths` entries
point at the same files through `node_modules/@de/shell-*/src/index.ts`, with
`allowImportingTsExtensions: true` and `noEmit: true`.

Autopilot is wired this way; SpyDE and Ground Crew still carry copies under
their own `packages/` and are the next to move.

## Provenance

Merged 2026-09-02 from the three vendored copies, three-way against the
SpyDE commit the app copies were taken from:

* SpyDE `main` @ 1f3331d (v0.4.3): the problem reporter (`errorReport`,
  `problemLog`, `sentryEnvelope`), `recentBackendOutput`, the workspace-member
  wheels in `pythonEnv`, the update handoff that tree-kills the sidecar first,
  `run_on_worker`'s in-flight count and `ComputeHandle` in `lifecycle.py`.
* Autopilot @ 7f0651e: the sidecar's close handler forgets only ITS child, the
  malformed-message report, the figure/stream fixes ported from the siblings,
  the shell-renderer state and FigureFrame changes.
* Ground Crew `main` @ 26e853a: the spawn-error trap and 5 s tree-kill grace,
  the resolved `uv` path, the open-directory dialog, `_pin_tile_band` (black
  panes on large stills), JSON emit that never writes bare `NaN`, the harness
  hardening, and the unit tests for all of it.

Not yet included: Ground Crew's `dev/instrument-actions` shell deltas
(`stdoutDemux`, `sizeReporter`, the `frameBytes` transport) — they ride a
branch that has not merged.

## Rules

* **Nothing here mentions a detector, a signal type, or an analysis.** If
  extracting something into the shell requires touching one, the boundary is
  in the wrong place.
* **The Python side stays tiny.** Every dependency added is one all three
  apps install: numpy, anyplotlib, pyyaml, and that is the list.
* **The protocol is the contract.** `PLOTAPP:` JSON lines and `PLOTBIN:`
  binary frames over the sidecar's stdio; a change here is a change for
  three apps, so it is versioned and documented with the code.
* **LF line endings**, enforced by `.gitattributes`.

GPL-3.0-or-later, as SpyDE.
