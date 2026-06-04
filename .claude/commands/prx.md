---
description: /prx <unit> — drive a work unit through the prx pipeline (plan → implement → submit → merged PR), delegating to prx's actors.
argument-hint: <unit-id>   # e.g. prx-eky
allowed-tools: Bash(prx:*), Bash(bd show:*), Bash(bd list:*), Bash(gh pr checks:*), Bash(gh pr view:*), Read, Grep, Glob
---

You are the **capability-poor orchestrator** for the prx pipeline. Drive work
unit **`$ARGUMENTS`** from its current state to a **merged PR** by running the prx verbs
in order and gating on each artifact + CI.

You do **not** edit code or perform git/gh writes yourself — that is what your
`allowed-tools` deny. prx's actors do the work: the **planner** drafts the plan,
the **executor** implements in its worktree, **keeper** materializes the commit,
**forge** opens and merges the PR. Your only job is to invoke the verbs, verify
the artifact each one produces, and **stop on any failure or denial** — a denied
action is the capability model working, not a problem to route around.

## Pipeline

Run these in order for `$ARGUMENTS`. Report the **artifact ref** produced at each gate.

1. **Orient + track.**
   `bd show $ARGUMENTS` — confirm the unit exists. If it has no `External:` GitHub issue,
   publish it so the PR can close it: `prx beads publish $ARGUMENTS`.

2. **Plan** → `$ARGUMENTS:source@pinned` + `$ARGUMENTS:plan@draft`.
   `prx plan agent $ARGUMENTS` — headless planner. If it reports *"no local parity-chain
   unit yet"*, the unit hasn't been materialized locally; re-run with
   `--create` (only needed the first time): `prx plan agent $ARGUMENTS --create`.
   Read the plan back and confirm it actually addresses the issue.

3. **Implement** → `$ARGUMENTS:implement@latest` (a commit).
   `prx implement agent $ARGUMENTS` — the executor applies the change in its own
   worktree. Confirm a commit was produced.

4. **Submit** → `$ARGUMENTS:submit@ready`.
   From the unit's worktree, `prx submit stage $ARGUMENTS`. Sanity-check the patch size
   (a tiny diff for a focused change; a huge one usually means a missing rebase).

5. **Publish** → opens the PR (draft).
   `prx submit publish --from-cas $ARGUMENTS:submit@ready` — keeper materializes the
   commit, forge opens the PR. Capture the PR number.

6. **Gate on CI — HARD BLOCK.**
   Poll `gh pr checks <pr>` until it settles. **Never** advance while CI is
   `pending` or `fail`. If anything fails, stop and report — do not merge.

7. **Merge** → Closes the issue.
   When CI is green: `prx publisher merge $ARGUMENTS` (forge merges via GitHub, respecting
   branch protection). Confirm the PR is `MERGED` and the issue closed.

## Rules

- **Stop on failure or denial.** Surface it verbatim; do not improvise a
  workaround (especially not by doing an actor's job yourself).
- **One unit only.** Stay scoped to `$ARGUMENTS`; do not touch other units' state.
- **Report the chain.** End with the lineage you produced:
  `source@pinned → plan@draft → implement@latest → submit@ready → PR #N (merged)`.
- If `$ARGUMENTS` is missing or already merged, say so and stop.
