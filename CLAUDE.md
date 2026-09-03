# prx — local Claude context

Auto-load the generated project context (package map, docs index, commands).
It is regenerated from the project graph by `bun run claude-context:render`;
edit the sources (community.json / package descriptions / docs), not the doc.

@.claude/context/project.md

<!-- bounded-systems-org:begin — managed by adopt-claude-harness; do not hand-edit this block -->
## bounded-systems sessions — before anything else

1. **Bootstrap**: run `bash .claude/org-repair.sh` — pre-approved where this
   repo's settings carry the org floor; generator-owned repos may still prompt.
   It executes a local or fetched copy ONLY if the bytes hash to a resolved
   digest, and refuses otherwise. The digest comes from the channel manifest
   (written only by the OIDC-pinned `boot-manifest` lane on main), with the
   legacy `$ORG_BOOT_SHA256` honored first while it still exists — that
   variable was retired outright on 2026-08-16 (`.github`#192) and is absent
   from the dialog, so the manifest is the live source.
   `bootstrap in effect` → continue. `REFUSED` or a permission denial → stop
   and report; do not work around it.
2. **Claim before working** — doors, best reachable first (`#529`). Both
   mechanized doors REQUIRE a passkey token since `.github`#264: run
   `node claim-ceremony.mjs` (in `bounded-systems/.github`), approve on your
   device, pass what it prints as `human_authorization`. **No token is a red
   run and there is no break-glass.** The window can be as short as two
   minutes, so mint it immediately before dispatching. Releasing needs none.
   1. `claim-ticket.yml` in `bounded-systems/.github` (workflow_dispatch:
      `repo`, `issue`, `claimant`, `human_authorization`) — the real door,
      lease-backed. Reachable only from a session created with `.github`
      attached; mid-session `add_repo` refuses it.
   2. `claim.yml` in `bounded-systems/.github-private` (workflow_dispatch:
      `issue`, `claimant`, `human_authorization`) — for `.github-private`
      issues when door 1 is unreachable. A caller of the shared `_claim.yml`.
      Attests a KEYHOLDER approved this exact (repo, issue, claimant) — still
      not that the session IS the claimant (`#530`).
   3. Hand-claim (assign + comment) — **last resort only**, when no door is
      reachable. It provides **no exclusion** (keycard#7, `signerSelfAsserted`)
      — a marker, not a claim; say plainly the window was down.

   Whichever door: confirm the claim comment ON THE ISSUE names your claimant
   AND reads `human-authorized`. Any assignee or `claimed` label → someone else's; do not start. No issue →
   open one and claim it.
3. **Degraded mode**: no "bounded-systems — Claude context" block in your
   session context means the org context did not load. You may claim and work
   THIS repo only — no org-level `[settings]`/`[org]` changes, no cross-repo
   work.
<!-- bounded-systems-org:end -->
