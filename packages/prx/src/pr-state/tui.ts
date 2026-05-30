import { getEnv } from "@bounded-systems/env";
import { streamCapture, type SpawnCaptureResult, type StreamCaptureOptions } from "@bounded-systems/proc";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { assign, createActor, createMachine, fromPromise, setup } from "xstate";

import {
  buildWorkUnitClaudeRuntimeProfile,
  type RuntimeIoFormat,
  type RuntimeMode,
} from "../machine/runtime_profiles.ts";
import {
  canonicalWorkUnitIdPattern,
  normalizeCanonicalWorkUnitId,
} from "../machine/work_unit.ts";
import { getPrxSnapshot, type PrxApiContext, type PrxApiSnapshot, type PrxControlState } from "./api.ts";

export type ClaudeRunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  parsed: unknown;
};

/** Async capture seam — defaults to @bounded-systems/proc's streamCapture. */
export type ClaudeRunner = (
  cmd: readonly string[],
  options?: StreamCaptureOptions,
) => Promise<SpawnCaptureResult>;

export async function runClaudeWithProfile(input: {
  agentId: string;
  workUnitId: string;
  mode: RuntimeMode;
  ioFormat: RuntimeIoFormat;
  run?: ClaudeRunner;
}): Promise<ClaudeRunResult> {
  const profile = buildWorkUnitClaudeRuntimeProfile({
    agentId: input.agentId,
    workUnitId: input.workUnitId,
    mode: input.mode,
    ioFormat: input.ioFormat,
  });
  const run = input.run ?? streamCapture;
  const result = await run([profile.command, ...profile.args], {
    cwd: process.cwd(),
  });
  // streamCapture reports a spawn failure via result.error instead of
  // rejecting; re-throw it to preserve the prior child.on("error") reject.
  if (result.error) {
    throw result.error;
  }
  const exitCode = result.status ?? 1;
  const stdoutText = result.stdout;
  const stderrText = result.stderr;

  let parsed: unknown = null;
  const trimmed = stdoutText.trim();
  if (trimmed.length > 0) {
    if (input.ioFormat === "json") {
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        parsed = null;
      }
    } else {
      const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const events: unknown[] = [];
      for (const line of lines) {
        try {
          events.push(JSON.parse(line));
        } catch {
          // Keep parser permissive for mixed stream output.
        }
      }
      parsed = events.length > 0 ? events : null;
    }
  }

  return {
    exitCode,
    stdout: stdoutText,
    stderr: stderrText,
    parsed,
  };
}

type TuiContext = {
  workUnitId: string;
  agentId: string;
  mode: RuntimeMode;
  ioFormat: RuntimeIoFormat;
  result: ClaudeRunResult | null;
  lastError: string | null;
};

type TuiEvent =
  | { type: "RUN" }
  | { type: "RESET" }
  | { type: "SET_WORK_UNIT"; value: string }
  | { type: "SET_AGENT"; value: string }
  | { type: "SET_MODE"; value: RuntimeMode }
  | { type: "SET_IO"; value: RuntimeIoFormat };

function toControlState(value: string): PrxControlState {
  switch (value) {
    case "running":
      return "dispatching";
    case "done":
      return "done";
    case "error":
      return "failed";
    case "idle":
    default:
      return "idle";
  }
}

function snapshotInputFromContext(context: TuiContext, controlState: PrxControlState, repoPath: string, ticketPath: string): PrxApiContext {
  return {
    repoPath,
    ticketPath,
    workUnitId: context.workUnitId,
    agentId: context.agentId,
    mode: context.mode,
    ioFormat: context.ioFormat,
    controlState,
    result: context.result,
    lastError: context.lastError,
  };
}

function firstRunBlocker(
  context: TuiContext,
  controlState: PrxControlState,
  repoPath: string,
  ticketPath: string,
  snapshot: (input: PrxApiContext) => PrxApiSnapshot,
): string | null {
  const apiSnapshot = snapshot(snapshotInputFromContext(context, controlState, repoPath, ticketPath));
  return apiSnapshot.runBlockers[0] ?? null;
}

export function createWorkUnitTuiMachine(deps?: {
  runner?: (input: {
    agentId: string;
    workUnitId: string;
    mode: RuntimeMode;
    ioFormat: RuntimeIoFormat;
  }) => Promise<ClaudeRunResult>;
  snapshot?: (input: PrxApiContext) => PrxApiSnapshot;
  repoPath?: string;
  ticketPath?: string;
}) {
  const runner = deps?.runner ?? ((ctx: {
    agentId: string;
    workUnitId: string;
    mode: RuntimeMode;
    ioFormat: RuntimeIoFormat;
  }) => runClaudeWithProfile(ctx));
  const repoPath = deps?.repoPath ?? process.cwd();
  const ticketPath = deps?.ticketPath ??
    getEnv("PRX_TICKETS_PATH") ??
    getEnv("PRX_NOTION_TICKETS_PATH") ??
    ".pr/local/tickets.json";
  const snapshot = deps?.snapshot ?? ((input: PrxApiContext) => getPrxSnapshot(input));

  return setup({
    types: {
      context: {} as TuiContext,
      events: {} as TuiEvent,
      input: {} as {
        workUnitId: string;
      },
    },
    actors: {
      runClaude: fromPromise(async ({ input }) =>
        runner(input as {
          agentId: string;
          workUnitId: string;
          mode: RuntimeMode;
          ioFormat: RuntimeIoFormat;
        })),
    },
  }).createMachine({
    id: "prxWorkUnitTui",
    initial: "idle",
    context: ({ input }) => ({
      workUnitId: input.workUnitId,
      agentId: input.workUnitId,
      mode: "full",
      ioFormat: "json",
      result: null,
      lastError: null,
    }),
    states: {
      idle: {
        on: {
          RUN: [
            {
              guard: ({ context }) =>
                firstRunBlocker(context, "idle", repoPath, ticketPath, snapshot) === null,
              target: "running",
            },
            {
              actions: assign({
                lastError: ({ context }) =>
                  `run rejected: ${firstRunBlocker(context, "idle", repoPath, ticketPath, snapshot) ?? "unknown precondition failure"}`,
              }),
            },
          ],
          RESET: {
            actions: assign({
              result: () => null,
              lastError: () => null,
            }),
          },
          SET_WORK_UNIT: {
            actions: assign({
              workUnitId: ({ event }) => event.value,
              agentId: ({ event }) => event.value,
            }),
          },
          SET_AGENT: {
            actions: assign({
              workUnitId: ({ event }) => event.value,
              agentId: ({ event }) => event.value,
            }),
          },
          SET_MODE: {
            actions: assign({
              mode: ({ event }) => event.value,
            }),
          },
          SET_IO: {
            actions: assign({
              ioFormat: ({ event }) => event.value,
            }),
          },
        },
      },
      running: {
        invoke: {
          src: "runClaude",
          input: ({ context }) => ({
            agentId: context.agentId,
            workUnitId: context.workUnitId,
            mode: context.mode,
            ioFormat: context.ioFormat,
          }),
          onDone: {
            target: "done",
            actions: assign({
              result: ({ event }) => event.output as ClaudeRunResult,
              lastError: () => null,
            }),
          },
          onError: {
            target: "error",
            actions: assign({
              lastError: ({ event }) => String(event.error),
            }),
          },
        },
      },
      done: {
        on: {
          RESET: {
            target: "idle",
            actions: assign({
              result: () => null,
              lastError: () => null,
            }),
          },
          RUN: [
            {
              guard: ({ context }) =>
                firstRunBlocker(context, "done", repoPath, ticketPath, snapshot) === null,
              target: "running",
            },
            {
              actions: assign({
                lastError: ({ context }) =>
                  `run rejected: ${firstRunBlocker(context, "done", repoPath, ticketPath, snapshot) ?? "unknown precondition failure"}`,
              }),
            },
          ],
          SET_WORK_UNIT: {
            target: "idle",
            actions: assign({
              workUnitId: ({ event }) => event.value,
              agentId: ({ event }) => event.value,
            }),
          },
          SET_AGENT: {
            target: "idle",
            actions: assign({
              workUnitId: ({ event }) => event.value,
              agentId: ({ event }) => event.value,
            }),
          },
          SET_MODE: {
            target: "idle",
            actions: assign({
              mode: ({ event }) => event.value,
            }),
          },
          SET_IO: {
            target: "idle",
            actions: assign({
              ioFormat: ({ event }) => event.value,
            }),
          },
        },
      },
      error: {
        on: {
          RESET: {
            target: "idle",
            actions: assign({
              result: () => null,
              lastError: () => null,
            }),
          },
          RUN: [
            {
              guard: ({ context }) =>
                firstRunBlocker(context, "failed", repoPath, ticketPath, snapshot) === null,
              target: "running",
            },
            {
              actions: assign({
                lastError: ({ context }) =>
                  `run rejected: ${firstRunBlocker(context, "failed", repoPath, ticketPath, snapshot) ?? "unknown precondition failure"}`,
              }),
            },
          ],
        },
      },
    },
  });
}

function isCanonicalId(value: string): boolean {
  return canonicalWorkUnitIdPattern.test(value);
}

function normalizeOrNull(value: string): string | null {
  const normalized = normalizeCanonicalWorkUnitId(value);
  return isCanonicalId(normalized) ? normalized : null;
}

function helpText(): string {
  return [
    "Commands:",
    "  run                     execute current profile",
    "  r                       shortcut for run",
    "  work <GH-456>          set work unit id (canonical)",
    "  w                       prompt to set work unit id",
    "  agent <GH-456>         set canonical id (agent/work-unit stay equal)",
    "  a                       prompt to set canonical id (agent/work-unit)",
    "  mode <full|dev>         set runtime mode",
    "  m                       prompt to set mode",
    "  io <json|stream-json>   set output/input format",
    "  i                       prompt to set I/O format",
    "  profile                 print resolved claude command",
    "  ticket overlay          PRX_TICKETS_PATH or PRX_NOTION_TICKETS_PATH or .pr/local/tickets.json",
    "  reset                   clear result/error",
    "  help                    print this help",
    "  quit                    exit",
  ].join("\n");
}

function renderSnapshot(snapshot: ReturnType<ReturnType<typeof createWorkUnitTuiMachine>["getInitialSnapshot"]>, apiSnapshot: PrxApiSnapshot): string {
  const lines = [
    "",
    "prx work-unit tui",
    "=================",
    `control: ${apiSnapshot.controlState}`,
    `unit: ${apiSnapshot.unitState}`,
    `agent: ${apiSnapshot.agentState}`,
    `workUnitId: ${snapshot.context.workUnitId}`,
    `agentId: ${snapshot.context.agentId}`,
    `mapping: ${apiSnapshot.mapping}`,
    `mode: ${snapshot.context.mode}`,
    `io: ${snapshot.context.ioFormat}`,
  ];

  if (apiSnapshot.lastError) {
    lines.push(`error: ${apiSnapshot.lastError}`);
  }

  if (!apiSnapshot.canRun) {
    lines.push(`run: blocked`);
    for (const blocker of apiSnapshot.runBlockers) {
      lines.push(`  - ${blocker}`);
    }
  } else {
    lines.push("run: ready");
  }

  if (apiSnapshot.result) {
    lines.push(`exit: ${apiSnapshot.result.exitCode}`);
    if (apiSnapshot.result.parsed !== null) {
      lines.push(`parsed: ${JSON.stringify(apiSnapshot.result.parsed, null, 2)}`);
    } else {
      lines.push(`stdout: ${apiSnapshot.result.stdout.trim().slice(0, 500)}`);
    }
    if (apiSnapshot.result.stderr.trim().length > 0) {
      lines.push(`stderr: ${apiSnapshot.result.stderr.trim().slice(0, 500)}`);
    }
  }

  return lines.join("\n");
}

function trimCell(value: string, size: number): string {
  if (value.length <= size) return value.padEnd(size, " ");
  if (size <= 1) return value.slice(0, size);
  return `${value.slice(0, size - 1)}…`;
}

function renderSurface(surface: PrxApiSnapshot["surface"], selectedId: string): string {
  if (!surface) {
    return "";
  }
  const lines = [
    "",
    "uow surface",
    "===========",
    `repo: ${surface.repo} | remote: ${surface.remoteFreshness} | rows: ${surface.rows.length}`,
    "",
    `${trimCell("ID", 16)} ${trimCell("STATE", 16)} ${trimCell("PR", 8)} ${trimCell("WT", 3)} ${trimCell("AGENT", 16)} ${trimCell("TICKET", 16)} TITLE`,
    `${"-".repeat(16)} ${"-".repeat(16)} ${"-".repeat(8)} ${"-".repeat(3)} ${"-".repeat(16)} ${"-".repeat(16)} ${"-".repeat(24)}`,
  ];

  for (const row of surface.rows) {
    const marker = row.id === selectedId ? ">" : " ";
    const pr = row.prNumber ? `#${row.prNumber}` : "-";
    const wt = row.worktree ? "Y" : "N";
    const ticketStatus = row.ticket?.status ?? "-";
    const title = row.ticket?.title ?? "-";
    lines.push(
      `${marker}${trimCell(row.id, 15)} ${trimCell(row.board, 16)} ${trimCell(pr, 8)} ${trimCell(wt, 3)} ${trimCell(row.agent.state, 16)} ${trimCell(ticketStatus, 16)} ${title}`,
    );
  }

  const active = surface.rows.find((row) => row.id === selectedId);
  if (active) {
    lines.push("");
    lines.push(`active: ${active.id}`);
    lines.push(`  branch: ${active.branch}`);
    lines.push(`  board: ${active.board}`);
    lines.push(`  agent: ${active.agent.id} (${active.agent.state})`);
    lines.push(`  pr: ${active.prNumber ? `#${active.prNumber}` : "none"}`);
    lines.push(`  ticket: ${active.ticket ? "present" : "missing"}`);
    if (active.ticket) {
      lines.push(`    source: ${active.ticket.source}`);
      lines.push(`    status: ${active.ticket.status ?? "-"}`);
      lines.push(`    epic: ${active.ticket.epic ?? "-"}`);
      lines.push(`    assignee: ${active.ticket.assignee ?? "-"}`);
      lines.push(`    updated: ${active.ticket.last_updated ?? "-"}`);
    }
  }

  if (surface.orphans.ticketOnly.length > 0) {
    lines.push(`orphans ticket-only: ${surface.orphans.ticketOnly.join(", ")}`);
  }
  if (surface.orphans.executionOnly.length > 0) {
    lines.push(`orphans execution-only: ${surface.orphans.executionOnly.join(", ")}`);
  }

  return lines.join("\n");
}

export async function runWorkUnitTui(): Promise<number> {
  const rl = createInterface({ input, output });
  const ticketOverlayPath =
    getEnv("PRX_TICKETS_PATH") ??
    getEnv("PRX_NOTION_TICKETS_PATH") ??
    ".pr/local/tickets.json";
  const repoPath = process.cwd();
  const snapshotBuilder = (input: PrxApiContext) => getPrxSnapshot(input);
  const machine = createWorkUnitTuiMachine({
    runner: (ctx) => runClaudeWithProfile(ctx),
    snapshot: snapshotBuilder,
    repoPath,
    ticketPath: ticketOverlayPath,
  });
  const actor = createActor(machine, {
    input: { workUnitId: "<WORK-UNIT-ID>" },
  });
  actor.start();

  try {
    output.write(`${helpText()}\n`);
    while (true) {
      const snapshot = actor.getSnapshot();
      const apiSnapshot = snapshotBuilder(
        snapshotInputFromContext(snapshot.context, toControlState(String(snapshot.value)), repoPath, ticketOverlayPath),
      );
      output.write(`${renderSnapshot(snapshot, apiSnapshot)}\n`);
      if (apiSnapshot.surface) {
        output.write(`${renderSurface(apiSnapshot.surface, snapshot.context.workUnitId)}\n`);
      } else if (apiSnapshot.surfaceError) {
        output.write(`uow surface unavailable: ${apiSnapshot.surfaceError}\n`);
      }
      const raw = (await rl.question("\n> ")).trim();
      if (!raw) continue;
      if (raw === "quit" || raw === "q" || raw === "exit") {
        break;
      }
      if (raw === "help" || raw === "h") {
        output.write(`${helpText()}\n`);
        continue;
      }
      if (raw === "run" || raw === "r") {
        actor.send({ type: "RUN" });
        continue;
      }
      if (raw === "reset") {
        actor.send({ type: "RESET" });
        continue;
      }
      if (raw === "profile") {
        const s = actor.getSnapshot().context;
        const profile = buildWorkUnitClaudeRuntimeProfile({
          agentId: s.agentId,
          workUnitId: s.workUnitId,
          mode: s.mode,
          ioFormat: s.ioFormat,
        });
        output.write(`claude ${profile.args.join(" ")}\n`);
        continue;
      }

      if (raw === "w") {
        const value = normalizeOrNull((await rl.question("work unit id> ")).trim());
        if (!value) {
          output.write("Invalid work unit id. Expected format like GH-456.\n");
          continue;
        }
        actor.send({ type: "SET_WORK_UNIT", value });
        continue;
      }

      if (raw === "a") {
        const value = normalizeOrNull((await rl.question("canonical id (agent/work-unit)> ")).trim());
        if (!value) {
          output.write("Invalid canonical id. Expected format like GH-456.\n");
          continue;
        }
        actor.send({ type: "SET_AGENT", value });
        continue;
      }

      if (raw === "m") {
        const value = (await rl.question("mode (full|dev)> ")).trim();
        if (value !== "full" && value !== "dev") {
          output.write("Mode must be `full` or `dev`.\n");
          continue;
        }
        actor.send({ type: "SET_MODE", value });
        continue;
      }

      if (raw === "i") {
        const value = (await rl.question("io (json|stream-json)> ")).trim();
        if (value !== "json" && value !== "stream-json") {
          output.write("I/O must be `json` or `stream-json`.\n");
          continue;
        }
        actor.send({ type: "SET_IO", value });
        continue;
      }

      const [command, value] = raw.split(/\s+/, 2);
      if (!value) {
        output.write("Missing value. Try `help`.\n");
        continue;
      }
      if (command === "work") {
        const normalized = normalizeOrNull(value);
        if (!normalized) {
          output.write("Invalid work unit id. Expected format like GH-456.\n");
          continue;
        }
        actor.send({ type: "SET_WORK_UNIT", value: normalized });
        continue;
      }
      if (command === "agent") {
        const normalized = normalizeOrNull(value);
        if (!normalized) {
          output.write("Invalid canonical id. Expected format like GH-456.\n");
          continue;
        }
        actor.send({ type: "SET_AGENT", value: normalized });
        continue;
      }
      if (command === "mode") {
        if (value !== "full" && value !== "dev") {
          output.write("Mode must be `full` or `dev`.\n");
          continue;
        }
        actor.send({ type: "SET_MODE", value });
        continue;
      }
      if (command === "io") {
        if (value !== "json" && value !== "stream-json") {
          output.write("I/O must be `json` or `stream-json`.\n");
          continue;
        }
        actor.send({ type: "SET_IO", value });
        continue;
      }
      output.write("Unknown command. Try `help`.\n");
    }
  } finally {
    rl.close();
    actor.stop();
  }

  return 0;
}
