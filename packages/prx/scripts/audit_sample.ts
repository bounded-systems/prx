#!/usr/bin/env bun
/**
 * audit_sample — pull the N most recently closed beads issues and emit
 * a markdown scoring template for the project audit instrument
 * (see docs/audit-instrument-v0.md for the full rubric).
 *
 * Usage:
 *   bun run scripts/audit_sample.ts [-n N] [--write PATH] [--force]
 *
 * By default, the template is written to stdout. With --write PATH,
 * it's written to a file — either PATH directly (if PATH ends in .md)
 * or PATH/YYYY-MM-DD.md (if PATH is a directory or has no extension).
 * The script refuses to overwrite an existing file unless --force, so
 * a scorer doesn't lose a half-finished audit.
 *
 * The script intentionally does NOT pre-compute signals (revert
 * detection, follow-up PR matching, file-surface overlap). The v0
 * instrument trusts scorer judgment; once the instrument proves stable
 * enough to warrant automation, that's the v1 trigger.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

type BeadsIssue = {
  id: string;
  title: string;
  type?: string | null;
  priority?: number | null;
  status?: string | null;
  closed_at?: string | null;
  external_ref?: string | null;
  source_system?: string | null;
};

type ParsedArgs = {
  n: number;
  writePath: string | null;
  force: boolean;
};

function parseArgs(argv: string[]): ParsedArgs {
  let n = 10;
  let writePath: string | null = null;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-n" || arg === "--count") {
      const next = argv[i + 1];
      if (!next) {
        throw new Error(`${arg} requires a numeric argument`);
      }
      const parsed = parseInt(next, 10);
      if (Number.isNaN(parsed) || parsed <= 0) {
        throw new Error(`${arg} requires a positive integer, got ${next}`);
      }
      n = parsed;
      i++;
    } else if (arg === "--write") {
      const next = argv[i + 1];
      if (!next) {
        throw new Error("--write requires a path argument (file or directory)");
      }
      writePath = next;
      i++;
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "-h" || arg === "--help") {
      console.log("Usage: bun run scripts/audit_sample.ts [-n N] [--write PATH] [--force]");
      console.log("See docs/audit-instrument-v0.md for the scoring rubric.");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { n, writePath, force };
}

function resolveWritePath(raw: string, today: string): string {
  // If it's an existing directory, or the path has no .md suffix and no
  // extension, treat as a directory and auto-name the file.
  let looksLikeDir = raw.endsWith("/");
  if (!looksLikeDir) {
    try {
      looksLikeDir = statSync(raw).isDirectory();
    } catch {
      // Doesn't exist yet; fall back to extension heuristic.
    }
  }
  if (looksLikeDir || !raw.toLowerCase().endsWith(".md")) {
    return join(raw, `${today}.md`);
  }
  return raw;
}

function loadClosedIssues(): BeadsIssue[] {
  const result = spawnSync("bd", ["list", "--status=closed", "--json"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `bd list --status=closed --json failed (exit ${result.status ?? "?"}): ${
        result.stderr?.trim() ?? ""
      }`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err) {
    throw new Error(`bd list returned non-JSON output: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("bd list JSON output was not an array");
  }
  return parsed as BeadsIssue[];
}

function pickRecentlyClosed(issues: BeadsIssue[], n: number): BeadsIssue[] {
  return issues
    .filter((issue) => typeof issue.closed_at === "string" && issue.closed_at.length > 0)
    .sort((a, b) => (b.closed_at ?? "").localeCompare(a.closed_at ?? ""))
    .slice(0, n);
}

function formatSample(sample: BeadsIssue[]): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push(`# Audit sample — ${today}`);
  lines.push("");
  lines.push(`N = ${sample.length}. Instrument: \`docs/audit-instrument-v0.md\`.`);
  lines.push("");
  lines.push("Score each issue into exactly one bucket. Write a one-line reason — enough to settle a tie with yourself at the next audit.");
  lines.push("");

  if (sample.length === 0) {
    lines.push("_No closed beads issues found._");
    lines.push("");
    return lines.join("\n");
  }

  const first = sample[sample.length - 1]?.closed_at?.slice(0, 10);
  const last = sample[0]?.closed_at?.slice(0, 10);
  if (first && last) {
    lines.push(`Window: ${first} → ${last}.`);
    lines.push("");
  }

  for (const issue of sample) {
    const closedDate = (issue.closed_at ?? "").slice(0, 10) || "unknown";
    lines.push(`## ${issue.id} — ${issue.title}`);
    lines.push("");
    lines.push(`- Closed: ${closedDate}`);
    if (issue.type) lines.push(`- Type: ${issue.type}`);
    if (typeof issue.priority === "number") lines.push(`- Priority: P${issue.priority}`);
    if (issue.external_ref) lines.push(`- External: ${issue.external_ref}`);
    lines.push("- **Bucket:** [ ] Durable   [ ] Churn   [ ] Learning   [ ] Shelved");
    lines.push("- **Reason:**");
    lines.push("");
  }

  return lines.join("\n");
}

function main(): void {
  const { n, writePath, force } = parseArgs(process.argv.slice(2));
  const closed = loadClosedIssues();
  const sample = pickRecentlyClosed(closed, n);
  const rendered = formatSample(sample);

  if (writePath === null) {
    process.stdout.write(rendered);
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const target = resolveWritePath(writePath, today);
  if (existsSync(target) && !force) {
    console.error(
      `audit_sample: refusing to overwrite existing file ${target} (pass --force to replace it)`,
    );
    process.exit(2);
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, rendered);
  console.log(target);
}

try {
  main();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
