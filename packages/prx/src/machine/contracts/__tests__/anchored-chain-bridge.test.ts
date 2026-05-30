import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import type {
  ContractId,
  ContractRegistry,
  Digest,
} from "@bounded-systems/anchored-chain";
import { sha256Hex } from "@bounded-systems/anchored-chain";

import { agentContractSchema } from "../../contracts.ts";
import { getArtifactContract } from "../artifacts.ts";
import { agentRegistry } from "../instances.ts";
import {
  defaultMachineSchemaMap,
  anchoredChainBridge,
} from "../anchored-chain-bridge.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE_FILE = resolve(HERE, "..", "anchored-chain-bridge.ts");

const reportAgent = agentRegistry.report!;

function encode(value: unknown): { bytes: Uint8Array; digest: Digest } {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return { bytes, digest: sha256Hex(bytes) };
}

const VALID_STATUS_UPDATE = {
  unitId: "GH-1962",
  uow_refs: ["GH-1962"],
  body: "report says all green",
  author: "report-agent",
  ts: "2026-05-18T12:00:00Z",
};

describe("anchoredChainBridge", () => {
  test("returns a ContractRegistry", () => {
    const registry: ContractRegistry = anchoredChainBridge({
      agent: reportAgent,
      schemas: defaultMachineSchemaMap(),
    });
    expect(typeof registry.getValidator).toBe("function");
  });

  test("in-scope live schema with valid bytes ⇒ ok", () => {
    const registry = anchoredChainBridge({
      agent: reportAgent,
      schemas: defaultMachineSchemaMap(),
    });
    const { bytes, digest } = encode(VALID_STATUS_UPDATE);
    const validate = registry.getValidator("status_update" as ContractId);
    expect(validate(digest, bytes)).toEqual({ ok: true });
  });

  test("in-scope live schema, tampered field ⇒ fail with reason naming the field", () => {
    const registry = anchoredChainBridge({
      agent: reportAgent,
      schemas: defaultMachineSchemaMap(),
    });
    // Drop `unitId`. Recompute the digest so we exercise schema-failure, not
    // digest-mismatch (covered separately below).
    const { unitId: _omit, ...tampered } = VALID_STATUS_UPDATE;
    const { bytes, digest } = encode(tampered);
    const verdict = registry.getValidator("status_update" as ContractId)(
      digest,
      bytes,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("unitId");
  });

  test("digest mismatch ⇒ fail", () => {
    const registry = anchoredChainBridge({
      agent: reportAgent,
      schemas: defaultMachineSchemaMap(),
    });
    const { bytes } = encode(VALID_STATUS_UPDATE);
    const wrongDigest = sha256Hex("not-the-bytes");
    const verdict = registry.getValidator("status_update" as ContractId)(
      wrongDigest,
      bytes,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/digest mismatch/);
  });

  test("in-scope deferred artifact (uow) ⇒ deferred-reason fail", () => {
    const registry = anchoredChainBridge({
      agent: reportAgent,
      schemas: defaultMachineSchemaMap(),
    });
    const validate = registry.getValidator("uow" as ContractId);
    // Digest/bytes can be anything; the deferred branch fires before any
    // inspection.
    const verdict = validate("sha256:0" as unknown as Digest);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/deferred/);
  });

  test("out-of-scope artifact ⇒ pass-through ok", () => {
    const registry = anchoredChainBridge({
      agent: reportAgent,
      schemas: defaultMachineSchemaMap(),
    });
    // `dispatch_request` is a live schema in the map, but it is not in
    // `report`'s input/output surface — bridges only opine on their agent.
    const validate = registry.getValidator("dispatch_request" as ContractId);
    expect(validate("sha256:deadbeef" as unknown as Digest)).toEqual({
      ok: true,
    });
  });

  test("blobLookup is used when bytes are not passed", () => {
    const { bytes, digest } = encode(VALID_STATUS_UPDATE);
    const store = new Map<string, Uint8Array>([[digest, bytes]]);
    const registry = anchoredChainBridge({
      agent: reportAgent,
      schemas: defaultMachineSchemaMap(),
      blobLookup: (d) => store.get(d),
    });
    const verdict = registry.getValidator("status_update" as ContractId)(digest);
    expect(verdict).toEqual({ ok: true });
  });

  // ── GH-2086: runtime_output + derive_transition validators ──────────────

  const VALID_RUNTIME_OUTPUT = {
    workUnitId: "GH-2086",
    role: "executor",
    phase: "ready_for_review",
    status: "implemented",
    parityChain: {
      authority: "issue",
      branch: "GH-2086",
      worktree: "/tmp/wt",
      pr: 2086,
    },
    modelBoundary: {
      workflowStates: [],
      actors: [],
      events: [],
      schemaBoundaries: [],
    },
    implementationPlan: ["step one"],
    changes: [{ path: "src/x.ts", summary: "edit" }],
    verification: {
      status: "passed",
      testsRan: ["bun test"],
      testsNotRun: [],
    },
  };

  const VALID_DERIVE_TRANSITION = {
    id: "t-1",
    issueId: "GH-2086",
    fromState: "draft",
    toState: "ready_for_review",
    actor: "executor_agent",
    timestamp: "2026-05-19T12:00:00Z",
  };

  // No shipped agent has `runtime_output` in its 1→1 surface, so build a
  // synthetic AgentContract that puts it in scope.
  const runtimeOutputAgent = agentContractSchema.parse({
    role: "executor",
    inputArtifact: "uow",
    outputArtifact: "runtime_output",
    capabilities: ["implement"],
    forbidden: [],
  });

  const deriveTransitionAgent = agentContractSchema.parse({
    role: "executor",
    inputArtifact: "uow",
    outputArtifact: "derive_transition",
    capabilities: ["implement"],
    forbidden: [],
  });

  test("runtime_output — valid bytes ⇒ ok", () => {
    const registry = anchoredChainBridge({
      agent: runtimeOutputAgent,
      schemas: defaultMachineSchemaMap(),
    });
    const { bytes, digest } = encode(VALID_RUNTIME_OUTPUT);
    const validate = registry.getValidator("runtime_output" as ContractId);
    expect(validate(digest, bytes)).toEqual({ ok: true });
  });

  test("runtime_output — tampered field ⇒ fail naming the field", () => {
    const registry = anchoredChainBridge({
      agent: runtimeOutputAgent,
      schemas: defaultMachineSchemaMap(),
    });
    const { verification: _omit, ...tampered } = VALID_RUNTIME_OUTPUT;
    const { bytes, digest } = encode(tampered);
    const verdict = registry.getValidator("runtime_output" as ContractId)(
      digest,
      bytes,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("verification");
  });

  test("derive_transition — valid bytes ⇒ ok", () => {
    const registry = anchoredChainBridge({
      agent: deriveTransitionAgent,
      schemas: defaultMachineSchemaMap(),
    });
    const { bytes, digest } = encode(VALID_DERIVE_TRANSITION);
    const validate = registry.getValidator("derive_transition" as ContractId);
    expect(validate(digest, bytes)).toEqual({ ok: true });
  });

  test("derive_transition — tampered field ⇒ fail naming the field", () => {
    const registry = anchoredChainBridge({
      agent: deriveTransitionAgent,
      schemas: defaultMachineSchemaMap(),
    });
    const { issueId: _omit, ...tampered } = VALID_DERIVE_TRANSITION;
    const { bytes, digest } = encode(tampered);
    const verdict = registry.getValidator("derive_transition" as ContractId)(
      digest,
      bytes,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("issueId");
  });

  test("drift pin: every live schema in defaultMachineSchemaMap matches its registry requiredFields", () => {
    // For each entry in the schema map whose registry validationRef is
    // `schema:...` (i.e. live), assert the Zod facade's top-level required
    // keys equal the artifact registry's requiredFields. Catches drift on
    // either side.
    const map = defaultMachineSchemaMap();

    const requiredKeysOf = (schema: z.ZodTypeAny): string[] => {
      // Unwrap ZodEffects (e.g. .refine()-wrapped ZodObject).
      let inner: z.ZodTypeAny = schema;
      const def = (s: z.ZodTypeAny): Record<string, unknown> =>
        s._def as unknown as Record<string, unknown>;
      while (def(inner).schema !== undefined) {
        inner = def(inner).schema as z.ZodTypeAny;
      }
      if (!(inner instanceof z.ZodObject)) {
        throw new Error(
          `expected ZodObject (or .refine()-wrapped) — got ${inner.constructor.name}`,
        );
      }
      // A field is required-in-output if a valid parse always produces it.
      // ZodOptional fields may be omitted; ZodDefault fields are filled in by
      // the schema, so they're required-in-output even though they're
      // input-optional. The registry tracks output shape.
      const isOptionalInOutput = (field: z.ZodTypeAny): boolean => {
        const typeName = (field._def as { typeName?: string }).typeName;
        return typeName === "ZodOptional";
      };
      const shape = inner.shape as Record<string, z.ZodTypeAny>;
      return Object.keys(shape)
        .filter((k) => !isOptionalInOutput(shape[k]!))
        .sort();
    };

    for (const [type, schema] of Object.entries(map)) {
      const contract = getArtifactContract(type);
      expect(contract, `artifact ${type} must be registered`).toBeDefined();
      if (!contract!.validationRef.startsWith("schema:")) continue;

      const zodRequired = requiredKeysOf(schema);
      const registryRequired = [...contract!.requiredFields].sort();
      expect(zodRequired, `drift for ${type}`).toEqual(registryRequired);
    }
  });

  test("bridge file imports from @bounded-systems/anchored-chain only via the public index", () => {
    const source = readFileSync(BRIDGE_FILE, "utf8");
    const importRe =
      /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\s+from\s+)?['"]([^'"]+)['"]/g;
    const externalSpecs: string[] = [];
    for (const match of source.matchAll(importRe)) {
      const spec = match[1]!;
      if (spec.startsWith(".") || spec.startsWith("/")) continue;
      externalSpecs.push(spec);
    }
    // No anchored-chain sub-module imports — extractability requires the
    // public index only.
    const anchoredChainImports = externalSpecs.filter((s) =>
      s.includes("anchored-chain"),
    );
    expect(anchoredChainImports.length).toBeGreaterThan(0);
    for (const spec of anchoredChainImports) {
      expect(spec).toBe("@bounded-systems/anchored-chain");
    }
  });
});
