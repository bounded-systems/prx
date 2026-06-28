// `prx pod secrets` — provision the host podman secrets the pod's rooms DECLARE.
//
// The pod model declares secrets (RoomSpec.secrets: [{name, target}]) consumed at
// launch via `podman run --secret <name>,target=<path>`. Creating them on the host
// was manual (`podman secret create`); this owns it — idempotently, from a source
// map. ocap discipline: for a file source we hand podman the PATH (podman reads
// the file), so the secret never enters prx's memory or argv; only a non-secret
// literal (an app/installation id) is piped via stdin.
import { PodSpecSchema, type PodSpec } from "./pod.ts";
import { spawnPodman, type PodmanRun } from "./podman-runtime.ts";

/** A host podman secret a room declares (and the in-container path it mounts to). */
export interface DeclaredSecret {
  readonly name: string;
  readonly target: string;
  readonly room: string;
}

/** Every host podman secret the pod's rooms declare, flattened with their room. */
export function declaredSecrets(pod: PodSpec): DeclaredSecret[] {
  return PodSpecSchema.parse(pod).rooms.flatMap((r) =>
    (r.secrets ?? []).map((s) => ({ name: s.name, target: s.target, room: r.name })),
  );
}

/** A `--from` value: a file path (caller `@`-prefixes; stripped here) or a literal. */
export type SecretSource =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "literal"; readonly value: string };

export function parseSource(spec: string): SecretSource {
  return spec.startsWith("@")
    ? { kind: "file", path: spec.slice(1) }
    : { kind: "literal", value: spec };
}

export type SecretAction = "created" | "replaced" | "exists" | "missing-source";

export interface SecretStatus extends DeclaredSecret {
  /** Whether the secret existed in podman before this run. */
  readonly present: boolean;
  readonly action: SecretAction;
}

export interface EnsureOptions {
  /** Injected podman runner (defaults to the real one) — fully offline-testable. */
  readonly run?: PodmanRun;
  /** Replace (rotate) a secret that already exists. */
  readonly replace?: boolean;
}

function existingSecretNames(run: PodmanRun): Set<string> {
  const res = run(["secret", "ls", "--format", "{{.Name}}"]);
  if (res.status !== 0) {
    throw new Error(`podman secret ls failed (exit ${res.status ?? "null"}): ${res.stderr.trim()}`);
  }
  return new Set(
    res.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  );
}

/**
 * Ensure each declared secret with a provided source exists in podman. Idempotent:
 * an existing secret is left alone (action "exists") unless `replace` is set
 * (action "replaced"); a declared secret with no source is reported "missing-source"
 * (never silently skipped — the operator sees the gap). Returns one status per
 * declared secret.
 */
export function ensurePodSecrets(
  pod: PodSpec,
  sources: ReadonlyMap<string, SecretSource>,
  options: EnsureOptions = {},
): SecretStatus[] {
  const run = options.run ?? spawnPodman;
  const present = existingSecretNames(run);
  return declaredSecrets(pod).map((d) => {
    const exists = present.has(d.name);
    const src = sources.get(d.name);
    if (exists && !options.replace) return { ...d, present: true, action: "exists" };
    if (!src) return { ...d, present: exists, action: "missing-source" };
    if (exists && options.replace) {
      const rm = run(["secret", "rm", d.name]);
      if (rm.status !== 0) {
        throw new Error(`podman secret rm ${d.name} failed: ${rm.stderr.trim()}`);
      }
    }
    const created =
      src.kind === "file"
        ? run(["secret", "create", d.name, src.path]) // podman reads the file (path only)
        : run(["secret", "create", d.name, "-"], src.value); // literal via stdin
    if (created.status !== 0) {
      throw new Error(`podman secret create ${d.name} failed: ${created.stderr.trim()}`);
    }
    return { ...d, present: true, action: exists ? "replaced" : "created" };
  });
}
