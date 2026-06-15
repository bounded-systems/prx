---
"@bounded-systems/prx": minor
---

Add a `children` read to the beadsd door (prx-zbsi). `prx beads children <id>` returns an epic's parent-child children through the daemon, served over the already-allowed `bd dep` subcommand as `bd dep list <id> --direction up --type parent-child --json` — `bd children` is **not** on the bd policy allowlist, so the read adds no capability surface. Wired end-to-end: the `children` request kind in the beadsd wire contract (a read), the daemon dispatch, the `prx beads children` CLI verb, and the door dialer mapping (`bd children <id>` → `prx beads children <id>` in the box profile).

Also fixes a latent door-read bug: the dialer forwards a bd read's `--json` flag verbatim (`bd show <id> --json` → `prx beads show <id> --json`), but the read parser rejected `--json` under strict parsing — so **no** door read (show/list/children) would have parsed once the box profile went live. The read parser now accepts-and-ignores `--json` (reads always emit JSON).

This is the door-read infra for the remaining prx-zbsi epic-children reads; gating the consumers (`resolveEpicChildBdIds`, `findEpicChildren`) onto it is a follow-up.
