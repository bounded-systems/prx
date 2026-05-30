// GH-1423: `prx rules <verb>` handler.
//
// Verbs:
//   render    — load inputs, run assertions, emit/write markdown
//   validate  — load inputs, run assertions only (no write); CI surface
//   inputs    — dump each typed input as JSON (debug)
//
// PR-1 is read-only with respect to the filesystem — `render` emits to
// stdout by default. The `--write` flag is reserved for a follow-up that
// also ships the re-rendered `claude/rules/core.md`. Rejecting `--write`
// here makes the scope clip in `docs/prx/rules-build-substrate.md` §5
// machine-enforced rather than convention.

import { readFileSync } from "node:fs";

import {
  ALIAS_SUPPLY_STUB_TICKET,
  loadAliasSupplyStub,
} from "./loaders/alias-supply.ts";
import {
  MEMORY_INDEX_STUB_TICKET,
  loadMemoryIndexStub,
} from "./loaders/memory-index.ts";
import { loadVerbSupply } from "./loaders/verb-supply.ts";
import {
  WORKTREE_GESTURES_STUB_TICKET,
  loadWorktreeGesturesStub,
} from "./loaders/worktree-gestures.ts";
import { renderCoreMd } from "./render/core-md.ts";
import type { RulesEvent } from "./events.ts";
import type { RulesInputs } from "./schemas/inputs.ts";
import {
  aliasExists,
  verbExists,
  worktreeGestureResolves,
  type AssertionFailure,
} from "./validate/assertions.ts";

export type RulesVerb = "render" | "validate" | "inputs";

export type RulesCliInput = {
  verb: RulesVerb;
  /** When set, validate runs against this file rather than the renderer's output. */
  validatePath?: string | undefined;
  format: "plain" | "json";
};

export type RulesCliOutput = {
  log: (line: string) => void;
  error: (line: string) => void;
  /** Optional emit hook for typed events; tests inject. */
  emit?: (event: RulesEvent) => void;
};

export class RulesCliError extends Error {
  constructor(
    public code: string,
    message: string,
    public exitCode = 65,
  ) {
    super(message);
    this.name = "RulesCliError";
  }
}

function emitEvent(out: RulesCliOutput, event: RulesEvent): void {
  out.emit?.(event);
}

export function loadAllInputs(out: RulesCliOutput): RulesInputs {
  const verbSupply = loadVerbSupply();
  emitEvent(out, {
    type: "RULES_INPUT_LOADED",
    kind: "verb-supply",
    count: verbSupply.length,
  });

  const aliasSupply = loadAliasSupplyStub();
  emitEvent(out, {
    type: "RULES_INPUT_STUBBED",
    kind: "alias-supply",
    ticket: ALIAS_SUPPLY_STUB_TICKET,
  });

  const worktreeGestures = loadWorktreeGesturesStub();
  emitEvent(out, {
    type: "RULES_INPUT_STUBBED",
    kind: "worktree-gestures",
    ticket: WORKTREE_GESTURES_STUB_TICKET,
  });

  const memoryIndex = loadMemoryIndexStub();
  emitEvent(out, {
    type: "RULES_INPUT_STUBBED",
    kind: "memory-index",
    ticket: MEMORY_INDEX_STUB_TICKET,
  });

  return { verbSupply, aliasSupply, worktreeGestures, memoryIndex };
}

export function runAssertions(
  markdown: string,
  file: string,
  inputs: RulesInputs,
): AssertionFailure[] {
  return [
    ...verbExists(markdown, file, inputs.verbSupply),
    ...aliasExists(markdown, file, inputs.aliasSupply),
    ...worktreeGestureResolves(markdown, file, inputs.worktreeGestures),
  ];
}

function emitFailureEvents(out: RulesCliOutput, failures: AssertionFailure[]): void {
  for (const f of failures) {
    emitEvent(out, {
      type: "RULES_ASSERTION_FAILED",
      rule: f.rule,
      subject: f.subject,
      file: f.file,
      line: f.line,
    });
  }
}

function reportFailures(
  out: RulesCliOutput,
  failures: AssertionFailure[],
  format: "plain" | "json",
): void {
  if (format === "json") {
    out.log(JSON.stringify({ failures }, null, 2));
    return;
  }
  for (const f of failures) {
    out.error(`${f.file}:${f.line}: ${f.rule}: ${f.subject}`);
  }
}

export function runRulesCli(input: RulesCliInput, out: RulesCliOutput): number {
  emitEvent(out, { type: "RULES_RENDER_REQUESTED", source: `rules ${input.verb}` });

  if (input.verb === "inputs") {
    const inputs = loadAllInputs(out);
    out.log(JSON.stringify(inputs, null, 2));
    return 0;
  }

  if (input.verb === "validate") {
    if (!input.validatePath) {
      throw new RulesCliError(
        "MISSING_PATH",
        "rules validate requires --path <file> (e.g. --path claude/rules/core.md)",
        64,
      );
    }
    const inputs = loadAllInputs(out);
    let markdown: string;
    try {
      markdown = readFileSync(input.validatePath, "utf8");
    } catch (err) {
      throw new RulesCliError(
        "READ_FAILED",
        `failed to read ${input.validatePath}: ${(err as Error).message}`,
        64,
      );
    }
    const failures = runAssertions(markdown, input.validatePath, inputs);
    if (failures.length === 0) {
      emitEvent(out, { type: "RULES_VALIDATED", assertionsRun: 3 });
      if (input.format === "json") {
        out.log(JSON.stringify({ failures: [] }, null, 2));
      }
      return 0;
    }
    emitFailureEvents(out, failures);
    reportFailures(out, failures, input.format);
    return 1;
  }

  // verb === "render"
  const inputs = loadAllInputs(out);
  const markdown = renderCoreMd(inputs);
  const failures = runAssertions(markdown, "<stdout>", inputs);
  if (failures.length > 0) {
    emitFailureEvents(out, failures);
    if (input.format === "json") {
      out.log(JSON.stringify({ markdown, failures }, null, 2));
    } else {
      out.log(markdown);
      for (const f of failures) {
        out.error(`${f.file}:${f.line}: ${f.rule}: ${f.subject}`);
      }
    }
    // Render succeeded but the rendered output failed validation — surface
    // both exit codes through 1 so CI catches drift in the renderer's own
    // output.
    return 1;
  }
  emitEvent(out, { type: "RULES_VALIDATED", assertionsRun: 3 });
  emitEvent(out, { type: "RULES_RENDERED", files: [] });
  if (input.format === "json") {
    out.log(JSON.stringify({ markdown }, null, 2));
  } else {
    out.log(markdown);
  }
  return 0;
}
