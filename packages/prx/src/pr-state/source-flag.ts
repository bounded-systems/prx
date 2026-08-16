// GH-1421 — shared `--source <name>` flag parser for session-entry verbs
// (`prx plan session`, `prx session open`). Identifies the prx.toml
// `[sources.<name>]` registry entry to use for canonical-id dispatch.
//
// Accepted forms (mirror parseRepoFlag's discipline):
//
//   --source <name>     two tokens
//   --source=<name>     single token (equals form)
//
// Returns `source` (the parsed value, or `undefined` if absent) and
// `remainder` (the argv with the flag tokens removed; positional order is
// preserved). String parsing only — registry lookup is the caller's job.

export function parseSourceFlag(argv: readonly string[]): {
  source?: string;
  remainder: string[];
} {
  const remainder: string[] = [];
  let source: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok === "--source") {
      const next = argv[i + 1];
      if (typeof next === "string" && next.length > 0) {
        source = next;
        i += 1;
        continue;
      }
      remainder.push(tok);
      continue;
    }
    if (tok.startsWith("--source=")) {
      const value = tok.slice("--source=".length);
      if (value.length > 0) {
        source = value;
        continue;
      }
      remainder.push(tok);
      continue;
    }
    remainder.push(tok);
  }

  return source !== undefined ? { source, remainder } : { remainder };
}
