// Read the README's tokens out of the JSON-LD project graph (the token store)
// and render the pinned template. The graph — not `community.json` directly —
// is the source the README is projected from, so the published `prx.jsonld` and
// the README cannot disagree. Shared by `scripts/gen-readme.ts` (write /
// --check) and `test/scripts/readme.test.ts` (drift parity).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { REPO_ROOT } from "../repo-root.ts";
import {
  CLI_PACKAGE,
  buildGraph,
  shortName,
} from "../graph/build.ts";
import { isPackageNode, isProjectNode, type PackageNode } from "../graph/model.ts";
import { ReadmeModel } from "./model.ts";

const GITHUB_PREFIX = "https://github.com/";

const templatePath = resolve(
  REPO_ROOT,
  "packages/prx/community/templates/readme.md",
);
export const README_OUTPUT = resolve(REPO_ROOT, "README.md");

/** Map a package graph node to a README Layout entry. */
function toEntry(node: PackageNode): { name: string; short: string; description: string } {
  return { name: node.name, short: shortName(node.name), description: node.description };
}

/** Build and validate the typed intermediate the README is rendered from. */
export function buildReadmeModel(): ReadmeModel {
  const graph = buildGraph();
  const project = graph["@graph"].find(isProjectNode);
  if (!project) throw new Error("project graph has no project node");
  const packages = graph["@graph"].filter(isPackageNode);

  const repo = project.codeRepository.startsWith(GITHUB_PREFIX)
    ? project.codeRepository.slice(GITHUB_PREFIX.length)
    : project.codeRepository;
  const org = repo.split("/")[0] ?? "";

  const cli = packages.find((p) => p.name === CLI_PACKAGE);
  if (!cli) throw new Error(`graph missing CLI package ${CLI_PACKAGE}`);
  const libraries = packages
    .filter((p) => p.name !== CLI_PACKAGE)
    .map(toEntry)
    .sort((a, b) => a.short.localeCompare(b.short));

  return ReadmeModel.parse({
    project: {
      name: project.name,
      tagline: project.description,
      org,
      repo,
      url: project.codeRepository,
    },
    license: {
      spdx: project.license.identifier,
      name: project.license.name,
      url: project.license.url,
    },
    maintainerUrl: project.author.url,
    cli: toEntry(cli),
    libraries,
  });
}

/** Render the generated Layout bullet list (the libraries, indented). */
function renderLayout(model: ReadmeModel): string {
  return model.libraries
    .map((lib) => `    - \`${lib.short}\` — ${lib.description.replace(/\.$/, "")}`)
    .join("\n");
}

/** Flatten the model into the dotted `{{ key }}` lookup the template uses. */
function templateDict(model: ReadmeModel): Map<string, string> {
  return new Map<string, string>([
    ["project.name", model.project.name],
    ["project.tagline", model.project.tagline],
    ["project.org", model.project.org],
    ["project.repo", model.project.repo],
    ["project.url", model.project.url],
    ["license.spdx", model.license.spdx],
    ["license.name", model.license.name],
    ["license.url", model.license.url],
    ["maintainerUrl", model.maintainerUrl],
    ["cli.description", model.cli.description],
    ["layout", renderLayout(model)],
  ]);
}

/** Substitute every `{{ key }}`; throw on any unknown or unresolved slot. */
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

/** The full rendered README text for the current sources. */
export function renderReadme(): string {
  const model = buildReadmeModel();
  const template = readFileSync(templatePath, "utf8");
  return render(template, templateDict(model));
}
