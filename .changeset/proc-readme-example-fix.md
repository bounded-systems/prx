---
---

Fix the `@bounded-systems/proc` README usage example: `defaultRunner`/`runCaptured`
are synchronous `CommandRunner`s `(cmd: string[], options?) => CommandResult`, so
the example dropped the bogus `await` and the wrong `runCaptured(run, "git", [...])`
call shape — it now calls `run(["git", "status", "--porcelain"])` and shows
`runCaptured` as a drop-in for large output. Docs only: no API or behavior change,
no package release.
