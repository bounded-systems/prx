/**
 * Bridge: the real `prx` CLI (`pr-state/cli.ts`) → the spec-driven verbs
 * (`verb-registry.ts`). The cli.ts execute handler delegates here for any verb
 * authored as a `VerbSpec`, running it through the canonical dispatch so the
 * command, its MCP tool, its OpenAPI op, and its plugin slash-command stay one
 * registry. Started with `pilot`/`fleet`; grows as scripts migrate (`health`, …).
 *
 * EXPERIMENTAL (pilot/fleet): without `PRX_PILOT_REAL` the pilot runs its stub (a
 * fast demo that prints a synthetic `merged`); the real path (headless subagents
 * + signed provenance + the dolt-backed pipeline) needs `PRX_PILOT_REAL=1` + a
 * live unit.
 */

import { ZodError } from "zod";

import { dispatch, render } from "./verbspec.ts";
import { verbRegistry } from "./verb-registry.ts";

export async function runSpecVerb(
  verb: string,
  args: readonly string[],
  output: { log: (line: string) => void; error: (line: string) => void; writeRaw?: (buf: Buffer) => void },
): Promise<number> {
  try {
    const res = await dispatch(verbRegistry, [verb, ...args]);
    if (res.kind === "help") {
      output.log(res.text);
      return 0;
    }
    // A verb may carry a CLI `render` (human view); otherwise print JSON.
    const v = verbRegistry[res.id];
    // Stderr warnings/notes first (the stdout result follows), mirroring the
    // legacy handlers that interleaved output.error + output.log.
    if (v?.warnings) {
      for (const line of v.warnings(res.output as never, res.input as never)) output.error(line);
    }
    // Raw/binary stdout (e.g. `plan load --format=raw`): exact bytes, no
    // trailing newline. Takes precedence over `render` when it yields a Buffer.
    const raw = v?.renderRaw ? v.renderRaw(res.output as never, res.input as never) : null;
    if (raw !== null) {
      if (output.writeRaw) output.writeRaw(raw);
      else process.stdout.write(raw);
    } else {
      output.log(
        v?.render ? v.render(res.output as never, res.input as never) : render(res.output),
      );
    }
    // A verb may map its (successful) output to a non-zero exit code; default 0.
    return v?.exitCode ? v.exitCode(res.output as never, res.input as never) : 0;
  } catch (e) {
    // A Zod validation failure (bad/missing arg) → surface the first issue's
    // message, not the multi-issue JSON dump, matching the legacy CliError UX.
    if (e instanceof ZodError) {
      output.error(e.issues[0]?.message ?? e.message);
      return 1;
    }
    // Mirror the legacy dispatcher's friendly ENOENT handling so contract-reading
    // verbs (status, open-mode, …) surface the same "run `prx contract init`"
    // guidance instead of a raw node error.
    const err = e as { code?: string; path?: unknown };
    if (
      err?.code === "ENOENT" &&
      typeof err.path === "string" &&
      err.path.endsWith(".pr/local/pr.json")
    ) {
      output.error(`Missing PR contract at ${err.path}`);
      output.error(
        "Run `prx contract init` to create one, pass --contract, or use `prx overview` for a GitHub-only view.",
      );
      return 1;
    }
    output.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}
