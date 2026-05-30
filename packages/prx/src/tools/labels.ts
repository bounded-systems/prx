// `prx tools labels sync` — project the Zod label vocab onto a GH repo.
//
// The schema in src/triage/labels.ts is canonical; GH labels are the
// projection. This verb computes a create/update/delete diff and applies it
// idempotently:
//   - create: definition in schema, not on GH
//   - update: same name, but description or color drifted from schema
//   - unknown: on GH, not in schema (touched only with --prune)
//
// Intentionally separate from src/tools/gh.ts (which is scoped to `gh pr` and
// the PR-lifecycle policy table). Label management is planning-tier metadata
// and does not transition any parity-chain state.

import { processEnv } from "@bounded-systems/env";
import { spawnCapture } from "@bounded-systems/proc";

import { defaultLabelDefinitions, type LabelDefinition } from "../triage/labels.ts";

export type SyncLabelsOptions = {
  /** OWNER/REPO override; when omitted gh uses the cwd's git remote. */
  repo?: string | undefined;
  /** Delete labels not in the schema. Default false. */
  prune?: boolean | undefined;
  /** Don't apply, just compute and return the diff. */
  dryRun?: boolean | undefined;
  /** Working directory for spawned `gh` calls. Defaults to process.cwd(). */
  cwd?: string | undefined;
};

export type GhLabel = {
  name: string;
  description: string;
  color: string;
};

export type LabelDiff = {
  creates: LabelDefinition[];
  updates: Array<{ from: GhLabel; to: LabelDefinition }>;
  unknown: GhLabel[];
};

export type SyncLabelsResult = {
  repo: string | null;
  diff: LabelDiff;
  applied: {
    created: string[];
    updated: string[];
    deleted: string[];
  };
  dryRun: boolean;
  pruneRequested: boolean;
};

export type GhLabelSpawnResult = {
  status: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  error?: Error | undefined;
};

export type GhLabelSpawn = (
  args: string[],
  options: { cwd?: string | undefined },
) => GhLabelSpawnResult;

export type SyncLabelsDeps = {
  spawn?: GhLabelSpawn;
  schema?: () => LabelDefinition[];
};

const defaultSpawn: GhLabelSpawn = (args, options) => {
  const result = spawnCapture(["gh", ...args], {
    cwd: options.cwd,
    env: processEnv(),
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
  };
};

function decode(value: string | Buffer | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return value.toString("utf8");
}

export function listGhLabels(
  repo: string | undefined,
  cwd: string | undefined,
  spawn: GhLabelSpawn,
): GhLabel[] {
  const args = ["label", "list", "--json", "name,description,color", "--limit", "1000"];
  if (repo) args.push("--repo", repo);
  const result = spawn(args, { cwd });
  if (result.status !== 0) {
    const stderr = result.error?.message || decode(result.stderr).trim() || decode(result.stdout).trim() || "gh label list failed";
    throw new Error(`prx tools labels sync: ${stderr}`);
  }
  const stdout = decode(result.stdout);
  let raw: unknown;
  try {
    raw = JSON.parse(stdout || "[]");
  } catch {
    throw new Error("prx tools labels sync: gh label list returned invalid JSON");
  }
  if (!Array.isArray(raw)) {
    throw new Error("prx tools labels sync: expected gh label list to return an array");
  }
  const labels: GhLabel[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    const name = typeof rec.name === "string" ? rec.name : null;
    if (!name) continue;
    const description = typeof rec.description === "string" ? rec.description : "";
    const color = typeof rec.color === "string" ? rec.color : "";
    labels.push({ name, description, color });
  }
  return labels;
}

export function computeLabelDiff(
  schema: LabelDefinition[],
  existing: GhLabel[],
): LabelDiff {
  const existingByName = new Map(existing.map((l) => [l.name, l]));
  const schemaByName = new Map(schema.map((d) => [d.name, d]));

  const creates: LabelDefinition[] = [];
  const updates: Array<{ from: GhLabel; to: LabelDefinition }> = [];

  for (const def of schema) {
    const current = existingByName.get(def.name);
    if (!current) {
      creates.push(def);
      continue;
    }
    const colorDrift = current.color.toLowerCase() !== def.color.toLowerCase();
    const descDrift = current.description !== def.description;
    if (colorDrift || descDrift) {
      updates.push({ from: current, to: def });
    }
  }

  const unknown: GhLabel[] = [];
  for (const label of existing) {
    if (!schemaByName.has(label.name)) unknown.push(label);
  }

  return { creates, updates, unknown };
}

function ghCreate(spawn: GhLabelSpawn, repo: string | undefined, cwd: string | undefined, def: LabelDefinition): void {
  const args = ["label", "create", def.name, "--description", def.description, "--color", def.color];
  if (repo) args.push("--repo", repo);
  const result = spawn(args, { cwd });
  if (result.status !== 0) {
    const stderr = result.error?.message || decode(result.stderr).trim() || decode(result.stdout).trim() || `gh label create ${def.name} failed`;
    throw new Error(`prx tools labels sync: ${stderr}`);
  }
}

function ghEdit(spawn: GhLabelSpawn, repo: string | undefined, cwd: string | undefined, def: LabelDefinition): void {
  const args = ["label", "edit", def.name, "--description", def.description, "--color", def.color];
  if (repo) args.push("--repo", repo);
  const result = spawn(args, { cwd });
  if (result.status !== 0) {
    const stderr = result.error?.message || decode(result.stderr).trim() || decode(result.stdout).trim() || `gh label edit ${def.name} failed`;
    throw new Error(`prx tools labels sync: ${stderr}`);
  }
}

function ghDelete(spawn: GhLabelSpawn, repo: string | undefined, cwd: string | undefined, name: string): void {
  const args = ["label", "delete", name, "--yes"];
  if (repo) args.push("--repo", repo);
  const result = spawn(args, { cwd });
  if (result.status !== 0) {
    const stderr = result.error?.message || decode(result.stderr).trim() || decode(result.stdout).trim() || `gh label delete ${name} failed`;
    throw new Error(`prx tools labels sync: ${stderr}`);
  }
}

export function syncLabels(
  opts: SyncLabelsOptions,
  deps: SyncLabelsDeps = {},
): SyncLabelsResult {
  const spawn = deps.spawn ?? defaultSpawn;
  const schemaFn = deps.schema ?? defaultLabelDefinitions;
  const cwd = opts.cwd;
  const schema = schemaFn();
  const existing = listGhLabels(opts.repo, cwd, spawn);
  const diff = computeLabelDiff(schema, existing);

  const applied = { created: [] as string[], updated: [] as string[], deleted: [] as string[] };
  const dryRun = opts.dryRun ?? false;
  const pruneRequested = opts.prune ?? false;

  if (!dryRun) {
    for (const def of diff.creates) {
      ghCreate(spawn, opts.repo, cwd, def);
      applied.created.push(def.name);
    }
    for (const u of diff.updates) {
      ghEdit(spawn, opts.repo, cwd, u.to);
      applied.updated.push(u.to.name);
    }
    if (pruneRequested) {
      for (const label of diff.unknown) {
        ghDelete(spawn, opts.repo, cwd, label.name);
        applied.deleted.push(label.name);
      }
    }
  }

  return {
    repo: opts.repo ?? null,
    diff,
    applied,
    dryRun,
    pruneRequested,
  };
}

export function formatSyncLabelsResult(
  result: SyncLabelsResult,
  format: "plain" | "json",
): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }
  const lines: string[] = [];
  const repoLabel = result.repo ?? "(repo from cwd)";
  const mode = result.dryRun ? "dry-run" : "applied";
  lines.push(`prx tools labels sync — ${repoLabel} [${mode}]`);
  lines.push("");

  const { creates, updates, unknown } = result.diff;
  lines.push(`  + create  ${creates.length}`);
  for (const def of creates) lines.push(`    + ${def.name}`);
  lines.push(`  ~ update  ${updates.length}`);
  for (const u of updates) lines.push(`    ~ ${u.to.name}`);
  lines.push(`  - unknown ${unknown.length}${result.pruneRequested ? " (will delete with --prune)" : " (kept; pass --prune to delete)"}`);
  for (const label of unknown) lines.push(`    - ${label.name}`);

  if (!result.dryRun) {
    lines.push("");
    lines.push(`  applied: created=${result.applied.created.length} updated=${result.applied.updated.length} deleted=${result.applied.deleted.length}`);
  }

  return lines.join("\n");
}
