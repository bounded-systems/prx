// CAS URI codec (GH-1194). Boundary helpers between domain-keyed cas blobs
// and the dispatch envelope's casHandle string. Per
// reference_zod_boundary_layer, the URI shape is the boundary; the cas
// substrate keeps domain as a plain string parameter.

import type { CasSha } from "./cas.ts";

const URI_RE = /^([a-z][a-z0-9_-]*):\/\/sha256:([0-9a-f]{64})$/;
const DOMAIN_RE = /^[a-z][a-z0-9_-]*$/;
const SHA_RE = /^sha256:[0-9a-f]{64}$/;
const MAX_DOMAIN = 64;

export class CasUriError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "CasUriError";
    this.code = code;
  }
}

export interface ParsedCasUri {
  domain: string;
  sha: CasSha;
}

export function casUriFor(domain: string, sha: CasSha): string {
  if (typeof domain !== "string" || domain.length === 0) {
    throw new CasUriError("domain must not be empty", "INVALID_DOMAIN");
  }
  if (domain.length > MAX_DOMAIN) {
    throw new CasUriError(`domain too long (>${MAX_DOMAIN})`, "INVALID_DOMAIN");
  }
  if (!DOMAIN_RE.test(domain)) {
    throw new CasUriError(
      `invalid domain: ${domain} (must match ${DOMAIN_RE.source})`,
      "INVALID_DOMAIN",
    );
  }
  if (typeof sha !== "string" || !SHA_RE.test(sha)) {
    throw new CasUriError(`invalid sha: ${String(sha)}`, "INVALID_SHA");
  }
  return `${domain}://${sha}`;
}

export function parseCasUri(uri: string): ParsedCasUri {
  if (typeof uri !== "string" || uri.length === 0) {
    throw new CasUriError("uri must not be empty", "INVALID_URI");
  }
  const m = URI_RE.exec(uri);
  if (m === null) {
    throw new CasUriError(
      `invalid cas uri: ${uri} (expected <domain>://sha256:<hex64>)`,
      "INVALID_URI",
    );
  }
  if ((m[1] as string).length > MAX_DOMAIN) {
    throw new CasUriError(`invalid cas uri: domain too long (>${MAX_DOMAIN})`, "INVALID_URI");
  }
  return { domain: m[1] as string, sha: `sha256:${m[2] as string}` };
}
