#!/usr/bin/env bun
// Dev-only runner for the triage XState machine. Builds the machine, creates
// an actor (optionally with the Stately inspector attached), and runs to
// completion or `blocked`. This is NOT a CLI verb — `prx triage prime`
// (GH-1015) is the eventual user-facing entry point. The demo exists so the
// machine is reachable from a shell and the inspector has somewhere to
// attach during development.
//
// Usage:
//   bun run scripts/triage-machine-demo.ts [--repo <owner/name>] [--inspect] \
//     [--auto-prioritize] [--dry-run]

import { createActor } from "xstate";
import { parseArgs } from "node:util";

import { triageMachine, type TriageMachineInput } from "../src/triage/machine.ts";
import { createTriageInspector } from "../src/triage/inspect.ts";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    repo: { type: "string" },
    inspect: { type: "boolean", default: false },
    "auto-prioritize": { type: "boolean", default: false },
    "auto-drift-fix": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
  strict: true,
});

const input: TriageMachineInput = {
  repo: values.repo,
  dryRun: values["dry-run"] ?? false,
  autoPrioritize: values["auto-prioritize"] ?? false,
  autoDriftFix: values["auto-drift-fix"] ?? false,
};

const inspector = createTriageInspector({ enabled: values.inspect ?? false });

const actor = createActor(triageMachine, {
  input,
  ...(inspector ? { inspect: inspector.inspect } : {}),
});

actor.subscribe({
  complete: () => {
    const snapshot = actor.getSnapshot();
    const stateValue = snapshot.value;
    const ctx = snapshot.context;
    if (stateValue === "blocked" && ctx.blockedReason) {
      const ticket = ctx.blockedReason.ticket ?? "unknown";
      process.stderr.write(
        `triage machine blocked on ${ctx.blockedReason.actor} — see ${ticket}: ${ctx.blockedReason.message}\n`,
      );
      process.exitCode = 1;
    } else {
      process.stdout.write(`triage machine completed: state=${String(stateValue)}\n`);
      process.exitCode = 0;
    }
    inspector?.stop();
  },
  error: (err) => {
    process.stderr.write(`triage machine error: ${(err as Error).message}\n`);
    process.exitCode = 1;
    inspector?.stop();
  },
});

actor.start();
