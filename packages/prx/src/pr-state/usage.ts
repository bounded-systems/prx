import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { usageStateV1Schema, type UsageStateV1 } from "../machine/usage.ts";

export * from "../machine/usage.ts";

export function defaultUsageStatePath(cwd = process.cwd()): string {
  return join(cwd, ".pr", "local", "usage.json");
}

export function usageStateExists(path: string): boolean {
  return existsSync(path);
}

export function loadUsageState(path: string): UsageStateV1 {
  return usageStateV1Schema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function writeUsageState(path: string, state: UsageStateV1): void {
  const validated = usageStateV1Schema.parse(state);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(validated, null, 2)}\n`);
}
