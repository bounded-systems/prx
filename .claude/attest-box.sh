#!/usr/bin/env bash
# SessionStart hook — emit a best-effort identity attestation for the cloud box.
#
# WHY A HOOK, NOT A SETUP SCRIPT: a SessionStart hook is part of the repo clone,
# so its exact bytes are pinned to the head commit a broker already verifies at
# GitHub. A setup script lives in mutable environment config, invisible to git —
# a broker can trust nothing it did. Trusted provisioning belongs here.
#
# WHAT THIS PROVES (and doesn't): the box has NO root of trust of its own — no
# TPM, no SEV-guest, no reachable instance-identity doc (see
# docs/prx/cloud-box-attestation.md). So the `claim.*` and `base_image.*` fields
# are SELF-ASSERTED (forgeable). The real anchors are `anchor.*`: the GitHub
# identity the proxy authenticates as, and the (repo, branch, head_commit) a
# broker RE-VERIFIES via the GitHub API — never taking the box's word.
#
# Fail OPEN + non-blocking + no network + no secrets: writes one JSON file and
# exits 0. The broker call and the push that make it GitHub-attested are separate,
# deliberate steps — a hook must never do them silently.
set -uo pipefail

command -v git >/dev/null 2>&1 || exit 0

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$repo_root" ] || exit 0

state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/prx"
mkdir -p "$state_dir" 2>/dev/null || exit 0
out="$state_dir/box-attestation.json"

branch="$(git -C "$repo_root" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
head_sha="$(git -C "$repo_root" rev-parse HEAD 2>/dev/null || echo unknown)"
head_tree="$(git -C "$repo_root" rev-parse HEAD^{tree} 2>/dev/null || echo unknown)"
# origin is the GitHub-proxy remote (http://…@127.0.0.1:PORT/git/OWNER/REPO);
# extract OWNER/REPO without leaking the embedded proxy credential.
repo_slug="$(git -C "$repo_root" remote get-url origin 2>/dev/null \
  | sed -E 's#^.*/git/##; s#\.git$##' || echo unknown)"

virt="$(command -v systemd-detect-virt >/dev/null 2>&1 && systemd-detect-virt 2>/dev/null || echo unknown)"
os="$(. /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-unknown}")"
sess_url=""
[ -n "${CLAUDE_CODE_REMOTE_SESSION_ID:-}" ] && \
  sess_url="https://claude.ai/code/${CLAUDE_CODE_REMOTE_SESSION_ID/#cse_/session_}"

# hardware root-of-trust surface (empirically absent in Claude cloud; recorded so
# a verifier sees the box asserting its OWN lack of attestation capability).
rot="none"
{ ls /dev/tpm* >/dev/null 2>&1 || ls /dev/sev-guest >/dev/null 2>&1; } && rot="present(unexpected)"

# Single heredoc write (fail-open on any write error). Values are ids/tags/paths;
# no secrets. A broker treats claim.*/base_image.* as self-asserted and verifies
# anchor.* independently at GitHub.
cat > "$out" 2>/dev/null <<JSON || exit 0
{
  "kind": "prx.cloud-box.attestation/v0",
  "claim": {
    "self_asserted": true,
    "environment_type": "${CLAUDE_CODE_REMOTE_ENVIRONMENT_TYPE:-unknown}",
    "remote": ${CLAUDE_CODE_REMOTE:-false},
    "session_id": "${CLAUDE_CODE_REMOTE_SESSION_ID:-unknown}",
    "container_id": "${CLAUDE_CODE_CONTAINER_ID:-unknown}",
    "session_url": "${sess_url}"
  },
  "base_image": {
    "self_asserted": true,
    "attestable": false,
    "ant_image_repository": "${ANT_IMAGE_REPOSITORY:-unknown}",
    "ant_image_tag": "${ANT_IMAGE_TAG:-unknown}",
    "os": "${os}",
    "virt": "${virt}",
    "hardware_root_of_trust": "${rot}"
  },
  "anchor": {
    "verify_via": "github-api",
    "repo": "${repo_slug}",
    "branch": "${branch}",
    "head_commit": "${head_sha}",
    "head_tree": "${head_tree}",
    "github_proxy": "localhost credential-translation proxy",
    "note": "identity = the GitHub login this session pushes/clones as; re-verify at GitHub, not here"
  }
}
JSON

exit 0
