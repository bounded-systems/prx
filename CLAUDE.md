# prx — local Claude context

Auto-load the generated project context (package map, docs index, commands).
It is regenerated from the project graph by `bun run claude-context:render`;
edit the sources (community.json / package descriptions / docs), not the doc.

@.claude/context/project.md

<!-- bounded-systems-org:begin — managed by adopt-claude-harness; do not hand-edit this block -->
## bounded-systems sessions — before anything else

1. **Bootstrap**: run `bash .claude/org-repair.sh` — pre-approved where this
   repo's settings carry the org floor; generator-owned repos may still prompt.
   Its only trust anchor is the dialog-recorded `$ORG_BOOT_SHA256` (typed by a
   human in the environment dialog, never fetched): it executes a local or
   fetched copy ONLY if the bytes hash to that value, and refuses otherwise.
   `bootstrap in effect` → continue. `REFUSED` or a permission denial → stop
   and report; do not work around it.
2. **Claim before working**: dispatch `claim-ticket.yml` in
   `bounded-systems/.github` (workflow_dispatch: `repo`, `issue`, `claimant`),
   then confirm the claim comment ON THE ISSUE names your claimant. Any
   assignee or `claimed` label → someone else's. Window unreachable → claim by
   hand (assign + comment) and say the window was down. No issue → open one.
3. **Degraded mode**: no "bounded-systems — Claude context" block in your
   session context means the org context did not load. You may claim and work
   THIS repo only — no org-level `[settings]`/`[org]` changes, no cross-repo
   work.
<!-- bounded-systems-org:end -->