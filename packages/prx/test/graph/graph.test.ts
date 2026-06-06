// JSON-LD project-graph codegen parity. The committed `prx.jsonld` and the
// graph model's JSON Schema artifact must match what the sources regenerate,
// and the graph must be well-formed linked data. Mirrors the README and
// derive-schema parity tests.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { toJsonSchemaArtifact } from "../../src/lib/json-schema.ts";
import {
  GRAPH_OUTPUT,
  buildGraph,
  collectPackages,
  renderGraph,
} from "../../src/graph/build.ts";
import {
  PROJECT_GRAPH_SCHEMA_NAME,
  ProjectGraph,
  isDocNode,
  isPackageNode,
  isProjectNode,
} from "../../src/graph/model.ts";

const repoRoot = resolve(import.meta.dir, "../..");
const REPO_URL = "https://github.com/bounded-systems/prx";

describe("project graph (prx.jsonld)", () => {
  test("prx.jsonld matches the rendered sources (run `bun run jsonld:render`)", () => {
    const onDisk = readFileSync(GRAPH_OUTPUT, "utf8");
    expect(onDisk).toEqual(renderGraph());
  });

  test("project-graph.schema.json matches the Zod model (run `bun run schemas:export`)", () => {
    const onDisk = JSON.parse(
      readFileSync(
        resolve(repoRoot, "schemas/graph/project-graph.schema.json"),
        "utf8",
      ),
    );
    const regenerated = toJsonSchemaArtifact(ProjectGraph, PROJECT_GRAPH_SCHEMA_NAME);
    expect(onDisk).toEqual(regenerated);
  });

  test("the committed graph parses against the Zod model", () => {
    const onDisk = JSON.parse(readFileSync(GRAPH_OUTPUT, "utf8"));
    expect(() => ProjectGraph.parse(onDisk)).not.toThrow();
  });

  test("the graph is well-formed linked data", () => {
    const graph = buildGraph();
    const nodes = graph["@graph"];
    const projects = nodes.filter(isProjectNode);
    const packages = nodes.filter(isPackageNode);
    const docs = nodes.filter(isDocNode);

    // Exactly one project node, rooted at the repo URL.
    expect(projects.length).toBe(1);
    expect(projects[0]!["@id"]).toBe(REPO_URL);

    // A package node per workspace package, each part of the project.
    expect(packages.length).toBe(collectPackages().length);
    for (const pkg of packages) {
      expect(pkg.isPartOf["@id"]).toBe(REPO_URL);
      expect(pkg["@id"].startsWith(`${REPO_URL}/tree/main/packages/`)).toBe(true);
    }

    // Documentation nodes link back to the project via dereferenceable URLs.
    expect(docs.length).toBeGreaterThan(0);
    for (const doc of docs) {
      expect(doc.isPartOf["@id"]).toBe(REPO_URL);
      expect(doc["@id"].startsWith(`${REPO_URL}/blob/main/`)).toBe(true);
      expect(doc.name.length).toBeGreaterThan(0);
    }

    // hasPart references exactly the package nodes (no dangling links).
    const partIds = new Set(projects[0]!.hasPart.map((r) => r["@id"]));
    const pkgIds = new Set(packages.map((p) => p["@id"]));
    expect(partIds).toEqual(pkgIds);

    // Every @id is unique across the graph.
    const ids = nodes.map((n) => n["@id"]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
