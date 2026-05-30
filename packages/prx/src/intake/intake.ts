/**
 * `prx intake <type>` — file an intake-log work-unit from a conversation
 * (GH-666, GH-1607). Primary write is `bd create`; GitHub projection is
 * opt-in via `--to gh` and routed through `prx beads publish`'s `publishOne`
 * (the GH adapter's single-record push).
 *
 * Intake sits *upstream* of the parity chain — it has no event in the
 * PR-lifecycle state machine. It does not auto-promote to beads (intake log
 * stays separate from the execution queue per the established norm).
 *
 * Under the GH-1500 ADR (`docs/spikes/GH-1500-authority.md`) bd is canonical
 * for every UoW; GitHub is one of many opt-in mirror targets. The default for
 * `prx intake bug|task|feature|chore|spike --title …` is bd-only — zero GH
 * calls. `--to gh` triggers a follow-up projection step that goes through the
 * registered domain adapter, never via a direct `gh issue create` from this
 * actor.
 */

import { processEnv } from "@bounded-systems/env";
import { defaultRunner } from "@bounded-systems/proc";
import {
  readFileSync as nodeReadFileSync,
  readSync as nodeReadSync,
} from "node:fs";
import { basename, relative } from "node:path";
import { z } from "zod";

import { execBd, type BdExecResult } from "@bounded-systems/bd";
import {
  publishOne,
  type BeadsPublishRender,
  type PublishCoreResult,
} from "../beads/publish.ts";
import { AREA, type LabelArea } from "../triage/labels.ts";
import { areaLabelString, typeLabelString } from "../triage/label-vocab.ts";
import {
  INTAKE_BODY_FIELDS_META,
  INTAKE_BODY_SCHEMA_TYPES,
  validateIntakeBody,
  type IntakeBodySchemaType,
} from "./schemas/index.ts";
import {
  INTAKE_INTENTS,
  INTENT_TO_SPEC,
  PREFIX_RE,
  PREFIX_TO_INTAKE_INTENT,
  type IntakeIntent,
  type IntakeType,
} from "./types.ts";

export const intakeOptionsSchema = z
  .object({
    type: z.enum(INTAKE_INTENTS),
    title: z.string().trim().min(1, "title must not be empty"),
    scope: AREA.optional(),
    body: z.string().optional(),
    bodyFile: z.string().optional(),
    bodyStdin: z.boolean().default(false),
    description: z.string().optional(),
    design: z.string().optional(),
    acceptance: z.string().optional(),
    notes: z.string().optional(),
    labels: z.array(z.string()).default([]),
    assignees: z.array(z.string()).default([]),
    repo: z.string().optional(),
    // GH-1607: opt-in projection target. The default — no `--to` — is bd-only
    // (zero GH calls). The enum is narrowed to `["gh"]` until other adapters
    // land; the shape leaves room for `--to notion`, `--to jira`, … per the
    // GH-1500 multi-adapter direction.
    to: z.enum(["gh"]).optional(),
    dryRun: z.boolean().default(false),
    yes: z.boolean().default(false),
    format: z.enum(["plain", "json"]).default("plain"),
  })
  .superRefine((options, ctx) => {
    const bodySources = [
      options.body !== undefined,
      options.bodyFile !== undefined,
      options.bodyStdin,
    ].filter(Boolean).length;

    if (bodySources > 1) {
      const message = "at most one of body, bodyFile, or bodyStdin may be provided";
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["body"], message });
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["bodyFile"], message });
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["bodyStdin"], message });
    }

    // Structured cluster (description/design/acceptance/notes) and freeform
    // cluster (body/bodyFile/bodyStdin) are mutually exclusive. Empty strings
    // count as absent so `--description ""` doesn't trigger the conflict.
    const structuredFields = {
      description: hasContent(options.description),
      design: hasContent(options.design),
      acceptance: hasContent(options.acceptance),
      notes: hasContent(options.notes),
    } as const;
    const structuredPresent = Object.values(structuredFields).some(Boolean);
    const freeformPresent = bodySources > 0;

    if (structuredPresent && freeformPresent) {
      const message =
        "structured fields (--description/--design/--acceptance/--notes) and freeform body (--body, --body @file, --body-stdin) are mutually exclusive";
      for (const path of ["body", "bodyFile", "bodyStdin", "description", "design", "acceptance", "notes"]) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
      }
    }

    // Per-type required-field validation (GH-1258). Only fires once
    // the operator opts into structured-mode (at least one of
    // --description/--design/--acceptance/--notes is present); the
    // freeform `--body` cluster and bare-title intake stay permissive.
    if (freeformPresent || !structuredPresent) return;
    // GH-only marker intents (e.g. `decision`, GH-1955) have no per-type body
    // schema yet — deferred enforcement, same pattern as `spike`. Skip the
    // structured-mode call rather than wedging an empty schema in.
    if (!(INTAKE_BODY_SCHEMA_TYPES as readonly string[]).includes(options.type)) return;
    const validation = validateIntakeBody(options.type as IntakeBodySchemaType, {
      description: options.description,
      design: options.design,
      acceptance: options.acceptance,
      notes: options.notes,
    });
    if (!validation.ok) {
      for (const issue of validation.issues) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [issue.path],
          message: issue.message,
        });
      }
    }
  });

function hasContent(value: string | undefined): boolean {
  return value !== undefined && value.length > 0;
}

export type IntakeOptions = z.infer<typeof intakeOptionsSchema>;

/**
 * Result of the bd-create step — captures the argv that was planned (for
 * dry-run rendering and stderr context) and the exec outcome.
 */
export type IntakeBdCreateResult = {
  /** Args passed after the `create` subcommand (no leading `bd create`). */
  args: string[];
  /** Created bd id (parsed from stdout); null when the create failed or on dry-run. */
  bdId: string | null;
  exitCode: number;
  stderr: string;
};

export type IntakeResult = {
  /** Final composed title sent to bd (and to GH on `--to gh`). */
  title: string;
  /** Final composed body sent to bd (and to GH on `--to gh`). */
  body: string;
  /** Labels operator intended for the GH issue if `--to gh` was set. */
  labels: string[];
  /** Optional repo override forwarded to publish; null when using gh's git-remote default. */
  repo: string | null;
  /** "GH-N" detected from the current worktree, or null. */
  surfacedFrom: string | null;
  /** Projection target requested (`"gh"`) or null for bd-only. */
  to: "gh" | null;
  dryRun: boolean;
  /** bd-create outcome (always present once we reach the bd write step). */
  bdCreate: IntakeBdCreateResult | null;
  /** Projection outcome when `--to gh` was set; null otherwise. */
  publish: BeadsPublishRender | null;
  exitCode: number;
};

export type IntakeDeps = {
  execBd?: typeof execBd;
  publishOne?: typeof publishOne;
  detectBranchName?: (cwd: string) => string | null;
  getRepoRoot?: (cwd: string) => string | null;
  readStdin?: () => string;
  readFile?: (path: string) => string;
  cwd?: () => string;
  isStdinTTY?: () => boolean;
  isStdoutTTY?: () => boolean;
  confirmIntake?: (preview: string, output: Output) => boolean;
};

type Output = {
  log: (line: string) => void;
  error: (line: string) => void;
};

export class IntakeTitleMismatchError extends Error {
  constructor(
    public readonly innerPrefix: string,
    public readonly flagType: IntakeIntent,
    public readonly mappedType: IntakeIntent | null,
  ) {
    const reason = mappedType === null
      ? `title prefix '${innerPrefix}' has no intake-type mapping (intake type was '${flagType}')`
      : `title prefix '${innerPrefix}' disagrees with intake type '${flagType}'`;
    super(reason);
    this.name = "IntakeTitleMismatchError";
  }
}

export function composeTitle(intent: IntakeIntent, title: string, scope?: string): string {
  const prefix = INTENT_TO_SPEC[intent].titlePrefix;
  const match = title.match(PREFIX_RE);
  if (match) {
    const innerPrefix = match[1]!;
    const innerScope = match[2];
    const mapped = PREFIX_TO_INTAKE_INTENT[innerPrefix] ?? null;
    if (mapped !== intent) {
      throw new IntakeTitleMismatchError(innerPrefix, intent, mapped);
    }
    const stripped = title.slice(match[0].length);
    const trimmedScope = scope?.trim();
    const effectiveScope = trimmedScope || innerScope || "";
    return effectiveScope ? `${prefix}(${effectiveScope}): ${stripped}` : `${prefix}: ${stripped}`;
  }
  const trimmedScope = scope?.trim();
  if (trimmedScope) {
    return `${prefix}(${trimmedScope}): ${title}`;
  }
  return `${prefix}: ${title}`;
}

/**
 * Render structured intake fields as labeled markdown sections. Headings
 * are sourced from `INTAKE_BODY_FIELDS_META` so the emitter and the
 * `parseStructuredBody` parser cannot drift. Sections with empty/missing
 * values are omitted; ordering is fixed
 * (Description → Design → Acceptance Criteria → Notes) so downstream
 * consumers can locate fields without re-discovering them.
 */
export function composeStructuredBody(parts: {
  description?: string | undefined;
  design?: string | undefined;
  acceptance?: string | undefined;
  notes?: string | undefined;
}): string {
  const sections: string[] = [];
  const push = (canonicalField: string, value: string | undefined) => {
    if (!hasContent(value)) return;
    const heading = STRUCTURED_HEADINGS[canonicalField];
    sections.push(`## ${heading}\n\n${value}`);
  };
  push("description", parts.description);
  push("design", parts.design);
  push("acceptance_criteria", parts.acceptance);
  push("notes", parts.notes);
  return sections.join("\n\n");
}

// Heading lookup for the four CLI-facing structured fields. Each canonical
// field name has the same heading across every type that declares it; we
// pick `feature` here because it is the only type that declares all four.
// `meta.heading` collisions across types are checked at startup so a future
// schema edit can never silently change the emitter's output.
const STRUCTURED_HEADINGS: Record<string, string> = (() => {
  const fields = ["description", "design", "acceptance_criteria", "notes"] as const;
  const out: Record<string, string> = {};
  for (const field of fields) {
    let heading: string | undefined;
    for (const meta of Object.values(INTAKE_BODY_FIELDS_META)) {
      const declared = meta[field]?.heading;
      if (!declared) continue;
      if (heading === undefined) {
        heading = declared;
      } else if (heading !== declared) {
        throw new Error(
          `INTAKE_BODY_FIELDS_META: heading for '${field}' disagrees across types ('${heading}' vs '${declared}')`,
        );
      }
    }
    if (heading === undefined) {
      throw new Error(
        `INTAKE_BODY_FIELDS_META: no type declares heading for canonical field '${field}'`,
      );
    }
    out[field] = heading;
  }
  return out;
})();

export function composeBody(parts: { surfacedFrom: string | null; userBody: string }): string {
  const { surfacedFrom, userBody } = parts;
  const trimmedUser = userBody.replace(/\s+$/, "");
  if (!surfacedFrom) {
    return trimmedUser;
  }
  const banner = `_Surfaced from ${surfacedFrom}_`;
  if (trimmedUser.length === 0) {
    return banner;
  }
  return `${banner}\n\n${trimmedUser}`;
}

/**
 * Default branch detector — mirrors the helper in src/pr-state/cli.ts:1219
 * but kept self-contained so the intake module can be tested in isolation.
 */
function defaultDetectBranchName(cwd: string): string | null {
  // Best-effort detection: `defaultRunner` throws when git can't be spawned
  // (e.g. ENOENT when the cwd is absent or git is off PATH); the prior raw
  // spawn swallowed that as a null status, so catch it and return null in kind.
  let result;
  try {
    result = defaultRunner(["git", "branch", "--show-current"], {
      cwd,
      check: false,
    });
  } catch {
    return null;
  }
  if (result.status !== 0) return null;
  const branch = result.stdout.trim();
  return branch ? branch : null;
}

function defaultGetRepoRoot(cwd: string): string | null {
  let result;
  try {
    result = defaultRunner(["git", "rev-parse", "--show-toplevel"], {
      cwd,
      check: false,
    });
  } catch {
    return null;
  }
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

/**
 * Maps known repo-relative path prefixes to canonical AREA values.
 * Ordered most-specific first so the first match wins.
 */
const SCOPE_PATH_MAP: ReadonlyArray<readonly [string, LabelArea]> = [
  ["src/beads", "beads"],
  ["src/claude", "claude-code"],
  ["packages/prx-mux", "tmux"],
  ["nix", "home-manager"],
  [".github", "ci"],
  ["src", "prx"],
] as const;

/** Maps a repo directory name to the canonical AREA it represents. */
const REPO_NAME_SCOPE_MAP: Partial<Record<string, LabelArea>> = {
  "ai-home": "prx",
};

/**
 * Infer an AREA scope from the current branch and cwd.
 * Gates on any GH-linked branch (`GH-N` or `GH-N-descriptor`). Returns
 * undefined when the branch is not GH-linked, when the repo root lookup
 * failed, or when no confident mapping exists.
 */
export function inferScope(
  branch: string | null,
  cwd: string,
  repoRoot: string | null,
): LabelArea | undefined {
  if (!branch || !/^GH-\d+/.test(branch) || !repoRoot) return undefined;
  const rel = relative(repoRoot, cwd).replace(/\\/g, "/");
  if (!rel || rel === ".") {
    return REPO_NAME_SCOPE_MAP[basename(repoRoot)] ?? undefined;
  }
  for (const [prefix, area] of SCOPE_PATH_MAP) {
    if (rel === prefix || rel.startsWith(prefix + "/")) return area;
  }
  return undefined;
}

/**
 * Returns the canonical "GH-N" identifier for the current worktree, or null
 * when the cwd is not inside a `GH-N` branch.
 */
export function resolveSurfacedFrom(
  cwd: string,
  detectBranchName: (cwd: string) => string | null = defaultDetectBranchName,
): string | null {
  const branch = detectBranchName(cwd);
  if (!branch) return null;
  const match = branch.match(/^GH-(\d+)$/);
  if (!match) return null;
  return `GH-${match[1]}`;
}

/**
 * Resolve the body string from the three input sources. Mutually exclusive at
 * the CLI parse layer; this function only enforces precedence.
 *
 * `--body` accepts `@/path/to/file` to read from disk (gh-cli convention).
 */
export function resolveBody(
  opts: { body?: string | undefined; bodyFile?: string | undefined; bodyStdin: boolean },
  deps: { readStdin: () => string; readFile: (path: string) => string },
): string {
  if (opts.bodyStdin) {
    return deps.readStdin();
  }
  if (opts.bodyFile) {
    return deps.readFile(opts.bodyFile);
  }
  if (opts.body !== undefined) {
    if (opts.body.startsWith("@") && opts.body.length > 1) {
      return deps.readFile(opts.body.slice(1));
    }
    return opts.body;
  }
  return "";
}

function defaultReadStdin(): string {
  // Bun and Node both expose process.stdin synchronously when piped.
  // readFileSync from /dev/stdin is the simplest cross-runtime path.
  try {
    return nodeReadFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// readFileSync(0) blocks until EOF, which on a TTY only arrives with Ctrl-D —
// pressing Enter alone leaves it hung. readSync in canonical (cooked) mode
// returns the line as soon as the kernel delivers it on Enter, on both Node
// and Bun, without flipping the terminal into raw mode.
function readSingleLine(): string {
  try {
    const buf = Buffer.alloc(256);
    const n = nodeReadSync(0, buf, 0, buf.length, null);
    if (!n || n <= 0) return "";
    const text = buf.toString("utf8", 0, n);
    const eol = text.search(/\r?\n/);
    return eol >= 0 ? text.slice(0, eol) : text;
  } catch {
    return "";
  }
}

function defaultIsStdinTTY(): boolean {
  return Boolean(process.stdin.isTTY);
}

function defaultIsStdoutTTY(): boolean {
  return Boolean(process.stdout.isTTY);
}

function defaultConfirmIntake(preview: string, output: Output): boolean {
  output.log(preview.replace(/^prx intake \(dry-run\)/, "Will file:"));
  output.log("");
  // Write the prompt without a trailing newline so the cursor stays on the
  // same line as the question. Bypass the `Output` abstraction (which always
  // appends `\n`) and target stdout directly — this path only runs at a TTY.
  process.stdout.write("File this issue? [y/N]: ");
  const answer = readSingleLine().trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

export function runIntake(
  opts: IntakeOptions,
  output: Output,
  deps: IntakeDeps = {},
): number {
  const detectBranch = deps.detectBranchName ?? defaultDetectBranchName;
  const getRepoRoot = deps.getRepoRoot ?? defaultGetRepoRoot;
  const cwd = (deps.cwd ?? process.cwd)();
  const readStdin = deps.readStdin ?? defaultReadStdin;
  const readFile = deps.readFile ?? ((p: string) => nodeReadFileSync(p, "utf8"));
  const bdExec = deps.execBd ?? execBd;
  const publish = deps.publishOne ?? publishOne;
  const isStdinTTY = deps.isStdinTTY ?? defaultIsStdinTTY;
  const isStdoutTTY = deps.isStdoutTTY ?? defaultIsStdoutTTY;
  const confirmIntake = deps.confirmIntake ?? defaultConfirmIntake;

  const surfacedFrom = resolveSurfacedFrom(cwd, detectBranch);
  const scope = opts.scope ?? inferScope(detectBranch(cwd), cwd, getRepoRoot(cwd));
  const structuredFields = {
    description: opts.description,
    design: opts.design,
    acceptance: opts.acceptance,
    notes: opts.notes,
  };
  const hasStructured = Object.values(structuredFields).some(hasContent);
  const userBody = hasStructured
    ? composeStructuredBody(structuredFields)
    : resolveBody(
        { body: opts.body, bodyFile: opts.bodyFile, bodyStdin: opts.bodyStdin },
        { readStdin, readFile },
      );
  let title: string;
  try {
    title = composeTitle(opts.type, opts.title, scope);
  } catch (err) {
    if (err instanceof IntakeTitleMismatchError) {
      const remediation = err.mappedType === null
        ? `drop the inner prefix from --title or use a vocab-aligned intake type`
        : `re-run as 'prx intake ${err.mappedType} --title ...' or drop the inner prefix from --title`;
      output.error(`prx intake: ${err.message} — ${remediation}`);
      return 2;
    }
    throw err;
  }
  const body = composeBody({ surfacedFrom, userBody });

  // GH-1489: stamp `type::<bd_type>` at issue-creation time. With the type
  // axis already operator-set at creation, the GH-957 `hasType` gate keeps
  // the type-pass classifier from clobbering it later, closing the GH-1448
  // dual-label drift window structurally instead of patching the classifier.
  // For spike intent, additionally stamp the GH-only `type::spike` marker.
  // GH-1607: these labels reach GH only via the `--to gh` projection step
  // (passed through to `publishOne` as `extraLabels`); the bd-only default
  // touches no GH state.
  const spec = INTENT_TO_SPEC[opts.type];
  const stamped = [
    ...opts.labels,
    typeLabelString(spec.type),
    ...spec.extraLabels,
  ];
  const withArea = scope ? [...stamped, areaLabelString(scope)] : stamped;
  const labels = Array.from(new Set(withArea));

  // bd create primary write. `--silent` prints only the new short-id; the
  // structured args mirror `bd update --description/--design/--acceptance/--notes`
  // semantics so freeform bodies and structured-cluster bodies both round-trip
  // through bd's record shape.
  const bdCreateArgs = buildBdCreateArgs({
    title,
    body,
    issueType: spec.type,
  });

  if (opts.dryRun) {
    const result: IntakeResult = {
      title,
      body,
      labels,
      repo: opts.repo ?? null,
      surfacedFrom,
      to: opts.to ?? null,
      dryRun: true,
      bdCreate: {
        args: bdCreateArgs,
        bdId: null,
        exitCode: 0,
        stderr: "",
      },
      publish: null,
      exitCode: 0,
    };
    output.log(formatIntakeResult(result, opts.format));
    return 0;
  }

  // GH-1486: TTY confirm prompt — defuses the operator foot-gun where probing
  // `prx intake spike --title …` writes a real bd record (and on `--to gh`
  // also a real GH issue) with no preview. `--yes` skips the prompt; non-TTY/CI
  // invocations preserve commit-by-default behavior so scripts and agents are
  // unaffected. Gate on both stdin and stdout being TTYs so a redirected stdout
  // (e.g. `… > out.txt`, or piped to a JSON parser under `--format json`)
  // doesn't get the prompt mixed into its output stream.
  if (!opts.yes && isStdinTTY() && isStdoutTTY()) {
    const previewResult: IntakeResult = {
      title,
      body,
      labels,
      repo: opts.repo ?? null,
      surfacedFrom,
      to: opts.to ?? null,
      dryRun: true,
      bdCreate: {
        args: bdCreateArgs,
        bdId: null,
        exitCode: 0,
        stderr: "",
      },
      publish: null,
      exitCode: 0,
    };
    const preview = formatIntakeResult(previewResult, "plain");
    if (!confirmIntake(preview, output)) {
      output.error("prx intake: aborted by operator (no record written)");
      return 1;
    }
  }

  // Step 1: bd create — the primary, canonical write. Planning-tier override
  // is required because the default executor role can't bd create/update.
  const bdResult: BdExecResult = bdExec(
    {
      subcommand: "create",
      args: bdCreateArgs,
      state: "planning",
      role: "planner",
    },
    processEnv(),
  );
  if (bdResult.exitCode !== 0) {
    const detail =
      bdResult.stderr.trim() || bdResult.stdout.trim() || "bd create failed";
    output.error(`prx intake: ${detail}`);
    const result: IntakeResult = {
      title,
      body,
      labels,
      repo: opts.repo ?? null,
      surfacedFrom,
      to: opts.to ?? null,
      dryRun: false,
      bdCreate: {
        args: bdCreateArgs,
        bdId: null,
        exitCode: bdResult.exitCode,
        stderr: bdResult.stderr,
      },
      publish: null,
      exitCode: bdResult.exitCode || 1,
    };
    if (opts.format === "json") output.log(formatIntakeResult(result, "json"));
    return result.exitCode;
  }

  // bd create --silent prints only the new id; be tolerant of trailing
  // newlines or stray status lines by taking the last non-empty line.
  const stdoutLines = bdResult.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const bdId = stdoutLines[stdoutLines.length - 1] ?? "";
  if (!bdId) {
    output.error("prx intake: bd create returned empty stdout");
    return 1;
  }

  const bdCreate: IntakeBdCreateResult = {
    args: bdCreateArgs,
    bdId,
    exitCode: 0,
    stderr: bdResult.stderr,
  };

  // Step 2: optional GH projection via `publishOne` — the GH adapter's
  // single-record push, gated on `--to gh`. Without this flag the verb is
  // bd-only and never reaches GH (per GH-1500 §1 corollary, GH-1607 acceptance).
  let publishRender: BeadsPublishRender | null = null;
  if (opts.to === "gh") {
    const publishResult: PublishCoreResult = publish(
      {
        bdId,
        repo: opts.repo,
        dryRun: false,
        noAdopt: false,
        extraLabels: labels,
        format: "plain",
      },
      { execBd: bdExec },
    );
    publishRender = publishResult.render;
    if (publishResult.exitCode !== 0) {
      // Surface the projection error on stderr but keep the bd-id as the
      // primary handle; the bd record exists either way.
      if (publishRender.message) output.error(`prx intake: ${publishRender.message}`);
      const result: IntakeResult = {
        title,
        body,
        labels,
        repo: opts.repo ?? null,
        surfacedFrom,
        to: "gh",
        dryRun: false,
        bdCreate,
        publish: publishRender,
        exitCode: publishResult.exitCode,
      };
      output.log(formatIntakeResult(result, opts.format));
      return publishResult.exitCode;
    }
  }

  const result: IntakeResult = {
    title,
    body,
    labels,
    repo: opts.repo ?? null,
    surfacedFrom,
    to: opts.to ?? null,
    dryRun: false,
    bdCreate,
    publish: publishRender,
    exitCode: 0,
  };
  output.log(formatIntakeResult(result, opts.format));
  return 0;
}

// `bd create` argv builder. The composed body — surfaced-from banner +
// freeform body OR rendered structured-cluster sections — goes onto bd's
// `--description` axis as a single blob. We don't split structured fields
// into bd's separate `--design/--acceptance/--notes` slots because the body
// already renders them inline as labeled markdown sections (the same shape
// the GH adapter will mirror); splitting would diverge the bd-side and
// GH-side body shapes, breaking publishOne's title+description→GH parity.
function buildBdCreateArgs(parts: {
  title: string;
  body: string;
  issueType: IntakeType;
}): string[] {
  const args: string[] = ["--silent", "--type", parts.issueType, "--title", parts.title];
  if (parts.body.length > 0) args.push("--description", parts.body);
  return args;
}

function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  if (/^[A-Za-z0-9_/.:@=+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function formatIntakeResult(
  result: IntakeResult,
  format: "plain" | "json",
): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }
  if (result.dryRun) {
    const bdArgs = result.bdCreate?.args ?? [];
    const lines = [
      "prx intake (dry-run)",
      `  title:          ${result.title}`,
      `  surfaced-from:  ${result.surfacedFrom ?? "(none — not in a GH-N worktree)"}`,
      `  to:             ${result.to ?? "(none — bd-only)"}`,
      `  repo:           ${result.repo ?? "(default — gh's git remote)"}`,
      `  labels:         ${result.labels.length ? result.labels.join(", ") : "(none)"}`,
      `  body:`,
      ...result.body.split(/\r?\n/).map((line) => `    ${line}`),
      `  would run:`,
      `    bd create ${bdArgs.map(shellQuote).join(" ")}`,
    ];
    if (result.to === "gh") {
      lines.push(
        `    prx beads publish <bd-id>${result.repo ? ` --repo ${shellQuote(result.repo)}` : ""}`,
      );
    }
    return lines.join("\n");
  }
  // Plain output: bd-id is the primary handle (per the GH-1500 model). The
  // GH URL is appended on a second line when `--to gh` succeeded so an
  // operator can copy either handle out of a one-or-two-line render.
  const bdId = result.bdCreate?.bdId ?? "";
  if (!bdId) return "";
  if (result.publish && result.publish.externalRef) {
    return `${bdId}\n${result.publish.externalRef}`;
  }
  return bdId;
}
