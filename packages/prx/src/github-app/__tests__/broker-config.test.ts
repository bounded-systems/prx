import { describe, expect, test } from "bun:test";

import { BrokerConfigError, resolveBrokerConfig } from "../broker-config.ts";

const envFrom =
  (rec: Record<string, string>) =>
  (key: string): string | undefined =>
    rec[key];

describe("resolveBrokerConfig", () => {
  test("fail-open: returns null when no issuer is configured", () => {
    expect(resolveBrokerConfig({ getEnv: envFrom({}) })).toBeNull();
  });

  test("inline PEM wins over file; readFile is not consulted", () => {
    let readCalls = 0;
    const cfg = resolveBrokerConfig({
      getEnv: envFrom({
        PRX_GH_APP_ID: "Iv1",
        PRX_GH_APP_PRIVATE_KEY: "-----BEGIN-----inline-----END-----",
        PRX_GH_APP_KEY_FILE: "/should/not/read",
      }),
      readFile: () => {
        readCalls++;
        return "FROM_FILE";
      },
    });
    expect(cfg?.source).toBe("inline");
    expect(cfg?.privateKeyPem).toBe("-----BEGIN-----inline-----END-----");
    expect(readCalls).toBe(0);
  });

  test("reads the file when no inline PEM is set", () => {
    const cfg = resolveBrokerConfig({
      getEnv: envFrom({ PRX_GH_APP_ID: "Iv1", PRX_GH_APP_KEY_FILE: "/key.pem" }),
      readFile: (p) => {
        expect(p).toBe("/key.pem");
        return "FILE_PEM";
      },
    });
    expect(cfg?.source).toBe("file");
    expect(cfg?.privateKeyPem).toBe("FILE_PEM");
  });

  test("accepts PRX_GH_APP_CLIENT_ID as the issuer alias", () => {
    const cfg = resolveBrokerConfig({
      getEnv: envFrom({ PRX_GH_APP_CLIENT_ID: "Iv2", PRX_GH_APP_PRIVATE_KEY: "P" }),
    });
    expect(cfg?.issuer).toBe("Iv2");
  });

  test("installationId defaults to the bounded-systems org, or honors override", () => {
    const def = resolveBrokerConfig({
      getEnv: envFrom({ PRX_GH_APP_ID: "Iv1", PRX_GH_APP_PRIVATE_KEY: "P" }),
    });
    expect(def?.installationId).toBe("138039680");
    const override = resolveBrokerConfig({
      getEnv: envFrom({ PRX_GH_APP_ID: "Iv1", PRX_GH_APP_PRIVATE_KEY: "P", PRX_GH_INSTALLATION_ID: "999" }),
    });
    expect(override?.installationId).toBe("999");
  });

  test("misconfig: issuer set but no key source → throws", () => {
    expect(() => resolveBrokerConfig({ getEnv: envFrom({ PRX_GH_APP_ID: "Iv1" }) })).toThrow(
      BrokerConfigError,
    );
  });

  test("misconfig: key file set but readFile throws → throws (not fail-open)", () => {
    expect(() =>
      resolveBrokerConfig({
        getEnv: envFrom({ PRX_GH_APP_ID: "Iv1", PRX_GH_APP_KEY_FILE: "/missing" }),
        readFile: () => {
          throw new Error("ENOENT");
        },
      }),
    ).toThrow(BrokerConfigError);
  });

  test("misconfig: key file set but no readFile dependency → throws", () => {
    expect(() =>
      resolveBrokerConfig({ getEnv: envFrom({ PRX_GH_APP_ID: "Iv1", PRX_GH_APP_KEY_FILE: "/x" }) }),
    ).toThrow(BrokerConfigError);
  });

  test("attenuation absent by default (full installation scope)", () => {
    const cfg = resolveBrokerConfig({
      getEnv: envFrom({ PRX_GH_APP_ID: "Iv1", PRX_GH_APP_PRIVATE_KEY: "P" }),
    });
    expect(cfg?.repositories).toBeUndefined();
    expect(cfg?.permissions).toBeUndefined();
  });

  test("parses repositories (comma-sep, trimmed) and permissions (JSON)", () => {
    const cfg = resolveBrokerConfig({
      getEnv: envFrom({
        PRX_GH_APP_ID: "Iv1",
        PRX_GH_APP_PRIVATE_KEY: "P",
        PRX_GH_APP_REPOSITORIES: "prx, trust ,",
        PRX_GH_APP_PERMISSIONS: '{"contents":"read"}',
      }),
    });
    expect(cfg?.repositories).toEqual(["prx", "trust"]);
    expect(cfg?.permissions).toEqual({ contents: "read" });
  });

  test("invalid permissions JSON → throws", () => {
    expect(() =>
      resolveBrokerConfig({
        getEnv: envFrom({
          PRX_GH_APP_ID: "Iv1",
          PRX_GH_APP_PRIVATE_KEY: "P",
          PRX_GH_APP_PERMISSIONS: "{not json",
        }),
      }),
    ).toThrow(BrokerConfigError);
  });
});
