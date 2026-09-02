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

## One package

The shell is **one pip package, `de-shell`**, and the TypeScript rides
inside the wheel:

```
pyproject.toml          the package: de-shell
de_shell/               app loop, session base, actions, IPC, figures, compute, logging
de_shell/js/            the TypeScript half, one folder per Electron target
  main/                 Electron main: window, sidecar + stdout demuxer, python env, updater, reports
  preload/              the contextBridge surface (exposeShellBridge)
  renderer/             React: figure bridge, FigureFrame, the chrome slice of state
  testing/              the Playwright harness (launchApp)
tests/                  the Python suite (incl. the boundary test)
package.json            DEV ONLY: typechecks and unit-tests de_shell/js; nothing is published to npm
```

The JavaScript that speaks the sidecar protocol ships in the same artifact
as the Python that speaks it. One `pip install -U de-shell` moves both, and
an app cannot end up with the two halves at different versions. The
TypeScript is shipped as **source** and compiled by the consuming app's
bundler, so there is no build step here and an editable install is
live-editable from the app.

## Checking it

```bash
uv sync --extra tests && uv run pytest        # the Python suite
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install   # types only; drop the variable to run Electron
npm run typecheck                             # every target, tests included, under tsconfig.json
npm run test:unit                             # node --test over de_shell/js
uv build                                      # the wheel — check it carries de_shell/js
```

The unit tests run under Node's native type stripping, which resolves
relative imports literally — so shell modules import their siblings with the
`.ts` extension spelled out, and every tsconfig that compiles them (this one
and each app's) sets `allowImportingTsExtensions`.

## Consuming it

**Python** — an ordinary dependency. Until it is on PyPI, a path or git
source:

```toml
dependencies = ["de-shell"]

[tool.uv.sources]
de-shell = { path = "../de-shell", editable = true }   # a sibling checkout
# de-shell = { git = "https://github.com/directelectron/de-shell" }
```

**Electron** — ask the installed package where its TypeScript is and link
it into the project at a fixed path, then alias and `paths` through the link:

```
python -m de_shell.js        # prints …/de_shell/js
```

Autopilot's `electron/scripts/shell-link.mjs` is the reference: it makes
`electron/shell` a junction (a symlink off Windows) to that folder, runs from
npm's postinstall and from the vite config on every build, and re-points a
stale link rather than trusting it. With it in place:

```ts
// electron.vite.config.ts
const shell = ensureShellLink(__dirname)
resolve: { alias: { '@de/shell-main': resolve(shell, 'main', 'index.ts') },
           dedupe: ['react', 'react-dom'] }
```

```json
// tsconfig.json
"noEmit": true, "allowImportingTsExtensions": true,
"paths": { "@de/shell-main": ["./shell/main/index.ts"], … }
```

`dedupe` matters: an editable checkout carries its own `node_modules` for
its typecheck, and without it the renderer would bundle a second React. The
peer dependencies — react, electron, electron-updater, @playwright/test —
are the app's to declare; every app already does. The e2e specs take the
harness from `shell/testing/harness.cjs`.

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
  the renderer state and FigureFrame changes.
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
  binary frames over the sidecar's stdio. Both halves of it live in this one
  package on purpose; keep it that way.
* **LF line endings**, enforced by `.gitattributes`.

GPL-3.0-or-later, as SpyDE.
