---
"@bounded-systems/prx": minor
---

Invert `prx intake` from bead-primary to GitHub-issue-primary (GH-1011 — beads
retirement). Intake now files a GitHub issue directly (`gh issue create`) as the
primary and only write; the org's front-desk-sync webhook lands it on Front Desk.
The old `bd create` primary + opt-in `--to gh` projection is gone — GitHub is the
write plane. `IntakeResult` now carries `ghCreate` (issue URL / number) instead of
`bdCreate`/`publish`; the plain-output handle is the created issue URL. The `--to`
flag is still accepted but inert. This severs the last functional write path from
intake to beads.
