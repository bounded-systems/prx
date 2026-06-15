---
"@bounded-systems/prx": patch
---

Door-gate the `findEpicChildren` epic-children reads (epic_children.ts) — the last prx-zbsi read consumer. Both reads now route through the beadsd door in the box profile: `bd list --all` (the snapshot) and `bd dep list <id> --direction up --type parent-child` (the parent-child edges). Off-profile behavior is **byte-identical** — the gate falls back to the injected runner with the same argv, so the well-tested edge-shape parsing is untouched.

To keep that argv (and its result shape) unchanged, the door dialer now recognizes the `bd dep list <id> … --type parent-child` read form and routes it to the `children` verb (added in #613) — rather than requiring the call site to switch to `bd children`. `dep add`/`remove` (writes) and a non-parent-child `dep list` still fail closed. The result shape is therefore consistent in-box and off-profile (both `bd dep list` rows).

Gating also keeps these bd reads off `defaultRunner`'s GitHub rate-limit bucket in-box. This completes the door-backed **read** consumers for prx-zbsi; the remaining work is the bucket-B host-only `bd config`/dolt spawns (assert-ENOENT-in-box tests).
