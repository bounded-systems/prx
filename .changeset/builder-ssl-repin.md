---
"@bounded-systems/prx": patch
---

nix-builder-box: set `ssl-cert-file` in the container's nix.conf so the
remote-build ssh session can substitute from cache.nixos.org (it doesn't inherit
the image SSL_CERT_FILE env), and re-pin `NIX_BUILDER_IMAGE` to the fixed digest.
Verified live: the host nix daemon offloads a real OCI build (dolt-box) to the
container with Lima stopped — the builder cutover (prx-zj8).
