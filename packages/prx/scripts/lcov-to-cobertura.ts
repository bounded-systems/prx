#!/usr/bin/env bun
/**
 * Convert an lcov report to Cobertura XML.
 *
 * Bun's test runner emits lcov (`--coverage-reporter=lcov`), but GitHub Code
 * Quality's coverage feature (and many other consumers) want Cobertura XML.
 * This does the conversion in-repo — no third-party action, no extra dependency.
 *
 * Usage:
 *   bun run scripts/lcov-to-cobertura.ts [coverage/lcov.info] [coverage/cobertura.xml]
 *
 * Report-only: a missing/empty lcov writes an empty-but-valid Cobertura doc and
 * exits 0, so downstream upload steps never hard-fail the build.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const lcovPath = process.argv[2] ?? "coverage/lcov.info";
const outPath = process.argv[3] ?? "coverage/cobertura.xml";

type LineHit = { number: number; hits: number; branchTotal: number; branchCovered: number };
type FileCov = { file: string; lines: Map<number, LineHit> };

function xmlAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function parseLcov(lcov: string): FileCov[] {
  const files: FileCov[] = [];
  let current: FileCov | null = null;
  for (const raw of lcov.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      current = { file: line.slice(3), lines: new Map() };
    } else if (line.startsWith("DA:") && current) {
      const [num, hits] = line.slice(3).split(",");
      const n = Number(num);
      const existing = current.lines.get(n);
      const hitCount = Number(hits);
      if (existing) existing.hits = Math.max(existing.hits, hitCount);
      else current.lines.set(n, { number: n, hits: hitCount, branchTotal: 0, branchCovered: 0 });
    } else if (line.startsWith("BRDA:") && current) {
      // BRDA:<line>,<block>,<branch>,<taken>  (taken is '-' or a hit count)
      const [num, , , taken] = line.slice(5).split(",");
      const n = Number(num);
      const entry = current.lines.get(n) ?? { number: n, hits: 0, branchTotal: 0, branchCovered: 0 };
      entry.branchTotal += 1;
      if (taken !== "-" && Number(taken) > 0) entry.branchCovered += 1;
      current.lines.set(n, entry);
    } else if (line === "end_of_record" && current) {
      files.push(current);
      current = null;
    }
  }
  if (current) files.push(current);
  return files;
}

function rate(covered: number, total: number): string {
  return total === 0 ? "1" : (covered / total).toFixed(4);
}

function build(files: FileCov[]): string {
  let linesValid = 0;
  let linesCovered = 0;
  let branchesValid = 0;
  let branchesCovered = 0;

  // Group files into packages by directory.
  const byDir = new Map<string, FileCov[]>();
  for (const f of files) {
    const dir = dirname(f.file) || ".";
    (byDir.get(dir) ?? byDir.set(dir, []).get(dir)!).push(f);
  }

  const packageXml: string[] = [];
  for (const [dir, dirFiles] of byDir) {
    let pkgLinesValid = 0;
    let pkgLinesCovered = 0;
    let pkgBranchesValid = 0;
    let pkgBranchesCovered = 0;
    const classXml: string[] = [];

    for (const f of dirFiles) {
      const sorted = [...f.lines.values()].sort((a, b) => a.number - b.number);
      let clsLinesValid = 0;
      let clsLinesCovered = 0;
      let clsBranchesValid = 0;
      let clsBranchesCovered = 0;
      const lineXml: string[] = [];

      for (const l of sorted) {
        clsLinesValid += 1;
        if (l.hits > 0) clsLinesCovered += 1;
        clsBranchesValid += l.branchTotal;
        clsBranchesCovered += l.branchCovered;
        if (l.branchTotal > 0) {
          const cc = `${Math.round((l.branchCovered / l.branchTotal) * 100)}% (${l.branchCovered}/${l.branchTotal})`;
          lineXml.push(
            `          <line number="${l.number}" hits="${l.hits}" branch="true" condition-coverage="${xmlAttr(cc)}"/>`,
          );
        } else {
          lineXml.push(`          <line number="${l.number}" hits="${l.hits}" branch="false"/>`);
        }
      }

      pkgLinesValid += clsLinesValid;
      pkgLinesCovered += clsLinesCovered;
      pkgBranchesValid += clsBranchesValid;
      pkgBranchesCovered += clsBranchesCovered;

      const name = f.file.replaceAll("/", ".");
      classXml.push(
        `      <class name="${xmlAttr(name)}" filename="${xmlAttr(f.file)}" ` +
          `line-rate="${rate(clsLinesCovered, clsLinesValid)}" ` +
          `branch-rate="${rate(clsBranchesCovered, clsBranchesValid)}" complexity="0">\n` +
          `        <methods/>\n` +
          `        <lines>\n${lineXml.join("\n")}\n        </lines>\n` +
          `      </class>`,
      );
    }

    linesValid += pkgLinesValid;
    linesCovered += pkgLinesCovered;
    branchesValid += pkgBranchesValid;
    branchesCovered += pkgBranchesCovered;

    packageXml.push(
      `    <package name="${xmlAttr(dir)}" ` +
        `line-rate="${rate(pkgLinesCovered, pkgLinesValid)}" ` +
        `branch-rate="${rate(pkgBranchesCovered, pkgBranchesValid)}" complexity="0">\n` +
        `    <classes>\n${classXml.join("\n")}\n    </classes>\n` +
        `    </package>`,
    );
  }

  return [
    '<?xml version="1.0" ?>',
    '<!DOCTYPE coverage SYSTEM "http://cobertura.sourceforge.net/xml/coverage-04.dtd">',
    `<coverage line-rate="${rate(linesCovered, linesValid)}" branch-rate="${rate(branchesCovered, branchesValid)}" ` +
      `lines-covered="${linesCovered}" lines-valid="${linesValid}" ` +
      `branches-covered="${branchesCovered}" branches-valid="${branchesValid}" ` +
      `complexity="0" version="0.1" timestamp="0">`,
    "  <sources>",
    "    <source>.</source>",
    "  </sources>",
    "  <packages>",
    ...packageXml,
    "  </packages>",
    "</coverage>",
    "",
  ].join("\n");
}

function main(): void {
  let lcov = "";
  try {
    lcov = readFileSync(lcovPath, "utf8");
  } catch {
    process.stdout.write(`no lcov at ${lcovPath} — writing empty Cobertura report\n`);
  }
  const files = lcov ? parseLcov(lcov) : [];
  writeFileSync(outPath, build(files), "utf8");
  process.stdout.write(`wrote ${outPath} (${files.length} files)\n`);
}

main();
