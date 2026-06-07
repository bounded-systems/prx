---
"@bounded-systems/prx": patch
---

feat: add @bounded-systems/host capability; route all prx/src node:os ambient reads through it

`os.homedir()` / `os.tmpdir()` / `os.hostname()` are ambient host authority that
was being read raw from `node:os` across ~20 prx/src files — a hidden dependency
that escaped import analysis and (because `os.homedir()` ignores `$HOME` on
macOS) could not be redirected in tests.

New `@bounded-systems/host` package is the one sanctioned reader of that state,
mirroring `@bounded-systems/env` for `process.env`:
  - `homeDir()` honors an explicit `$HOME` override (via @bounded-systems/env)
    before falling back to `os.homedir()`, so tests/sandboxes can redirect it;
  - `tmpDir()` / `hostName()` wrap `os.tmpdir()` / `os.hostname()`.

Every `prx/src` caller now imports from `@bounded-systems/host`, and the
ambient-authority guard gains a rule forbidding raw `node:os` in `prx/src`
(a hard guarantee, mirroring the existing `process.env` ban).
