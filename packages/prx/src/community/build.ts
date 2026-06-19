// The community-health rendering, shared by the `prx docs` verb
// so both the script AND the spec-driven `prx docs` verb render the SAME files
// from one place. `community/community.json` (validated against its JSON Schema
// with ajv) is slotted into the pinned templates in `community/templates/`.
//
// All path resolution is LAZY (inside the function, via the repo-root capability)
// — never at import time — so pulling this into the CLI's import graph can't
// eagerly touch the filesystem.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { Ajv } from "ajv";
import addFormats from "ajv-formats";

import { getRepoRoot } from "@bounded-systems/repo-root";

type Json = Record<string, unknown>;

/** One rendered community file: its repo-relative output path + final content. */
export type CommunityTarget = { output: string; content: string };

/** Template → output path (repo-relative). The pinned set of governance files. */
const RENDER_TARGETS: ReadonlyArray<{ template: string; output: string }> = [
  { template: "license.md", output: "LICENSE" },
  { template: "code_of_conduct.md", output: "CODE_OF_CONDUCT.md" },
  { template: "security.md", output: "SECURITY.md" },
  { template: "contributing.md", output: "CONTRIBUTING.md" },
  { template: "pull_request_template.md", output: ".github/PULL_REQUEST_TEMPLATE.md" },
  { template: "issue_config.yml", output: ".github/ISSUE_TEMPLATE/config.yml" },
  { template: "issue_bug_report.yml", output: ".github/ISSUE_TEMPLATE/bug_report.yml" },
  { template: "issue_feature_request.yml", output: ".github/ISSUE_TEMPLATE/feature_request.yml" },
];

function readJson(path: string): Json {
  return JSON.parse(readFileSync(path, "utf8")) as Json;
}

/** Validate community.json against the JSON Schema; throw on any violation. */
function validate(data: Json, schema: Json): void {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  if (!ajv.validate(schema, data)) {
    const detail = (ajv.errors ?? [])
      .map((e) => `  ${e.instancePath || "/"} ${e.message ?? ""}`)
      .join("\n");
    throw new Error(`community.json failed schema validation:\n${detail}`);
  }
}

/** Flatten nested objects to dotted keys; arrays/objects are skipped here. */
function flatten(obj: Json, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(obj)) {
    if (key === "$schema") continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const [k, v] of flatten(value as Json, path)) out.set(k, v);
    } else if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      out.set(path, String(value));
    }
  }
  return out;
}

/** The markdown rows for the supported-versions table. */
function versionTable(data: Json): string {
  const security = data.security as Json;
  const rows = security.supportedVersions as Array<{ range: string; supported: boolean }>;
  return rows.map((r) => `| ${r.range} | ${r.supported ? "Yes" : "No"} |`).join("\n");
}

/** Substitute every `{{ key }}`; throw if any placeholder is left unresolved. */
function render(template: string, dict: Map<string, string>): string {
  const rendered = template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, rawKey) => {
    const key = String(rawKey).trim();
    const value = dict.get(key);
    if (value === undefined) throw new Error(`unknown template key: {{${key}}}`);
    return value;
  });
  const leftover = rendered.match(/\{\{[^}]*\}\}/);
  if (leftover) throw new Error(`unresolved placeholder: ${leftover[0]}`);
  return rendered;
}

/** Render every community file from the validated source. Pure (no writes). */
export function renderCommunityTargets(): CommunityTarget[] {
  const root = getRepoRoot();
  const pkgRoot = resolve(root, "packages/prx");
  const templatesDir = resolve(pkgRoot, "community/templates");
  const data = readJson(resolve(pkgRoot, "community/community.json"));
  const schema = readJson(resolve(pkgRoot, "schemas/community/community.schema.json"));

  validate(data, schema);
  const dict = flatten(data);
  dict.set("security.versionTable", versionTable(data));

  return RENDER_TARGETS.map(({ template, output }) => ({
    output,
    content: render(readFileSync(resolve(templatesDir, template), "utf8"), dict),
  }));
}
