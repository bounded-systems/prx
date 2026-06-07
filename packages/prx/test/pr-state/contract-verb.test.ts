// GH-1821 contract-trinity read — drives every arm of the `prx contract`
// VerbSpec (contract-verb.ts) against the real Agent/Artifact/Transition
// registries: list-all, per-kind list, single-entry lookups, the not-found and
// missing-id refusals, and both plain/json render faces. The legacy pr.json
// skill-event apply path is covered by event-verb.test.ts; here we exercise the
// pure registry-read surface, which needs no IO deps.

import { describe, expect, test } from "bun:test";

import { contractVerb } from "../../src/pr-state/contract-verb.ts";
import {
  listAgentContracts,
} from "../../src/machine/contracts/instances.ts";
import {
  listArtifactContracts,
} from "../../src/machine/contracts/artifacts.ts";
import {
  listTransitionContracts,
  transitionKey,
} from "../../src/machine/contracts/transitions.ts";

type ContractInput = Parameters<typeof contractVerb.run>[0];

// The verb is synchronous, but `defineVerb` types `run`'s return as
// `T | Promise<T>`. Narrow it locally so the union arms are reachable.
type ContractOut =
  | { mode: "list-all"; agents: string[]; artifacts: string[]; transitions: string[] }
  | { mode: "list-kind"; entries: readonly unknown[]; names: string[] }
  | { mode: "entry"; kind: string; id: string; entry: unknown }
  | { mode: "event"; payload: unknown };

// Build a fully-defaulted input object (mirrors what parseArgs would produce)
// so each test only spells out the flags it cares about.
function input(overrides: Partial<Record<string, unknown>>): ContractInput {
  return {
    contract: ".pr/local/pr.json",
    actor: "codex",
    reason: undefined,
    format: "plain",
    kind: undefined,
    list: false,
    id: undefined,
    ...overrides,
  } as ContractInput;
}

const run = (overrides: Partial<Record<string, unknown>>) =>
  contractVerb.run(input(overrides)) as unknown as ContractOut;
const render = (out: unknown, fmt: "plain" | "json") =>
  contractVerb.render!(out as never, input({ format: fmt }));

const firstAgent = listAgentContracts()[0]!.role;
const firstArtifact = listArtifactContracts()[0]!.type;
const firstTransition = transitionKey(listTransitionContracts()[0]!);

describe("prx contract — trinity read (GH-1821)", () => {
  test("--list with no --kind enumerates all three registries", () => {
    const out = run({ list: true });
    expect(out.mode).toBe("list-all");
    if (out.mode !== "list-all") throw new Error("unreachable");
    expect(out.agents).toContain(firstAgent);
    expect(out.artifacts).toContain(firstArtifact);
    expect(out.transitions).toContain(firstTransition);

    const plain = render(out, "plain");
    expect(plain).toContain("agents:");
    expect(plain).toContain(`  - ${firstAgent}`);
    expect(plain).toContain("transitions:");
    const json = JSON.parse(render(out, "json"));
    expect(json.agents).toEqual(out.agents);
  });

  test("--kind=agent --list enumerates agent roles", () => {
    const out = run({ kind: "agent", list: true });
    expect(out.mode).toBe("list-kind");
    if (out.mode !== "list-kind") throw new Error("unreachable");
    expect(out.names).toContain(firstAgent);
    expect(out.entries.length).toBe(out.names.length);
    expect(render(out, "plain")).toContain(firstAgent);
    expect(JSON.parse(render(out, "json"))).toHaveLength(out.entries.length);
  });

  test("--kind=artifact --list enumerates artifact types", () => {
    const out = run({ kind: "artifact", list: true });
    if (out.mode !== "list-kind") throw new Error("unreachable");
    expect(out.names).toContain(firstArtifact);
  });

  test("--kind=transition --list enumerates transition keys", () => {
    const out = run({ kind: "transition", list: true });
    if (out.mode !== "list-kind") throw new Error("unreachable");
    expect(out.names).toContain(firstTransition);
  });

  test("--kind=agent <role> returns a single entry (plain + json render)", () => {
    const out = run({ kind: "agent", id: firstAgent });
    expect(out.mode).toBe("entry");
    if (out.mode !== "entry") throw new Error("unreachable");
    expect(out.kind).toBe("agent");
    expect(out.id).toBe(firstAgent);
    expect(out.entry).toBeDefined();
    expect(render(out, "plain")).toContain(`# agent ${firstAgent}`);
    expect(JSON.parse(render(out, "json")).id).toBe(firstAgent);
  });

  test("--kind=artifact <type> returns a single entry", () => {
    const out = run({ kind: "artifact", id: firstArtifact });
    if (out.mode !== "entry") throw new Error("unreachable");
    expect(out.kind).toBe("artifact");
    expect(out.id).toBe(firstArtifact);
  });

  test("--kind=transition <key> returns a single entry", () => {
    const out = run({ kind: "transition", id: firstTransition });
    if (out.mode !== "entry") throw new Error("unreachable");
    expect(out.kind).toBe("transition");
    expect(out.id).toBe(firstTransition);
  });

  test("--kind=agent with no id refuses", () => {
    expect(() => run({ kind: "agent" })).toThrow(/requires a role/);
  });

  test("--kind=artifact with no id refuses", () => {
    expect(() => run({ kind: "artifact" })).toThrow(/requires a type/);
  });

  test("--kind=transition with no id refuses", () => {
    expect(() => run({ kind: "transition" })).toThrow(/requires a key/);
  });

  test("--kind=agent with an unknown role refuses", () => {
    expect(() => run({ kind: "agent", id: "no-such-role" })).toThrow(
      /no agent contract registered/,
    );
  });

  test("--kind=artifact with an unknown type refuses", () => {
    expect(() => run({ kind: "artifact", id: "no-such-type" })).toThrow(
      /no artifact contract registered/,
    );
  });

  test("--kind=transition with an unknown key refuses", () => {
    expect(() => run({ kind: "transition", id: "no:such->key" })).toThrow(
      /no transition contract registered/,
    );
  });
});
