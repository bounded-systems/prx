// GH-1238: locate and inspect the `## Scope` section of a saved plan blob.
// GH-1277: extends the locator with a single-call shape gate shared by both
// `prx plan save` (write) and `prx implement` (consume), so refusal wording
// cannot drift between the two sites.
//
// The implement-session refusal contract reads a draft slot and rejects the
// session when no Scope section exists, or when the section is empty after
// stripping HTML/markdown comments and whitespace. Co-located with plan-store
// so the same helper can back future plan-validate verbs.

export interface ParsePlanScopeResult {
  // A heading matching /^#{2,}\s+Scope\b/i was found in the body.
  hasScope: boolean;
  // Raw text between the Scope heading and the next same-or-shallower heading,
  // trimmed of leading/trailing whitespace. Empty string when !hasScope.
  scopeBody: string;
  // True when scopeBody is empty after stripping markdown/HTML comments and
  // whitespace. Always true when !hasScope.
  isEmpty: boolean;
}

const COMMENT_PATTERN = /<!--[\s\S]*?-->/g;
const SCOPE_HEADING = /^(#{2,})\s+scope\b/i;
const ANY_HEADING = /^(#{1,6})\s+\S/;

export function parsePlanScope(body: Buffer | string): ParsePlanScopeResult {
  const text = typeof body === "string" ? body : body.toString("utf8");
  const lines = text.split(/\r?\n/);

  let scopeStart = -1;
  let scopeDepth = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(SCOPE_HEADING);
    if (m) {
      scopeStart = i;
      scopeDepth = m[1]!.length;
      break;
    }
  }

  if (scopeStart < 0) {
    return { hasScope: false, scopeBody: "", isEmpty: true };
  }

  let scopeEnd = lines.length;
  for (let i = scopeStart + 1; i < lines.length; i++) {
    const h = lines[i]!.match(ANY_HEADING);
    if (h && h[1]!.length <= scopeDepth) {
      scopeEnd = i;
      break;
    }
  }

  const scopeBody = lines.slice(scopeStart + 1, scopeEnd).join("\n").trim();
  const stripped = scopeBody.replace(COMMENT_PATTERN, "").trim();
  return { hasScope: true, scopeBody, isEmpty: stripped.length === 0 };
}

// GH-1277 → GH-2028: shared shape gate for plan blobs. Under persist-on-failure
// this is *diagnostics-producing*, not refusing: the producer (`runPlanSave`)
// always persists the body and records the verdict in the envelope, and the
// consumer (`prx implement agent`) refuses on `validated_ok: false`. The two
// diagnostic codes mirror the two failure modes of `parsePlanScope`: missing
// heading vs. empty body.

import type { PlanDiagnostic } from "./envelope.ts";

export interface PlanShapeVerdict {
  validated_ok: boolean;
  diagnostics: PlanDiagnostic[];
}

export function validatePlanShape(
  body: Buffer | string,
  unitId: string,
): PlanShapeVerdict {
  const scope = parsePlanScope(body);
  if (!scope.hasScope) {
    return {
      validated_ok: false,
      diagnostics: [
        {
          code: "no-scope",
          path: "## Scope",
          message: `plan body for ${unitId} has no \`## Scope\` section. Refine via \`prx plan session ${unitId}\`.`,
        },
      ],
    };
  }
  if (scope.isEmpty) {
    return {
      validated_ok: false,
      diagnostics: [
        {
          code: "empty-scope",
          path: "## Scope",
          message: `plan body for ${unitId} has an empty \`## Scope\` section. Refine via \`prx plan session ${unitId}\`.`,
        },
      ],
    };
  }
  return { validated_ok: true, diagnostics: [] };
}
