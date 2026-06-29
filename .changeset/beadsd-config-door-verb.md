---
"@bounded-systems/prx": minor
---

beadsd door config-verb (prx-82b Slice 2e.2a): the beadsd daemon now serves
`bd config get`/`bd config set` over the door (new `config-get` READ + `config-set`
WRITE request kinds). `bd config get` returns a PLAIN value (not `--json`), so the
daemon replies `result` = the raw trimmed stdout (handled like the non-JSON `dep`
surface); `config-set` echoes no record (`result: null`). This is the daemon
capability that lets the watermark/config reads+writes route off host bd (the
routing — door dialer + the watermark sites — is the next slice, 2e.2b).
