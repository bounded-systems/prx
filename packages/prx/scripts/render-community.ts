#!/usr/bin/env bun
/**
 * Render the community health files from a single validated source of truth.
 *
 * `community/community.json` holds the variable facts (project, copyright,
 * license, security, conduct). It is validated against
 * `schemas/community/community.schema.json` with ajv, then rendered into the
 * pinned templates in `community/templates/`. The license body (PolyForm
 * Noncommercial 1.0.0) and the Code of Conduct body (Contributor Covenant 2.1)
 * are verbatim canonical text pinned to immutable versions — only the slotted
 * facts (`{{copyright.holder}}`, `{{conduct.contact}}`, …) are substituted.
 *
 * Outputs (repo root):
 *   LICENSE, CODE_OF_CONDUCT.md, SECURITY.md, CONTRIBUTING.md
 *
 * Usage:
 *   bun run scripts/render-community.ts            # write the files
 *   bun run scripts/render-community.ts --check    # fail if rendering drifts
 *
 * CI runs --check: invalid data or any drift between the rendered output and
 * the committed files exits non-zero.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv } from "ajv";
import addFormats from "ajv-formats";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const repoRoot = resolve(pkgRoot, "..", "..");
const communityDir = resolve(pkgRoot, "community");
const templatesDir = resolve(communityDir, "templates");
const schemaPath = resolve(pkgRoot, "schemas/community/community.schema.json");
const dataPath = resolve(communityDir, "community.json");

type Json = Record<string, unknown>;

/** One template -> one rendered file, relative to the repo root. */
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
  const ok = ajv.validate(schema, data);
  if (!ok) {
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
    } else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out.set(path, String(value));
    }
  }
  return out;
}

/** Build the markdown rows for the supported-versions table. */
function versionTable(data: Json): string {
  const security = data.security as Json;
  const rows = security.supportedVersions as Array<{ range: string; supported: boolean }>;
  return rows
    .map((r) => `| ${r.range} | ${r.supported ? "Yes" : "No"} |`)
    .join("\n");
}

/** Substitute every `{{ key }}`; throw if any placeholder is left unresolved. */
function render(template: string, dict: Map<string, string>): string {
  const rendered = template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, rawKey) => {
    const key = String(rawKey).trim();
    const value = dict.get(key);
    if (value === undefined) throw new Error(`unknown template key: {{${key}}}`);
    return value;
  });
  const leftover = rendered.match(/\{\{[^}]*\}\}/);
  if (leftover) throw new Error(`unresolved placeholder: ${leftover[0]}`);
  return rendered;
}

function main(): void {
  const check = process.argv.includes("--check");
  const data = readJson(dataPath);
  const schema = readJson(schemaPath);

  validate(data, schema);

  const dict = flatten(data);
  dict.set("security.versionTable", versionTable(data));

  const drift: string[] = [];
  for (const { template, output } of RENDER_TARGETS) {
    const tmpl = readFileSync(resolve(templatesDir, template), "utf8");
    const next = render(tmpl, dict);
    const outPath = resolve(repoRoot, output);

    if (check) {
      let current = "";
      try {
        current = readFileSync(outPath, "utf8");
      } catch {
        current = "";
      }
      if (current !== next) drift.push(output);
    } else {
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, next, "utf8");
      console.log(`wrote ${outPath}`);
    }
  }

  if (check) {
    if (drift.length > 0) {
      console.error(
        `community files are out of date: ${drift.join(", ")}\n` +
          `run \`bun run community:render\` and commit the result.`,
      );
      process.exit(1);
    }
    console.log("community files are up to date");
  }
}

main();
