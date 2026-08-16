#!/usr/bin/env bun
/**
 * keeperd VM provenance-key bootstrap (GH-236, slice 4 step 3b — security review
 * APPROVED, conditions a+b).
 *
 * Generates the keeper's **prx-provenance signing key** INSIDE the Lima VM and
 * prints ONLY `PRX_PROVENANCE_PUBKEY`. The private key is born in the VM and
 * never leaves it (hard gate: "private key provably absent from the host"). This
 * is the `PRX_PROVENANCE_KEY=ed25519:<b64>` signer that `attestingGit` uses to
 * emit the signed `push/v1` derivation — a RAW ed25519 key (PKCS8 DER, base64),
 * distinct from the OpenSSH GitHub-signing key (steps 1–2, the #236 two-keys
 * decision).
 *
 * The private value is stored in-VM as `ed25519:<priv-der-b64>` at `--key` (0600)
 * so `keeper up` can later inject it into the daemon's env
 * (`PRX_PROVENANCE_KEY="$(cat <keyfile>)"`) — step 3b's next sub-step. This script
 * only generates + exports the public half.
 *
 * Usage: `bun scripts/keeperd/setup-vm-provenance-key.ts [--vm NAME] [--key REL] [--force]`
 *   --vm NAME   Lima VM name (default: bdelanghe-lima-devshell-main)
 *   --key REL   key path relative to the VM user's $HOME (default: .ssh/keeper_provenance)
 *   --force     regenerate even if a key exists (invalidates the old PRX_PROVENANCE_PUBKEY)
 */

import { runVmShellScript } from "./vm-keygen.ts";

const DEFAULT_VM = "bdelanghe-lima-devshell-main";
const DEFAULT_KEY_REL = ".ssh/keeper_provenance";

/**
 * In-VM body ($1=key-rel $2=force). Generates a raw ed25519 key with openssl,
 * stores it as `ed25519:<pkcs8-der-b64>` (0600), and prints `PRX_PROVENANCE_PUBKEY`
 * (`ed25519:<spki-der-b64>`). No private material is read out — only the pubkey.
 */
const REMOTE_SCRIPT = `set -eu
KEY="$HOME/$1"
FORCE="$2"
DIR="$(dirname "$KEY")"
mkdir -p "$DIR" && chmod 700 "$DIR"

emit_pub() {
  PRIV_B64="$(sed 's/^ed25519://' "$KEY")"
  PUB_B64="$(printf '%s' "$PRIV_B64" | base64 -d | openssl pkey -inform DER -pubout -outform DER | base64 | tr -d '\\n')"
  echo "----- PRX_PROVENANCE_PUBKEY (safe to share) -----"
  printf 'ed25519:%s\\n' "$PUB_B64"
}

if [ -f "$KEY" ] && [ "$FORCE" != "1" ]; then
  echo "provenance key already exists: $KEY (use --force to regenerate)" >&2
  emit_pub
  exit 0
fi

[ "$FORCE" = "1" ] && rm -f "$KEY"
umask 077
PEM="$(openssl genpkey -algorithm ed25519)"
PRIV_B64="$(printf '%s' "$PEM" | openssl pkey -outform DER | base64 | tr -d '\\n')"
printf 'ed25519:%s\\n' "$PRIV_B64" > "$KEY"
chmod 600 "$KEY"
emit_pub
`;

function required(argv: string[], i: number, flag: string): string {
  const value = argv[i];
  if (value === undefined) {
    console.error(`${flag} requires a value`);
    process.exit(2);
  }
  return value;
}

let vm = DEFAULT_VM;
let keyRel = DEFAULT_KEY_REL;
let force = false;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  switch (arg) {
    case "--vm":
      vm = required(argv, ++i, arg);
      break;
    case "--key":
      keyRel = required(argv, ++i, arg);
      break;
    case "--force":
      force = true;
      break;
    case "-h":
    case "--help":
      console.log(
        "keeperd VM provenance-key bootstrap (GH-236 slice 4).\n\n" +
          "Generates the prx-provenance signing key (PRX_PROVENANCE_KEY) INSIDE the VM\n" +
          "and prints ONLY PRX_PROVENANCE_PUBKEY; the private key never leaves the VM.\n\n" +
          "Usage: bun scripts/keeperd/setup-vm-provenance-key.ts [--vm NAME] [--key REL] [--force]\n" +
          `  --vm NAME   Lima VM name (default: ${DEFAULT_VM})\n` +
          `  --key REL   key path relative to the VM user's $HOME (default: ${DEFAULT_KEY_REL})\n` +
          "  --force     regenerate even if a key exists (invalidates the old pubkey)",
      );
      process.exit(0);
    // process.exit() above is `never`, so this never falls through to default
    default:
      console.error(`unknown arg: ${arg} (try --help)`);
      process.exit(2);
  }
}

runVmShellScript(vm, REMOTE_SCRIPT, [keyRel, force ? "1" : "0"]);
