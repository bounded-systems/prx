// The project's semantic-web representation: a single JSON-LD `@graph` over
// schema.org, with `@id`s rooted at the GitHub repo. It is the *token store*
// the README (and any external consumer) reads its facts from — `build.ts`
// projects `community/community.json` + each package's `description` into this
// graph, the `prx docs` verb serializes it to the hostable `prx.jsonld`,
// and `src/readme/build.ts` reads its tokens back out of it.
//
// schema.org covers most of it (`SoftwareSourceCode`, `CreativeWork`,
// `Person`, `Organization`); the handful of governance facts schema.org has no
// term for (SPDX id, security SLA, supported-version table, conduct contact)
// are carried under a small repo-rooted `@context` extension, keeping the
// document valid linked data without leaving the schema.org + repo-URL choice.

import { z } from "zod";

/** Repo-rooted IRI prefix for the non-schema.org governance terms. */
export const VOCAB = "https://github.com/bounded-systems/prx#vocab/";

/** The fixed `@context`: schema.org plus the repo-rooted extension terms. */
export const GRAPH_CONTEXT = [
  "https://schema.org",
  {
    prx: VOCAB,
    spdxLicenseId: "prx:spdxLicenseId",
    securityReportUrl: { "@id": "prx:securityReportUrl", "@type": "@id" },
    securityResponseDays: "prx:securityResponseDays",
    supportedVersions: "prx:supportedVersions",
    versionRange: "prx:versionRange",
    supported: "prx:supported",
    conductContact: "prx:conductContact",
    codeOfConductVersion: "prx:codeOfConductVersion",
    backedClaims: "prx:backedClaims",
  },
] as const;

/** A bare `{ "@id": … }` reference to another node. */
const IdRef = z.object({ "@id": z.string().min(1) }).strict();

const Person = z
  .object({
    "@type": z.literal("Person"),
    name: z.string().min(1),
    url: z.string().min(1),
  })
  .strict();

const Organization = z
  .object({
    "@type": z.literal("Organization"),
    name: z.string().min(1),
    url: z.string().min(1),
  })
  .strict();

/** The license as a schema.org CreativeWork; `identifier` carries the SPDX id. */
const License = z
  .object({
    "@type": z.literal("CreativeWork"),
    name: z.string().min(1),
    url: z.string().min(1),
    identifier: z.string().min(1),
  })
  .strict();

const SupportedVersion = z
  .object({
    versionRange: z.string().min(1),
    supported: z.boolean(),
  })
  .strict();

/** One workspace package — a part of the project. */
export const PackageNode = z
  .object({
    "@type": z.literal("SoftwareSourceCode"),
    "@id": z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    codeRepository: z.string().min(1),
    isPartOf: IdRef,
  })
  .strict();
export type PackageNode = z.infer<typeof PackageNode>;

/** One documentation Markdown file — a TechArticle that is part of the project. */
export const DocNode = z
  .object({
    "@type": z.literal("TechArticle"),
    "@id": z.string().min(1),
    name: z.string().min(1),
    url: z.string().min(1),
    isPartOf: IdRef,
  })
  .strict();
export type DocNode = z.infer<typeof DocNode>;

/** The top-level project node, carrying the governance facts. */
export const ProjectNode = z
  .object({
    "@type": z.literal("SoftwareSourceCode"),
    "@id": z.string().min(1),
    name: z.string().min(1),
    /** Short slogan (schema.org/slogan) — the README subtitle / tagline. */
    slogan: z.string().min(1),
    description: z.string().min(1),
    /** The backed value-prop claims the description rests on (gherkin-covered). */
    backedClaims: z.array(z.string().min(1)).min(1),
    codeRepository: z.string().min(1),
    programmingLanguage: z.string().min(1),
    runtimePlatform: z.string().min(1),
    license: License,
    author: Person,
    copyrightHolder: Person,
    copyrightYear: z.string().min(1),
    publisher: Organization,
    securityReportUrl: z.string().min(1),
    securityResponseDays: z.number().int().positive(),
    supportedVersions: z.array(SupportedVersion).min(1),
    conductContact: z.string().min(1),
    codeOfConductVersion: z.string().min(1),
    hasPart: z.array(IdRef).min(1),
  })
  .strict();
export type ProjectNode = z.infer<typeof ProjectNode>;

/** Any node that can appear in the graph. */
export type GraphNode = ProjectNode | PackageNode | DocNode;

/** The full JSON-LD document: a `@context` + a `@graph` of typed nodes. */
export const ProjectGraph = z
  .object({
    "@context": z.union([z.string(), z.array(z.unknown())]),
    "@graph": z.array(z.union([ProjectNode, PackageNode, DocNode])).min(2),
  })
  .strict();
export type ProjectGraph = z.infer<typeof ProjectGraph>;

/** Artifact name used in the `#/definitions/<name>` JSON Schema wrapper. */
export const PROJECT_GRAPH_SCHEMA_NAME = "project_graph";

/** Narrow a graph node to the project node (the SoftwareSourceCode with `hasPart`). */
export function isProjectNode(node: GraphNode): node is ProjectNode {
  return node["@type"] === "SoftwareSourceCode" && "hasPart" in node;
}

/** Narrow a graph node to a package node (a part SoftwareSourceCode). */
export function isPackageNode(node: GraphNode): node is PackageNode {
  return node["@type"] === "SoftwareSourceCode" && !("hasPart" in node);
}

/** Narrow a graph node to a documentation node. */
export function isDocNode(node: GraphNode): node is DocNode {
  return node["@type"] === "TechArticle";
}
