# Changelog

All notable changes to `de-shell`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), the versioning is
[semver](https://semver.org/) with the 0.x caveat: a breaking change to the
sidecar protocol bumps the minor.

## [Unreleased]

## [0.2.0] — 2026-09-02

The first release as its own package. Until now the shell lived as a vendored
copy inside each of SpyDE, Ground Crew and Autopilot, and the three had
diverged.

### Added
- **One package.** The TypeScript half (`de_shell/js`: the Electron main
  process, the preload bridge, the React renderer kernel, the Playwright
  harness) ships inside the wheel, so `pip install -U de-shell` moves both
  halves of the sidecar protocol together. `python -m de_shell.js` prints where
  the tree is; apps link it into their Electron project.
- From SpyDE 0.4.3: the problem reporter (`errorReport`, `problemLog`,
  `sentryEnvelope`), `recentBackendOutput`, workspace-member wheels in the
  environment setup, an update handoff that tree-kills the sidecar first,
  `run_on_worker`'s in-flight count and `ComputeHandle` for cancelling a
  superseded compute.
- From Ground Crew: the sidecar spawn-error trap, a 5 s tree-kill grace, a
  resolved `uv` path, the open-directory dialog channel, `_pin_tile_band` for
  large stills, JSON emit that never writes bare `NaN`, harness hardening, and
  the unit tests for all of it.
- From Autopilot: the close handler forgets only its own child process, a
  report for malformed protocol messages, `useFigureEventForwarding`, and a
  `LOG_CLEAR` action in the renderer state.

### Changed
- License: MIT (the vendored copies were GPL-3.0-or-later inside SpyDE).
- Line endings are LF throughout, enforced by `.gitattributes`.

[Unreleased]: https://github.com/directelectron/de-shell/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/directelectron/de-shell/releases/tag/v0.2.0
