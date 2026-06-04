// GH-1828 — Unit tests for the non-interactive Anthropic Agent SDK wrapper.
//
// Drives `runClaudeAgentNonInteractive` through an injected fake `query`
// adapter that emits synthetic SDKMessages, so the contract from spike §3.2
// (success / watchdog-cancel / operator-cancel / rate-limit / network /
// model) can be exercised deterministically without spawning the real CLI.

import { describe, expect, test } from "bun:test";

import {
  resolveBunDir,
  runClaudeAgentNonInteractive,
  type ClaudeAgentQuery,
} from "../../src/claude/agent_service.ts";
import type { RuntimeProfileProjection } from "../../src/machine/runtime_profiles.ts";
import {
  renderPlanArtifact,
  type PlanArtifact,
} from "../../src/plan-store/plan-artifact.ts";

function makeSdkProfile(): RuntimeProfileProjection {
  return {
    profile: "user",
    mode: "dev",
    command: "claude",
    args: ["--print"],
    agentRuntime: "sdk",
    sdkSpec: {
      prompt: "ping",
      model: "claude-haiku-4-5-20251001",
    },
    trustTiers: { tierA_controlled: [], tierB_partial: [], tierC_ambient: [] },
    sourcesOfTruth: {
      agents: "inline_prompt",
      mcp: "project-only",
      plugins: [],
      connectors: [],
    },
    allowedActors: ["llm_agent"],
    disallowedActors: [],
    notes: [],
  };
}

type FakeMessage = Record<string, unknown>;

/**
 * Build a fake `query()` that emits the supplied messages then completes.
 * The returned generator exposes `interrupt`/`close`/etc. as no-ops so the
 * subset the service uses (AsyncIterator + AbortController abort) is
 * satisfied without binding to the full SDK shape.
 */
function makeFakeQuery(
  messages: FakeMessage[],
  opts: { honorAbort?: boolean } = {},
): ClaudeAgentQuery {
  const honorAbort = opts.honorAbort ?? true;
  return (params) => {
    const signal = params.options?.abortController?.signal;
    async function* gen(): AsyncGenerator<FakeMessage, void> {
      for (const message of messages) {
        if (honorAbort && signal?.aborted) {
          // Mimic the real SDK: a throw aborts the iteration.
          const err = new Error("aborted");
          (err as { name: string }).name = "AbortError";
          throw err;
        }
        // Yield to the event loop so timers / abort handlers can fire
        // between messages.
        await Promise.resolve();
        yield message;
      }
    }
    const iter = gen();
    // Attach noop control-request methods so callers that downcast don't
    // crash. The service only uses the async-iterator protocol.
    return Object.assign(iter, {
      interrupt: async () => {},
      close: () => {},
    }) as unknown as ReturnType<ClaudeAgentQuery>;
  };
}

const assistantMessage = (text: string): FakeMessage => ({
  type: "assistant",
  message: { content: [{ type: "text", text }] },
  uuid: "u-1",
  session_id: "s-1",
});

const successResult = (text: string): FakeMessage => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: text,
  duration_ms: 100,
  duration_api_ms: 50,
  num_turns: 1,
  total_cost_usd: 0.001,
  usage: {
    input_tokens: 12,
    output_tokens: 7,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 3,
  },
  modelUsage: {},
  permission_denials: [],
  stop_reason: "end_turn",
  uuid: "u-r",
  session_id: "s-1",
});

const failureResult = (errors: string[], subtype: string): FakeMessage => ({
  type: "result",
  subtype,
  is_error: true,
  errors,
  duration_ms: 50,
  duration_api_ms: 25,
  num_turns: 1,
  total_cost_usd: 0,
  usage: {
    input_tokens: 1,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
  modelUsage: {},
  permission_denials: [],
  stop_reason: null,
  uuid: "u-r",
  session_id: "s-1",
});

describe("runClaudeAgentNonInteractive", () => {
  test("success path returns the assistant text and usage telemetry", async () => {
    const query = makeFakeQuery([
      assistantMessage("hello plan"),
      successResult("hello plan"),
    ]);
    const result = await runClaudeAgentNonInteractive(
      makeSdkProfile(),
      { cwd: "/tmp", disableAudit: true },
      { query },
    );
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    expect(result.text).toBe("hello plan");
    // Envelope wrapper is the `claude --print --output-format json` shape
    // so legacy parsers (parseClaudeJsonEnvelope) can read it unchanged.
    const env = JSON.parse(result.stdout) as { type: string; result: string };
    expect(env.type).toBe("result");
    expect(env.result).toBe("hello plan");
    expect(result.usage.input_tokens).toBe(12);
    expect(result.usage.output_tokens).toBe(7);
    expect(result.usage.cache_read_input_tokens).toBe(3);
    expect(result.totalCostUsd).toBe(0.001);
  });

  test("watchdog cancellation captures partial stdout into a draft slot", async () => {
    // Never yields the terminal result message — the abort timer fires and
    // we should see the accumulated text persist via the draftSink.
    const messages: FakeMessage[] = [
      assistantMessage("partial body so far"),
    ];
    // Make the generator hang after the first message so the watchdog has
    // something to interrupt.
    const query: ClaudeAgentQuery = (params) => {
      const signal = params.options?.abortController?.signal;
      async function* gen(): AsyncGenerator<FakeMessage, void> {
        yield messages[0]!;
        // Block until aborted.
        await new Promise<void>((resolve, reject) => {
          if (signal?.aborted) return reject(new Error("aborted"));
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      const iter = gen();
      return Object.assign(iter, { interrupt: async () => {}, close: () => {} }) as ReturnType<ClaudeAgentQuery>;
    };

    const captured: { value: string | null } = { value: null };
    const result = await runClaudeAgentNonInteractive(
      makeSdkProfile(),
      {
        cwd: "/tmp",
        timeoutMs: 50,
        disableAudit: true,
        draftSink: async (partial) => {
          captured.value = partial;
          return "GH-9999:plan@draft";
        },
      },
      { query },
    );

    expect(result.kind).toBe("cancelled");
    if (result.kind !== "cancelled") return;
    expect(result.reason).toBe("watchdog");
    expect(result.configured_timeout_ms).toBe(50);
    expect(result.partialStdout).toBe("partial body so far");
    expect(result.draftRef).toBe("GH-9999:plan@draft");
    expect(captured.value).toBe("partial body so far");
  });

  test("operator SIGINT cancellation reports reason='operator'", async () => {
    const controller = new AbortController();
    const query: ClaudeAgentQuery = (params) => {
      const signal = params.options?.abortController?.signal;
      async function* gen(): AsyncGenerator<FakeMessage, void> {
        await new Promise<void>((_, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      const iter = gen();
      return Object.assign(iter, { interrupt: async () => {}, close: () => {} }) as ReturnType<ClaudeAgentQuery>;
    };
    // Schedule the abort after the iterator starts.
    setTimeout(() => controller.abort(), 20);
    const result = await runClaudeAgentNonInteractive(
      makeSdkProfile(),
      {
        cwd: "/tmp",
        signal: controller.signal,
        disableAudit: true,
      },
      { query },
    );
    expect(result.kind).toBe("cancelled");
    if (result.kind !== "cancelled") return;
    expect(result.reason).toBe("operator");
    expect(result.configured_timeout_ms).toBeNull();
  });

  test("rate-limit error envelope maps to errorKind='rate_limit'", async () => {
    const query = makeFakeQuery([
      failureResult(["429 rate-limit hit (try again in 60s)"], "error_during_execution"),
    ]);
    const result = await runClaudeAgentNonInteractive(
      makeSdkProfile(),
      { cwd: "/tmp", disableAudit: true },
      { query },
    );
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.errorKind).toBe("rate_limit");
  });

  test("network error envelope maps to errorKind='network'", async () => {
    const query = makeFakeQuery([
      failureResult(["ECONNREFUSED while contacting api.anthropic.com"], "error_during_execution"),
    ]);
    const result = await runClaudeAgentNonInteractive(
      makeSdkProfile(),
      { cwd: "/tmp", disableAudit: true },
      { query },
    );
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.errorKind).toBe("network");
  });

  test("model error envelope (max_budget_usd) maps to errorKind='model'", async () => {
    const query = makeFakeQuery([
      failureResult(["budget exceeded"], "error_max_budget_usd"),
    ]);
    const result = await runClaudeAgentNonInteractive(
      makeSdkProfile(),
      { cwd: "/tmp", disableAudit: true },
      { query },
    );
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.errorKind).toBe("model");
  });

  test("missing terminal result message reports a typed model error", async () => {
    const query = makeFakeQuery([assistantMessage("plan body")]);
    const result = await runClaudeAgentNonInteractive(
      makeSdkProfile(),
      { cwd: "/tmp", disableAudit: true },
      { query },
    );
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.errorKind).toBe("model");
    expect(result.message).toContain("without emitting a terminal result");
  });

  test("refuses to dispatch a subprocess profile through the SDK service", async () => {
    const subprocessProfile: RuntimeProfileProjection = {
      ...makeSdkProfile(),
      agentRuntime: "subprocess",
      sdkSpec: undefined,
    };
    await expect(
      runClaudeAgentNonInteractive(subprocessProfile, { cwd: "/tmp", disableAudit: true }, { query: makeFakeQuery([]) }),
    ).rejects.toThrow(/not SDK-routed/);
  });

  // ── GH-1407 — cache-shaping seam (stable / dynamic split + --no-cache) ──

  test("split system prompt emits string[] with the SDK boundary marker", async () => {
    let capturedSystemPrompt: unknown = "(not captured)";
    const query: ClaudeAgentQuery = (params) => {
      capturedSystemPrompt = params.options?.systemPrompt;
      async function* gen(): AsyncGenerator<FakeMessage, void> {
        yield successResult("ok");
      }
      const iter = gen();
      return Object.assign(iter, { interrupt: async () => {}, close: () => {} }) as ReturnType<ClaudeAgentQuery>;
    };
    const profile: RuntimeProfileProjection = {
      ...makeSdkProfile(),
      sdkSpec: {
        prompt: "ping",
        systemPromptStable: ["stable prefix"],
        systemPromptDynamic: ["dynamic suffix"],
      },
    };
    await runClaudeAgentNonInteractive(
      profile,
      { cwd: "/tmp", disableAudit: true },
      { query },
    );
    expect(Array.isArray(capturedSystemPrompt)).toBe(true);
    const arr = capturedSystemPrompt as string[];
    // Stable comes first, then boundary marker, then dynamic.
    expect(arr[0]).toBe("stable prefix");
    expect(arr[arr.length - 1]).toBe("dynamic suffix");
    // The boundary marker must be present between them so the SDK keys the
    // cache on the stable prefix alone.
    expect(arr).toContain("__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__");
  });

  test("noCache prepends a nonce to the stable array without dropping stable content", async () => {
    let capturedSystemPrompt: unknown = "(not captured)";
    const query: ClaudeAgentQuery = (params) => {
      capturedSystemPrompt = params.options?.systemPrompt;
      async function* gen(): AsyncGenerator<FakeMessage, void> {
        yield successResult("ok");
      }
      const iter = gen();
      return Object.assign(iter, { interrupt: async () => {}, close: () => {} }) as ReturnType<ClaudeAgentQuery>;
    };
    const profile: RuntimeProfileProjection = {
      ...makeSdkProfile(),
      sdkSpec: {
        prompt: "ping",
        systemPromptStable: ["stable prefix"],
        systemPromptDynamic: ["dynamic suffix"],
      },
    };
    await runClaudeAgentNonInteractive(
      profile,
      { cwd: "/tmp", disableAudit: true, noCache: true },
      { query },
    );
    const arr = capturedSystemPrompt as string[];
    // First element is the nonce; stable content moves to position 1.
    expect(arr[0]).toMatch(/^cache-nonce: /);
    expect(arr[1]).toBe("stable prefix");
    expect(arr).toContain("__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__");
    expect(arr[arr.length - 1]).toBe("dynamic suffix");
  });

  test("noCache stamps cache_disabled on the started and usage audit rows", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const auditSink = {
      ensureDir: () => {},
      appendFn: (_path: string, line: string) => {
        captured.push(JSON.parse(line.trim()) as Record<string, unknown>);
      },
    };
    const query = makeFakeQuery([
      assistantMessage("ok"),
      successResult("ok"),
    ]);
    const profile: RuntimeProfileProjection = {
      ...makeSdkProfile(),
      sdkSpec: {
        prompt: "ping",
        systemPromptStable: ["stable"],
      },
    };
    await runClaudeAgentNonInteractive(
      profile,
      {
        cwd: "/tmp",
        noCache: true,
        auditSink,
      },
      { query },
    );
    const started = captured.find((r) => r.subkind === "started");
    const usage = captured.find((r) => r.subkind === "usage");
    expect(started?.cache_disabled).toBe(true);
    expect(usage?.cache_disabled).toBe(true);
  });

  test("warm path (no noCache) leaves cache_disabled off the audit rows", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const auditSink = {
      ensureDir: () => {},
      appendFn: (_path: string, line: string) => {
        captured.push(JSON.parse(line.trim()) as Record<string, unknown>);
      },
    };
    const query = makeFakeQuery([
      assistantMessage("ok"),
      successResult("ok"),
    ]);
    await runClaudeAgentNonInteractive(
      makeSdkProfile(),
      {
        cwd: "/tmp",
        auditSink,
      },
      { query },
    );
    expect(captured.length).toBeGreaterThan(0);
    for (const row of captured) {
      expect(row.cache_disabled).toBeUndefined();
    }
  });

  test("omitting both stable and dynamic prompts leaves Options.systemPrompt unset", async () => {
    let capturedOptions: unknown = "(not captured)";
    const query: ClaudeAgentQuery = (params) => {
      capturedOptions = params.options;
      async function* gen(): AsyncGenerator<FakeMessage, void> {
        yield successResult("ok");
      }
      const iter = gen();
      return Object.assign(iter, { interrupt: async () => {}, close: () => {} }) as ReturnType<ClaudeAgentQuery>;
    };
    await runClaudeAgentNonInteractive(
      makeSdkProfile(),
      { cwd: "/tmp", disableAudit: true },
      { query },
    );
    expect((capturedOptions as { systemPrompt?: unknown }).systemPrompt).toBeUndefined();
  });
});

// GH-2337 — the in-process `submit_plan` capture seam. When the profile opts
// in (capturePlanArtifact), agent_service injects a `prx-plan` SDK MCP server
// whose `submit_plan` tool input schema is PlanArtifactShape; the validated,
// rendered artifact becomes the success body instead of free-text stdout, and
// a successful run that never called submit_plan is a typed `failed`.
describe("submit_plan plan-artifact capture (GH-2337)", () => {
  const validArtifact: PlanArtifact = {
    problem: "Planner stdout is free text, so validatePlanShape fails post-hoc.",
    scope: "Capture the typed PlanArtifact via the submit_plan SDK tool.",
    approach: "Inject a prx-plan in-process MCP server at the IO boundary.",
    changes: ["src/claude/agent_service.ts: add the capture seam"],
    risks: ["test seam must reach the in-process handler without a transport"],
    acceptance: ["result.text equals renderPlanArtifact(captured)"],
  };

  function makeCapturingProfile(
    extra: Partial<RuntimeProfileProjection["sdkSpec"]> = {},
  ): RuntimeProfileProjection {
    const base = makeSdkProfile();
    return {
      ...base,
      sdkSpec: { ...base.sdkSpec, prompt: "plan it", capturePlanArtifact: true, ...extra },
    };
  }

  // The SDK Zod-validates submit_plan input against PlanArtifactShape *before*
  // the handler runs, so a transport-driven call is the enforcement point. The
  // handler is also referenced on the `mcpServers["prx-plan"]` entry so this
  // in-process test can invoke it directly without a live MCP transport.
  type CaptureEntry = {
    handler: (args: PlanArtifact, extra: unknown) => Promise<unknown>;
  };

  test("a submit_plan call captures the artifact as the rendered success body", async () => {
    const query: ClaudeAgentQuery = (params) => {
      const servers = params.options?.mcpServers as
        | Record<string, CaptureEntry>
        | undefined;
      async function* gen(): AsyncGenerator<FakeMessage, void> {
        const entry = servers?.["prx-plan"];
        if (entry?.handler) await entry.handler(validArtifact, {});
        yield successResult("free-text chat summary the model emitted");
      }
      const iter = gen();
      return Object.assign(iter, { interrupt: async () => {}, close: () => {} }) as ReturnType<ClaudeAgentQuery>;
    };
    const result = await runClaudeAgentNonInteractive(
      makeCapturingProfile(),
      { cwd: "/tmp", disableAudit: true },
      { query },
    );
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    const rendered = renderPlanArtifact(validArtifact);
    expect(result.text).toBe(rendered);
    // The free-text result is discarded in favor of the rendered artifact.
    expect(result.text).not.toContain("free-text chat summary");
    // The envelope body wraps the rendered markdown, not the model's stdout.
    const env = JSON.parse(result.stdout) as { result: string };
    expect(env.result).toBe(rendered);
  });

  test("a successful run that never calls submit_plan is a typed model failure", async () => {
    const query = makeFakeQuery([successResult("just a chat reply, no tool call")]);
    const result = await runClaudeAgentNonInteractive(
      makeCapturingProfile(),
      { cwd: "/tmp", disableAudit: true },
      { query },
    );
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.errorKind).toBe("model");
    expect(result.message).toContain("submit_plan");
  });

  test("injects the prx-plan server and appends (not clobbers) allowedTools", async () => {
    let capturedOptions: unknown = "(not captured)";
    const query: ClaudeAgentQuery = (params) => {
      capturedOptions = params.options;
      const servers = params.options?.mcpServers as unknown as Record<string, CaptureEntry>;
      async function* gen(): AsyncGenerator<FakeMessage, void> {
        await servers["prx-plan"]!.handler(validArtifact, {});
        yield successResult("ok");
      }
      const iter = gen();
      return Object.assign(iter, { interrupt: async () => {}, close: () => {} }) as ReturnType<ClaudeAgentQuery>;
    };
    await runClaudeAgentNonInteractive(
      makeCapturingProfile({ allowedTools: ["Read", "Grep"] }),
      { cwd: "/tmp", disableAudit: true },
      { query },
    );
    const opts = capturedOptions as {
      mcpServers?: Record<string, unknown>;
      allowedTools?: string[];
    };
    expect(opts.mcpServers?.["prx-plan"]).toBeDefined();
    expect(opts.allowedTools).toContain("mcp__prx-plan__submit_plan");
    // Spec-declared tools survive the append.
    expect(opts.allowedTools).toContain("Read");
    expect(opts.allowedTools).toContain("Grep");
  });

  test("flag off: success returns the model result and adds no prx-plan server", async () => {
    let capturedOptions: unknown = "(not captured)";
    const query: ClaudeAgentQuery = (params) => {
      capturedOptions = params.options;
      async function* gen(): AsyncGenerator<FakeMessage, void> {
        yield successResult("plain model reply");
      }
      const iter = gen();
      return Object.assign(iter, { interrupt: async () => {}, close: () => {} }) as ReturnType<ClaudeAgentQuery>;
    };
    const result = await runClaudeAgentNonInteractive(
      makeSdkProfile(),
      { cwd: "/tmp", disableAudit: true },
      { query },
    );
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    expect(result.text).toBe("plain model reply");
    const opts = capturedOptions as { mcpServers?: Record<string, unknown> };
    expect(opts.mcpServers?.["prx-plan"]).toBeUndefined();
  });
});

// GH-2137 — the SDK resolves its native `claude` CLI via
// createRequire(import.meta.url), which fails in a `bun build --compile`
// artifact (no adjacent node_modules/). buildSdkOptions resolves an explicit
// `pathToClaudeCodeExecutable` from a 3-tier source guarded by existsSync.
describe("buildSdkOptions — pathToClaudeCodeExecutable (GH-2137)", () => {
  // Capture the options the service hands the SDK without running the CLI.
  function captureSdkOptions(): {
    query: ClaudeAgentQuery;
    get: () => { pathToClaudeCodeExecutable?: unknown };
  } {
    let captured: { pathToClaudeCodeExecutable?: unknown } = {};
    const query: ClaudeAgentQuery = (params) => {
      captured = params.options as { pathToClaudeCodeExecutable?: unknown };
      async function* gen(): AsyncGenerator<FakeMessage, void> {
        yield successResult("ok");
      }
      const iter = gen();
      return Object.assign(iter, { interrupt: async () => {}, close: () => {} }) as ReturnType<ClaudeAgentQuery>;
    };
    return { query, get: () => captured };
  }

  // Snapshot + restore the two env knobs so tests do not leak into each other.
  function withEnv(
    overrides: { prx?: string | undefined; baked?: string | undefined },
    fn: () => Promise<void>,
  ): Promise<void> {
    const prev = {
      prx: process.env.PRX_CLAUDE_CODE_PATH,
      baked: process.env.BAKED_CLAUDE_CODE_PATH,
    };
    const apply = (key: "PRX_CLAUDE_CODE_PATH" | "BAKED_CLAUDE_CODE_PATH", v: string | undefined) => {
      if (v === undefined) delete process.env[key];
      else process.env[key] = v;
    };
    apply("PRX_CLAUDE_CODE_PATH", overrides.prx);
    apply("BAKED_CLAUDE_CODE_PATH", overrides.baked);
    return fn().finally(() => {
      apply("PRX_CLAUDE_CODE_PATH", prev.prx);
      apply("BAKED_CLAUDE_CODE_PATH", prev.baked);
    });
  }

  // An existing file: the bun executable always resolves.
  const existingPath = process.execPath;
  const missingPath = "/nonexistent/prx-2137/claude";

  test("PRX_CLAUDE_CODE_PATH (existing) sets pathToClaudeCodeExecutable", async () => {
    const cap = captureSdkOptions();
    await withEnv({ prx: existingPath, baked: undefined }, async () => {
      await runClaudeAgentNonInteractive(
        makeSdkProfile(),
        { cwd: "/tmp", disableAudit: true },
        { query: cap.query },
      );
    });
    expect(cap.get().pathToClaudeCodeExecutable).toBe(existingPath);
  });

  test("BAKED_CLAUDE_CODE_PATH used when PRX override absent", async () => {
    const cap = captureSdkOptions();
    await withEnv({ prx: undefined, baked: existingPath }, async () => {
      await runClaudeAgentNonInteractive(
        makeSdkProfile(),
        { cwd: "/tmp", disableAudit: true },
        { query: cap.query },
      );
    });
    expect(cap.get().pathToClaudeCodeExecutable).toBe(existingPath);
  });

  test("PRX override wins over BAKED", async () => {
    const cap = captureSdkOptions();
    await withEnv({ prx: existingPath, baked: missingPath }, async () => {
      await runClaudeAgentNonInteractive(
        makeSdkProfile(),
        { cwd: "/tmp", disableAudit: true },
        { query: cap.query },
      );
    });
    expect(cap.get().pathToClaudeCodeExecutable).toBe(existingPath);
  });

  test("a non-existent resolved path is never used (prx-5el: falls through, or unset)", async () => {
    const cap = captureSdkOptions();
    await withEnv({ prx: missingPath, baked: missingPath }, async () => {
      await runClaudeAgentNonInteractive(
        makeSdkProfile(),
        { cwd: "/tmp", disableAudit: true },
        { query: cap.query },
      );
    });
    // prx-5el: a dead path must never reach the SDK. With both override tiers
    // dead, the resolver either falls through to a real ~/.local/bin/claude (if
    // present) or leaves the field unset for SDK self-resolution — but it must
    // NEVER pass the missing path (the old `??`-chain bug that broke releases).
    expect(cap.get().pathToClaudeCodeExecutable).not.toBe(missingPath);
  });
});

describe("resolveBunDir — bun on the headless session PATH (prx-pe1 slice 3)", () => {
  test("PRX_BUN_DIR wins when it holds a bun executable", () => {
    const dir = resolveBunDir(
      ["/opt/bun-home/bin", "/home/u/.bun/bin"],
      (p) => p === "/opt/bun-home/bin/bun",
    );
    expect(dir).toBe("/opt/bun-home/bin");
  });

  test("falls through to the next candidate that actually holds bun", () => {
    const dir = resolveBunDir(
      [undefined, "/missing/bin", "/home/u/.bun/bin"],
      (p) => p === "/home/u/.bun/bin/bun",
    );
    expect(dir).toBe("/home/u/.bun/bin");
  });

  test("returns undefined when no candidate holds bun (→ inherited PATH unchanged)", () => {
    const dir = resolveBunDir(["/a/bin", "/b/bin"], () => false);
    expect(dir).toBeUndefined();
  });
});
