#!/usr/bin/env bun
/**
 * GH-1961 — CLI wiring that composes `GhPrFetcher` with
 * `openAnchoredChain` and runs the parity-chain example
 * three times to exercise the three exit-criterion behaviors:
 *
 *   1. First fetch advances `pr/<unit>` and appends a derivation.
 *   2. Second fetch with the same payload is a cache hit (no ref
 *      advance, no derivation appended).
 *   3. Third fetch with a fresher payload appends a new derivation
 *      and `invalidateDescendants` returns the prior derivation id.
 *
 * Default `--fixture` mode wires a stubbed `CommandRunner` returning
 * recorded `gh pr view` JSON so the script is deterministic and
 * CI-safe. `--live --unit <id>` re-routes through the real `gh` CLI
 * for an operator smoke test.
 *
 * This module composes (`Fetcher` + parity-chain example +
 * `AnchoredChainStore`) on purpose — `src/anchored-chain/__examples__/`
 * is implementation-agnostic, and a separate file is the boundary
 * where pr-state and parity-chain meet.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { defaultRunner, type CommandRunner } from "@bounded-systems/proc";

import {
  digestManifest,
  openAnchoredChain,
  sha256Hex,
  runPrEndToEnd,
  type Derivation,
  type Digest,
  type AnchoredChainStore,
} from "@bounded-systems/anchored-chain-sqlite";

import { createGhPrFetcher, prSurfaceRef } from "./gh-pr-fetcher.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_BEFORE = resolve(HERE, "__fixtures__/gh-pr-1961-before.json");
const FIXTURE_AFTER = resolve(HERE, "__fixtures__/gh-pr-1961-after.json");

interface CliArgs {
  readonly mode: "fixture" | "live";
  readonly unit: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let mode: CliArgs["mode"] = "fixture";
  let unit = "GH-1961";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--live") {
      mode = "live";
    } else if (arg === "--fixture") {
      mode = "fixture";
    } else if (arg === "--unit") {
      const next = argv[i + 1];
      if (!next) throw new Error("--unit requires a value");
      unit = next;
      i += 1;
    }
  }
  return { mode, unit };
}

/**
 * Three-call scripted runner: the first two calls return the
 * "before" fixture so the second fetch is a cache hit; the third
 * call returns the "after" fixture so we exercise invalidation.
 */
export function createFixtureRunner(): CommandRunner {
  const before = readFileSync(FIXTURE_BEFORE, "utf8");
  const after = readFileSync(FIXTURE_AFTER, "utf8");
  let calls = 0;
  return () => {
    calls += 1;
    const stdout = calls <= 2 ? before : after;
    return { stdout, stderr: "", status: 0 };
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runner: CommandRunner =
    args.mode === "fixture" ? createFixtureRunner() : defaultRunner;
  const fetcher = createGhPrFetcher({ runner });
  const surface = prSurfaceRef(args.unit);

  const store: AnchoredChainStore = openAnchoredChain(":memory:");
  try {
    const firstFetch = await runPrEndToEnd({
      store,
      fetcher,
      surface,
      now: 1,
    });
    // Seed a synthetic downstream derivation that consumes pr/<unit> as
    // input so the third fetch's `invalidateDescendants` walk surfaces a
    // hit — exit-criterion-2 wants the example to *demonstrate*
    // invalidation, not just trust that the walk works.
    const downstreamManifest: Derivation["manifest"] = {
      producer: "validator:demo-downstream",
      inputs: { pr: firstFetch.refDigest },
      outputs: { verdict: sha256Hex(`downstream:${surface.name}`) as Digest },
      contracts: [],
      params: { refName: surface.name },
    };
    await store.derivations.append({
      derivationId: digestManifest(downstreamManifest),
      manifest: downstreamManifest,
      ts: 1,
    });

    const secondFetch = await runPrEndToEnd({
      store,
      fetcher,
      surface,
      now: 2,
    });
    const thirdFetch = await runPrEndToEnd({
      store,
      fetcher,
      surface,
      now: 3,
    });
    const summary = {
      mode: args.mode,
      surface: surface.name,
      firstFetch,
      secondFetch,
      thirdFetch,
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } finally {
    store.close();
  }
}

if (import.meta.main) {
  await main();
}
