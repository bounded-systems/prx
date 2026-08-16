// GH-1661 — shared `--repo <name>` flag parser for `binding: "work-unit"`
// CLI verbs. Strips the flag tokens from argv so each verb's existing
// positional parser doesn't need a per-call change.
//
// Accepted forms (mirror the GH-977 alias-rule discipline of one shape per
// rule, no clever parsing):
//
//   --repo <name>     two tokens
//   --repo=<name>     single token (equals form)
//
// `<name>` is matched against the inventory by the consumer (typically via
// `findRepoBySlug`) — this helper only does string parsing.
//
// Returns `repo` (the parsed value, or `undefined` if absent) and
// `remainder` (the argv with the flag tokens removed; positional order is
// preserved).

export function parseRepoFlag(argv: readonly string[]): {
  repo?: string;
  remainder: string[];
} {
  const remainder: string[] = [];
  let repo: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok === "--repo") {
      const next = argv[i + 1];
      if (typeof next === "string" && next.length > 0) {
        repo = next;
        i += 1;
        continue;
      }
      // `--repo` with no value: leave it in remainder so the verb's own
      // parser can decide how to error. This keeps the helper pure and
      // off the error-formatting path.
      remainder.push(tok);
      continue;
    }
    if (tok.startsWith("--repo=")) {
      const value = tok.slice("--repo=".length);
      if (value.length > 0) {
        repo = value;
        continue;
      }
      remainder.push(tok);
      continue;
    }
    remainder.push(tok);
  }

  return repo !== undefined ? { repo, remainder } : { remainder };
}
