import { describe, expect, test } from "bun:test";

import {
  dispatch,
  toAnthropicTool,
  toHelp,
  toMcpToolset,
  toMcpTool,
  toOpenApiPaths,
  parseArgs,
  render,
} from "@bounded-systems/verbspec";
import { fleetVerb, orchestratorRegistry, pilotVerb } from "./pilot-verbs.ts";

describe("spec-driven CLI: author once, project everywhere", () => {
  test("CLI projection: argv parses + validates against the Zod input", () => {
    const parsed = parseArgs(pilotVerb, ["GH-5", "--retreatBudget", "2"]);
    expect(parsed).toEqual({ workUnitId: "GH-5", retreatBudget: 2 }); // coerced to number

    // Comma-split for array fields lives in the parser, not the schema.
    expect(parseArgs(fleetVerb, ["a,b,c", "--wip", "2"])).toEqual({
      units: ["a", "b", "c"],
      wip: 2,
    });

    // Validation is the Zod schema — a missing required positional throws.
    expect(() => parseArgs(pilotVerb, [])).toThrow();
  });

  test("MCP projection: tool name/description/inputSchema come from the spec", () => {
    const tool = toMcpTool(pilotVerb);
    expect(tool.name).toBe("pilot");
    expect(tool.description).toContain("ONE work unit");
    const props = tool.inputSchema as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(props.properties)).toEqual(["workUnitId", "retreatBudget"]);
    expect(props.required).toContain("workUnitId");
  });

  test("Anthropic tool + OpenAPI derive from the SAME schema (no drift)", () => {
    const anthropic = toAnthropicTool(pilotVerb);
    expect(anthropic.input_schema).toEqual(toMcpTool(pilotVerb).inputSchema);

    const paths = toOpenApiPaths(orchestratorRegistry) as Record<
      string,
      { post: { operationId: string } }
    >;
    expect(paths["/pilot"]!.post.operationId).toBe("pilot");
    expect(paths["/fleet"]!.post.operationId).toBe("fleet");
    // The toolset projects every verb.
    expect(
      toMcpToolset(orchestratorRegistry)
        .map((t) => t.name)
        .sort(),
    ).toEqual(["fleet", "observe", "pilot"]);
  });

  test("help renders usage + flags from the schema", () => {
    const help = toHelp(pilotVerb);
    expect(help).toContain("prx pilot <workUnitId>");
    expect(help).toContain("--retreatBudget");
    expect(help).toContain("failure-retreats allowed");
  });

  test("router: `prx pilot GH-7` actually drives the pilot machine to merged", async () => {
    const res = await dispatch(orchestratorRegistry, ["pilot", "GH-7"]);
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") throw new Error("expected ok");
    expect(res.output).toMatchObject({ workUnitId: "GH-7", finalState: "merged", legCount: 8 });
    expect((res.output as { summarySignedBy: string }).summarySignedBy).toBe("pilot@stub");
    expect(render(res.output)).toContain("merged");
  });

  test("router: `prx fleet a,b,c --wip 2` drives the fleet", async () => {
    const res = await dispatch(orchestratorRegistry, ["fleet", "a,b,c", "--wip", "2"]);
    if (res.kind !== "ok") throw new Error("expected ok");
    expect(res.output).toMatchObject({ unitCount: 3, merged: 3 });
    expect((res.output as { batchSignedBy: string }).batchSignedBy).toBe("fleet@stub");
  });

  test("router: --help short-circuits; unknown verb throws", async () => {
    const help = await dispatch(orchestratorRegistry, ["fleet", "--help"]);
    expect(help.kind).toBe("help");
    if (help.kind === "help") expect(help.text).toContain("prx fleet");

    let threw = "";
    try {
      await dispatch(orchestratorRegistry, ["nope"]);
    } catch (e) {
      threw = String(e);
    }
    expect(threw).toContain("unknown verb");
  });
});
