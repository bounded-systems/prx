# The nix-builder-box OCI image (prx-zj8 / prx-62h capstone) — the nix remote
# BUILDER as a pinned container, replacing the Lima builder VM. With this, the
# whole fleet (daemons + the builder) is artifact-native: pinned images on
# podman, no Lima.
#
# HOW IT WORKS: the host's nix offloads aarch64-linux builds to a remote builder
# over `ssh-ng://`. This image runs `sshd`; the host ssh-es in as root and runs
# `nix-store --serve` against the container's /nix (single-user nix, root owns
# the store — simplest in a container). The host's PUBLIC key is mounted at
# `/run/builder/authorized_keys`; the /nix store is a persistent named volume so
# the build cache survives restarts (seeded from the image's own /nix).
#
# Registered in `/etc/nix/machines` as `ssh-ng://builder@127.0.0.1:<port>` (see
# packages/prx/src/room/nix-builder-service.ts + the `prx builder` verb).
#
# Build (offloads to the EXISTING builder for the bootstrap; Lima's last job):
#   nix build .#packages.aarch64-linux.nix-builder-box
self:
{ pkgs, system ? pkgs.stdenv.hostPlatform.system }:
let
  sshdConfig = pkgs.writeText "nix-builder-sshd-config" ''
    PermitRootLogin prohibit-password
    AuthorizedKeysFile /root/.ssh/authorized_keys
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    UsePAM no
    PidFile /run/sshd.pid
    PrintMotd no
  '';

  # Single-user nix as root + sshd. The host pubkey arrives at
  # /run/builder/authorized_keys (a read-only mount); host keys + nix.conf are
  # written at start. `nix-store --serve` (the remote-build protocol) runs as the
  # ssh user directly — no nix-daemon needed in single-user mode.
  entrypoint = pkgs.writeShellScript "nix-builder-box-entrypoint" ''
    set -eu
    mkdir -p /etc/ssh /etc/nix /run /root/.ssh /var/empty
    chmod 700 /root/.ssh
    [ -f /etc/ssh/ssh_host_ed25519_key ] || ${pkgs.openssh}/bin/ssh-keygen -A
    if [ -f /run/builder/authorized_keys ]; then
      cp /run/builder/authorized_keys /root/.ssh/authorized_keys
      chmod 600 /root/.ssh/authorized_keys
    fi
    # ssl-cert-file in nix.conf (NOT just env): the remote-build `nix-store
    # --serve` runs in an ssh session that does NOT inherit the image's
    # SSL_CERT_FILE, so without this nix can't verify TLS to cache.nixos.org and
    # falls back to building every dep from source (slow / OOMs). nix.conf is read
    # regardless of env, so it fixes substitution for the builder protocol.
    printf 'experimental-features = nix-command flakes\ntrusted-users = root\nbuild-users-group =\nsandbox = false\nssl-cert-file = ${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt\n' > /etc/nix/nix.conf
    exec ${pkgs.openssh}/bin/sshd -D -e -f ${sshdConfig}
  '';
in
pkgs.dockerTools.streamLayeredImage {
  name = "nix-builder-box";
  tag = "dev";

  contents = [
    pkgs.nix
    pkgs.openssh
    pkgs.gitMinimal
    pkgs.cacert
    pkgs.coreutils
    pkgs.bashInteractive
    pkgs.xz
    pkgs.gzip
    # /etc/passwd + nsswitch (root + nobody). The sshd privsep user is appended
    # below (modern sshd requires it).
    pkgs.dockerTools.fakeNss
  ];

  extraCommands = ''
    mkdir -p ./tmp ./run ./var/empty ./etc/ssh ./root/.ssh
    chmod 1777 ./tmp
    chmod 700 ./root/.ssh
    # Writable passwd/group with the sshd privsep user. fakeNss provides these as
    # READ-ONLY store symlinks (can't append), and modern sshd REQUIRES the sshd
    # user — so replace them with real files (root + nobody + sshd). printf is a
    # bash builtin (robust in the minimal layer build env; no sed/heredoc).
    rm -f ./etc/passwd ./etc/group
    printf 'root:x:0:0:root:/root:/bin/bash\nnobody:x:65534:65534:nobody:/var/empty:/bin/false\nsshd:x:498:498:SSH privsep:/var/empty:/bin/false\n' > ./etc/passwd
    printf 'root:x:0:\nnobody:x:65534:\nsshd:x:498:\n' > ./etc/group
  '';

  config = {
    Entrypoint = [ "${entrypoint}" ];
    Env = [
      "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt"
      "NIX_SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt"
      "HOME=/root"
      "USER=root"
      "PATH=/bin:${pkgs.nix}/bin:${pkgs.openssh}/bin:${pkgs.gitMinimal}/bin:${pkgs.coreutils}/bin"
    ];
    ExposedPorts = { "22/tcp" = { }; };
    Volumes = { "/nix" = { }; };
    Labels = {
      "org.opencontainers.image.source" = "https://github.com/bounded-systems/prx";
      "dev.prx.image" = "nix-builder-box";
    };
  };
}
