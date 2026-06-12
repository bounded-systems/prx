// `prx contract` (a.k.a. `contract show`) as a spec-driven VerbSpec migrated off
// cli.ts (ADR docs/prx/cli-decomposition.md). Two faces:
//   • GH-1821 contract-trinity read — `--list` enumerates the AgentContract /
//     ArtifactContract / TransitionContract registries (all kinds, or one via
//     `--kind`); a positional id selects a single entry.
//   • no `--kind`/`--list` ⇒ the legacy pr.json skill-event apply for the fixed
//     `pr-contract` skill (shared `applySkillEvent`, no transition-log entry).
// `contract init` and the migrated `contract <status|transition|…>` aliases are
// routed away before this verb in the early dispatch.

import { z } from "zod";

import { defineVerb } from "@bounded-systems/verbspec";
import { applySkillEvent, type SkillEventPayload } from "./event-verb.ts";
import {
  getAgentContract,
  listAgentContracts,
} from "../machine/contracts/instances.ts";
import {
  getArtifactContract,
  listArtifactContracts,
} from "../machine/contracts/artifacts.ts";
import {
  getTransitionContract,
  listTransitionContracts,
  transitionKey,
} from "../machine/contracts/transitions.ts";

type ContractOutput =
  | { mode: "list-all"; agents: string[]; artifacts: string[]; transitions: string[] }
  | { mode: "list-kind"; entries: readonly unknown[]; names: string[] }
  | { mode: "entry"; kind: string; id: string; entry: unknown }
  | { mode: "event"; payload: SkillEventPayload };

const ContractOutputSchema = z
  .object({ mode: z.enum(["list-all", "list-kind", "entry", "event"]) })
  .loose();

export const contractVerb = defineVerb({
  id: "contract",
  summary: "Read the contract trinity (--list / --kind / id), or apply the pr-contract skill event.",
  actor: "work",
  positionals: ["id"],
  input: z.object({
    contract: z.string().default(".pr/local/pr.json").describe("path to the pr contract (apply path)"),
    actor: z.string().default("codex").describe("actor recording the event (apply path)"),
    reason: z.string().optional().describe("reason recorded with the event (apply path)"),
    format: z.enum(["plain", "json"]).default("plain").describe("output format"),
    // GH-1821 contract-trinity flags.
    kind: z.enum(["agent", "artifact", "transition"]).optional().describe("registry to read"),
    list: z.coerce.boolean().default(false).describe("enumerate the registry"),
    id: z.string().optional().describe("role / artifact-type / transition-key to inspect"),
  }),
  output: ContractOutputSchema,
  run: (input): ContractOutput => {
    // No trinity flags ⇒ the legacy pr.json skill-event apply (pr-contract).
    if (input.kind === undefined && !input.list) {
      const payload = applySkillEvent(
        { contract: input.contract, skill: "pr-contract", actor: input.actor, reason: input.reason, log: "" },
        { logTransition: false },
      );
      return { mode: "event", payload };
    }

    if (input.list && input.kind === undefined) {
      return {
        mode: "list-all",
        agents: listAgentContracts().map((c) => c.role),
        artifacts: listArtifactContracts().map((c) => c.type),
        transitions: listTransitionContracts().map((c) => transitionKey(c)),
      };
    }

    if (input.kind === "agent") {
      if (input.list) {
        const entries = listAgentContracts();
        return { mode: "list-kind", entries, names: entries.map((e) => e.role) };
      }
      if (!input.id) throw new Error("FAIL: prx contract show --kind=agent requires a role (e.g. executor)");
      const entry = getAgentContract(input.id);
      if (!entry) throw new Error(`FAIL: no agent contract registered for role ${input.id}`);
      return { mode: "entry", kind: "agent", id: input.id, entry };
    }

    if (input.kind === "artifact") {
      if (input.list) {
        const entries = listArtifactContracts();
        return { mode: "list-kind", entries, names: entries.map((e) => e.type) };
      }
      if (!input.id) throw new Error("FAIL: prx contract show --kind=artifact requires a type (e.g. test_run)");
      const entry = getArtifactContract(input.id);
      if (!entry) throw new Error(`FAIL: no artifact contract registered for type ${input.id}`);
      return { mode: "entry", kind: "artifact", id: input.id, entry };
    }

    // kind === "transition"
    if (input.list) {
      const entries = listTransitionContracts();
      return { mode: "list-kind", entries, names: entries.map((e) => transitionKey(e)) };
    }
    if (!input.id) {
      throw new Error("FAIL: prx contract show --kind=transition requires a key (e.g. role:testing->reviewing)");
    }
    const entry = getTransitionContract(input.id);
    if (!entry) throw new Error(`FAIL: no transition contract registered for key ${input.id}`);
    return { mode: "entry", kind: "transition", id: input.id, entry };
  },
  render: (out, input) => {
    const o = out as ContractOutput;
    const json = input.format === "json";
    switch (o.mode) {
      case "list-all":
        return json
          ? JSON.stringify({ agents: o.agents, artifacts: o.artifacts, transitions: o.transitions }, null, 2)
          : [
              "agents:",
              ...o.agents.map((r) => `  - ${r}`),
              "artifacts:",
              ...o.artifacts.map((t) => `  - ${t}`),
              "transitions:",
              ...o.transitions.map((k) => `  - ${k}`),
            ].join("\n");
      case "list-kind":
        return json ? JSON.stringify(o.entries, null, 2) : o.names.join("\n");
      case "entry":
        return json
          ? JSON.stringify({ kind: o.kind, id: o.id, entry: o.entry }, null, 2)
          : `# ${o.kind} ${o.id}\n${JSON.stringify(o.entry, null, 2)}`;
      case "event":
        return json
          ? JSON.stringify(o.payload, null, 2)
          : `${o.payload.state} (${o.payload.mode}) - ${o.payload.event} via ${o.payload.skill}`;
    }
  },
});
