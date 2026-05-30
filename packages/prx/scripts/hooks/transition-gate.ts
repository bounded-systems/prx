#!/usr/bin/env bun
// ai-home-wlw5l — the `command` Stop-hook body (thin glue over the tested core).
//
// Lives under tracked `scripts/hooks/` (NOT `.claude/hooks/`, which is
// gitignored). A per-session `--settings` file registers it as a Stop hook for
// prx-launched agent sessions via `bun ${CLAUDE_PROJECT_DIR}/scripts/hooks/transition-gate.ts`
// (the profile-launch wiring is slice 3b — separate; it needs a real launch to
// verify, and must be per-session, never shared project settings).
//
// Claude Code runs this when the agent finishes a turn. It reads the run's role
// + work unit + transition-artifact slot from the session env/fs, runs the
// validate-then-pin gate, and maps to the Stop-hook exit contract:
//   exit 0  → allow: the typed artifact is schema-valid and pinned to CAS.
//   exit 2  → block: empty/invalid slot; refuse termination, reason → stderr →
//             fed back to the run so it keeps working until it emits a valid one.
import { existsSync, readFileSync } from "node:fs";

import {
  runTransitionGateHook,
  type TransitionHookEnv,
} from "../../src/session/transition-gate-hook.ts";

// Claude Code delivers the Stop-hook envelope as JSON on stdin (the boundary
// contract). Read it and let the gate resolve the slot relative to the
// session cwd it reports.
const stdin = await Bun.stdin.text();

const result = await runTransitionGateHook({
  stdin,
  env: process.env as TransitionHookEnv,
  readSlot: (path) => (existsSync(path) ? readFileSync(path, "utf8") : null),
});

if (result.exitCode === 2) {
  process.stderr.write(`${result.message}\n`);
  process.exit(2);
}
// allow: the pinned CAS handle goes to stdout (Claude Code's debug log only).
process.stdout.write(`${result.message}\n`);
process.exit(0);
