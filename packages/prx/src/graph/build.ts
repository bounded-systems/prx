// Project `community/community.json` + per-package descriptions into the
// JSON-LD `@graph` defined in `model.ts`. This is the single place the facts
// are assembled into linked data; the `prx docs` verb serializes the result
// to the hostable `prx.jsonld`, and `src/readme/build.ts` reads its tokens back
// out, so the README and the published graph cannot disagree.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, relative, resolve } from "node:path";

import { getRepoRoot } from "../repo-root.ts";
const REPO_ROOT = getRepoRoot();
import { GRAPH_CONTEXT, ProjectGraph, type DocNode, type PackageNode } from "./model.ts";

export const SCOPE = "@bounded-systems/";
export const CLI_PACKAGE = `${SCOPE}prx`;

const packagesDir = resolve(REPO_ROOT, "packages");
const communityPath = resolve(REPO_ROOT, "packages/prx/community/community.json");
export const GRAPH_OUTPUT = resolve(REPO_ROOT, "prx.jsonld");

type Json = Record<string, unknown>;

function readJson(path: string): Json {
  return JSON.parse(readFileSync(path, "utf8")) as Json;
}

/** Short name without the `@bounded-systems/` scope, e.g. `cas`. */
export function shortName(name: string): string {
  return name.startsWith(SCOPE) ? name.slice(SCOPE.length) : name;
}

/**
 * Read every `packages/<name>/package.json`, returning name + description for
 * the `@bounded-systems` workspace packages, sorted by short name. Throws —
 * listing every offender — if any is missing a `description`, so the graph
 * source of truth stays complete.
 */
export function collectPackages(): Array<{ name: string; description: string }> {
  const entries: Array<{ name: string; description: string }> = [];
  const missing: string[] = [];
  for (const dirent of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    let manifest: Json;
    try {
      manifest = readJson(resolve(packagesDir, dirent.name, "package.json"));
    } catch {
      continue; // a directory without a package.json is not a workspace package
    }
    const name = typeof manifest.name === "string" ? manifest.name : "";
    if (!name.startsWith(SCOPE)) continue;
    const description = typeof manifest.description === "string" ? manifest.description.trim() : "";
    if (!description) {
      missing.push(name);
      continue;
    }
    entries.push({ name, description });
  }
  if (missing.length > 0) {
    throw new Error(
      `packages missing a "description" (required for the project graph):\n` +
        missing.map((n) => `  ${n}`).join("\n"),
    );
  }
  return entries.sort((a, b) => shortName(a.name).localeCompare(shortName(b.name)));
}

/** The repo's `tree/main` URL for a package directory — the package node `@id`. */
function packageId(repoUrl: string, name: string): string {
  return `${repoUrl}/tree/main/packages/${shortName(name)}`;
}

/** Recursively collect `*.md` paths under a directory (missing dir → none). */
function walkMarkdown(dir: string): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkMarkdown(full));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

/** The doc's title — its first `# ` heading, falling back to the file name. */
function docTitle(path: string): string {
  const match = readFileSync(path, "utf8").match(/^#\s+(.+)$/m);
  return match ? match[1]!.trim() : basename(path);
}

/**
 * Repo-relative paths of the project's prose docs: the top-level docs (README,
 * CONTRIBUTING, …), everything under `docs/`, the `spec/` readme, and each
 * package's README. Tooling/config Markdown (`.github/`, `.claude/`, `.beads/`,
 * `.changeset/`, the `community/templates/` sources, CHANGELOG) is excluded —
 * `test/markdown-coverage.test.ts` enforces that every tracked `.md` is either
 * returned here or explicitly listed there. Sorted for a stable graph.
 */
/** Root-level Markdown that is agent/tool *config*, not project documentation. */
const ROOT_CONFIG_MD = new Set(["CLAUDE.md", "AGENTS.md"]);

export function collectDocRelPaths(): string[] {
  const paths = new Set<string>(walkMarkdown(resolve(REPO_ROOT, "docs")));
  // Top-level docs only (non-recursive) — skips dotted tooling dirs entirely,
  // and agent-instruction files (CLAUDE.md/AGENTS.md), which are config.
  for (const entry of readdirSync(REPO_ROOT, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md") && !ROOT_CONFIG_MD.has(entry.name)) {
      paths.add(resolve(REPO_ROOT, entry.name));
    }
  }
  const specReadme = resolve(REPO_ROOT, "spec", "README.md");
  if (existsSync(specReadme)) paths.add(specReadme);
  for (const dirent of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const readme = resolve(packagesDir, dirent.name, "README.md");
    if (existsSync(readme)) paths.add(readme);
  }
  return [...paths].map((p) => relative(REPO_ROOT, p)).sort();
}

export function collectDocs(repoUrl: string): DocNode[] {
  return collectDocRelPaths().map((rel) => {
    const url = `${repoUrl}/blob/main/${rel}`;
    return {
      "@type": "TechArticle",
      "@id": url,
      name: docTitle(resolve(REPO_ROOT, rel)),
      url,
      isPartOf: { "@id": repoUrl },
    };
  });
}

/** Build and validate the JSON-LD project graph from the edit-surface sources. */
export function buildGraph(): ProjectGraph {
  const community = readJson(communityPath);
  const project = (community.project ?? {}) as Json;
  const copyright = (community.copyright ?? {}) as Json;
  const license = (community.license ?? {}) as Json;
  const security = (community.security ?? {}) as Json;
  const conduct = (community.conduct ?? {}) as Json;

  const repoUrl = String(project.url);
  const orgUrl = `https://github.com/${String(project.org)}`;
  const maintainer = {
    "@type": "Person" as const,
    name: String(copyright.holder),
    url: String(copyright.url),
  };

  const packages = collectPackages();
  const packageNodes: PackageNode[] = packages.map((pkg) => ({
    "@type": "SoftwareSourceCode",
    "@id": packageId(repoUrl, pkg.name),
    name: pkg.name,
    description: pkg.description,
    codeRepository: repoUrl,
    isPartOf: { "@id": repoUrl },
  }));

  const supportedVersions = (
    (security.supportedVersions ?? []) as Array<{ range: string; supported: boolean }>
  ).map((v) => ({ versionRange: v.range, supported: v.supported }));

  const graph = {
    "@context": GRAPH_CONTEXT,
    "@graph": [
      {
        "@type": "SoftwareSourceCode",
        "@id": repoUrl,
        name: String(project.name),
        slogan: String(project.tagline),
        description: String(project.description),
        backedClaims: ((project.claims ?? []) as unknown[]).map(String),
        codeRepository: repoUrl,
        programmingLanguage: "TypeScript",
        runtimePlatform: "Bun",
        license: {
          "@type": "CreativeWork",
          name: String(license.name),
          url: String(license.url),
          identifier: String(license.spdx),
        },
        author: maintainer,
        copyrightHolder: maintainer,
        copyrightYear: String(copyright.year),
        publisher: {
          "@type": "Organization",
          name: String(project.org),
          url: orgUrl,
        },
        securityReportUrl: String(security.reportUrl),
        securityResponseDays: Number(security.responseDays),
        supportedVersions,
        conductContact: String(conduct.contact),
        codeOfConductVersion: String(conduct.covenantVersion),
        hasPart: packageNodes.map((node) => ({ "@id": node["@id"] })),
      },
      ...packageNodes,
      ...collectDocs(repoUrl),
    ],
  };

  return ProjectGraph.parse(graph);
}

/** Serialize the graph exactly as `prx.jsonld` is committed. */
export function renderGraph(): string {
  return JSON.stringify(buildGraph(), null, 2) + "\n";
}
