// Argv parser for `prx <actor> dispatch …` (GH-1194). The
// normalizeNamespaceArgv layer rewrites every `prx <actor> dispatch …` form
// to `dispatch --source=<actor> …`, so this parser owns the rest:
//
//   dispatch --source=plan --actor=scout -- grep mkdtemp --in GH-1174
//   dispatch --source=plan --target=scout -- grep mkdtemp
//   dispatch --source=triage status --json                (self-dispatch)
//   dispatch --source=plan -- save --unit GH-1194         (self-dispatch)
//
// The parser produces a typed ParsedDispatch envelope; the handler
// (handler.ts) feeds it into the dispatch machine.

import {
  dispatchActorSchema,
  dispatchInputArtifactRefSchema,
  type DispatchActor,
  type DispatchInputArtifactRef,
} from "../../machine/dispatch.ts";

export class DispatchParseError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "DispatchParseError";
    this.code = code;
  }
}

export interface ParsedDispatch {
  source: DispatchActor;
  target: DispatchActor;
  action: string;
  /** argv tail forwarded verbatim to the target verb's headless invocation. */
  argv: string[];
  /**
   * GH-2418 — the OCAP capability the caller presents: a typed input artifact
   * (`--input-artifact-type=<t>` + optional `--input-cas=<handle>`). When the
   * typed-dispatch gate is on for the source profile, this is what authorizes
   * dispatch to a contract-typed target; absent/mismatched → capability_denied.
   */
  inputArtifact?: DispatchInputArtifactRef;
}

/**
 * Parse the rewritten argv (post-normalizeNamespaceArgv). The leading
 * "dispatch" command word is consumed by the cli.ts dispatcher; the input
 * here is everything after.
 */
export function parseDispatchCommand(rest: string[]): ParsedDispatch {
  let source: string | undefined;
  let target: string | undefined;
  let actorOverride: string | undefined;
  // GH-2418 — typed-input (OCAP) capability flags.
  let inputArtifactType: string | undefined;
  let inputCasHandle: string | undefined;

  // Leading flags that take a value (both `--flag=value` and `--flag value`).
  const valueFlags = new Set([
    "--source",
    "--target",
    "--actor",
    "--input-artifact-type",
    "--input-cas",
  ]);

  // Walk leading flags. The value flags above accept both `--flag=value` and
  // `--flag value` forms. Stop at first non-flag (which becomes the action
  // when no `--` separator is present) or at `--`.
  let i = 0;
  while (i < rest.length) {
    const tok = rest[i] as string;
    if (tok === "--") {
      i += 1;
      break;
    }
    if (!tok.startsWith("--")) {
      break;
    }
    const eq = tok.indexOf("=");
    const flag = eq === -1 ? tok : tok.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : tok.slice(eq + 1);
    let value: string | undefined;
    if (inlineValue !== undefined) {
      value = inlineValue;
      i += 1;
    } else if (valueFlags.has(flag)) {
      value = rest[i + 1];
      if (value === undefined) {
        throw new DispatchParseError(`${flag} requires a value`, "MISSING_VALUE");
      }
      i += 2;
    } else {
      // Unrecognized leading flag — leave it for the verb's argv tail.
      break;
    }
    switch (flag) {
      case "--source":
        source = value;
        break;
      case "--target":
        target = value;
        break;
      case "--actor":
        // GH-1194 user-facing form: `prx plan dispatch --actor=scout …`.
        actorOverride = value;
        break;
      case "--input-artifact-type":
        // GH-2418: the typed capability the caller presents to the OCAP gate.
        inputArtifactType = value;
        break;
      case "--input-cas":
        // GH-2418: optional CAS handle backing the presented artifact.
        inputCasHandle = value;
        break;
      default:
        // Should not reach: only the value flags above advance i+=2.
        break;
    }
  }

  // After flag walk: if i hit a `--`, the remaining argv is the verb. If i
  // landed on a non-flag, that token is the action with the remainder as
  // its argv (no separator form, e.g. `dispatch --source=triage status`).
  const remainder = rest.slice(i);
  let action: string | undefined;
  let argv: string[];
  if (remainder.length === 0) {
    throw new DispatchParseError(
      "dispatch requires an action verb (e.g., `dispatch --source=plan -- save GH-N`)",
      "MISSING_ACTION",
    );
  }
  action = remainder[0];
  argv = remainder.slice(1);
  if (typeof action !== "string" || action.length === 0) {
    throw new DispatchParseError("dispatch action must not be empty", "MISSING_ACTION");
  }

  if (source === undefined) {
    throw new DispatchParseError(
      "dispatch requires --source=<actor>; this flag is normally injected by the namespace rewrite",
      "MISSING_SOURCE",
    );
  }
  // --target wins if both are passed; --actor is the user-facing alias.
  const resolvedTarget = target ?? actorOverride ?? source; // self-dispatch default

  // Validate against the typed actor enum at the boundary.
  const sourceParsed = dispatchActorSchema.safeParse(source);
  if (!sourceParsed.success) {
    throw new DispatchParseError(`unknown source actor: ${source}`, "INVALID_SOURCE");
  }
  const targetParsed = dispatchActorSchema.safeParse(resolvedTarget);
  if (!targetParsed.success) {
    throw new DispatchParseError(`unknown target actor: ${resolvedTarget}`, "INVALID_TARGET");
  }

  // GH-2418: assemble the typed-input ref at the boundary. `--input-cas`
  // without `--input-artifact-type` is meaningless (a CAS handle with no
  // declared type cannot satisfy a contract), so reject it explicitly.
  let inputArtifact: DispatchInputArtifactRef | undefined;
  if (inputArtifactType !== undefined) {
    const refParsed = dispatchInputArtifactRefSchema.safeParse({
      type: inputArtifactType,
      ...(inputCasHandle !== undefined ? { casHandle: inputCasHandle } : {}),
    });
    if (!refParsed.success) {
      throw new DispatchParseError(
        `invalid --input-artifact-type/--input-cas: ${refParsed.error.issues[0]?.message ?? "malformed"}`,
        "INVALID_INPUT_ARTIFACT",
      );
    }
    inputArtifact = refParsed.data;
  } else if (inputCasHandle !== undefined) {
    throw new DispatchParseError(
      "--input-cas requires --input-artifact-type=<type>",
      "INVALID_INPUT_ARTIFACT",
    );
  }

  return {
    source: sourceParsed.data,
    target: targetParsed.data,
    action,
    argv,
    ...(inputArtifact !== undefined ? { inputArtifact } : {}),
  };
}
