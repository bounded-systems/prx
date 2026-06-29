#!/usr/bin/env bun
// Repin each room's box image to the `latest` digest in GHCR. Run by the
// publish-oci-boxes `repin` job after the boxes rebuild; the workflow opens a PR
// with whatever changed. Pure replace logic lives in ../src/room/repin.ts.
//
// Boxes are public, so `skopeo inspect` needs no auth. Prints which files changed
// (the workflow checks `git diff` to decide whether to open a PR).
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

import { BOX_PINS, repinImage } from "../src/room/repin.ts";

let changed = 0;
for (const { image, file } of BOX_PINS) {
  const res = spawnSync(
    "skopeo",
    ["inspect", "--format", "{{.Digest}}", `docker://${image}:latest`],
    { encoding: "utf8" },
  );
  if (res.status !== 0) {
    console.error(`skopeo inspect ${image} failed: ${res.stderr?.trim() ?? res.status}`);
    process.exit(1);
  }
  const digest = res.stdout.trim();
  const text = readFileSync(file, "utf8");
  const out = repinImage(text, image, digest);
  if (out.changed) {
    writeFileSync(file, out.text);
    changed++;
    console.log(`repinned ${image} -> ${digest} (${file})`);
  } else {
    console.log(`${image}: already at ${digest}`);
  }
}
// Emit a changeset so the auto-PR clears the changeset gate (src/ changed).
if (changed > 0) {
  writeFileSync(
    ".changeset/auto-repin.md",
    `---\n"@bounded-systems/prx": patch\n---\n\n` +
      `Auto-repin room images to the freshly-built box digests (publish-oci-boxes repin job).\n`,
  );
}
console.log(`\n${changed} file(s) repinned.`);
