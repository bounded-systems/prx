import { describe, expect, test } from "bun:test";

import { builderUpVerb, builderRegisterVerb } from "../../src/builder/verb.ts";
import { BUILDER_SSH_ALIAS } from "../../src/builder/container-builder.ts";

describe("prx builder verbs", () => {
  test("verb ids + actor", () => {
    expect(builderUpVerb.id).toBe("builder up");
    expect(builderRegisterVerb.id).toBe("builder register");
  });

  test("`builder register` renders the machines line + ssh config (pure)", async () => {
    const out = await builderRegisterVerb.run({}, {} as never);
    expect(out.machinesLine).toContain(`ssh-ng://root@${BUILDER_SSH_ALIAS}`);
    expect(out.machinesLine).toContain("aarch64-linux");
    expect(out.sshConfig).toContain(`Host ${BUILDER_SSH_ALIAS}`);
    expect(out.sshConfig).toContain("Port");
  });
  // `builder up` runs live podman + ssh-keygen — covered by the cutover e2e, not
  // a unit test (mirrors pod-up-verb); its render core is unit-tested in
  // container-builder.test.ts.
});
