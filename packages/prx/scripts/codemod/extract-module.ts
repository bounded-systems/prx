#!/usr/bin/env bun
// ts-morph codemod — extract named top-level declarations from a source module
// into a new SIBLING module (same directory), carrying the imports they use and
// re-importing the moved symbols back into the source where still referenced.
// The first concrete tool for the §4 decomposition of pr-state/cli.ts: move a
// cohesive cluster out, verb-by-verb, with the AST (not hand cut/paste).
//
//   bun run packages/prx/scripts/codemod/extract-module.ts <source> <target> <Name...>
//
// Paths are repo-relative; source and target MUST share a directory so the moved
// imports' relative specifiers stay valid (copied verbatim). The codemod REFUSES
// to run if the block depends on a symbol still defined in the source (that would
// create a source⇄target import cycle) — extract that symbol to a shared leaf, or
// include it in the move list, first. Always re-run typecheck + tests afterward.

import { dirname } from "node:path";
import { Node, Project, SyntaxKind, type Statement } from "ts-morph";

const [sourceRel, targetRel, ...names] = process.argv.slice(2);
if (!sourceRel || !targetRel || names.length === 0) {
  console.error("usage: extract-module <source> <target> <Name...>");
  process.exit(1);
}
if (dirname(sourceRel) !== dirname(targetRel)) {
  console.error("source and target must be in the same directory (relative imports are copied verbatim)");
  process.exit(1);
}

const wanted = new Set(names);
const project = new Project({ tsConfigFilePath: "tsconfig.json", skipAddingFilesFromTsConfig: true });
const source = project.addSourceFileAtPath(sourceRel);

function statementNames(s: Statement): string[] {
  if (Node.isVariableStatement(s)) return s.getDeclarations().map((d) => d.getName());
  if (
    Node.isFunctionDeclaration(s) || Node.isTypeAliasDeclaration(s) ||
    Node.isInterfaceDeclaration(s) || Node.isClassDeclaration(s) || Node.isEnumDeclaration(s)
  ) {
    const n = s.getName();
    return n ? [n] : [];
  }
  return [];
}
const isTypeStatement = (s: Statement) => Node.isTypeAliasDeclaration(s) || Node.isInterfaceDeclaration(s);

const moved = source.getStatements().filter((s) => statementNames(s).some((n) => wanted.has(n)));
const movedNames = new Set(moved.flatMap(statementNames));
const typeNames = new Set(moved.filter(isTypeStatement).flatMap(statementNames));
const missing = [...wanted].filter((n) => !movedNames.has(n));
if (missing.length) {
  console.error(`not found as top-level declarations in ${sourceRel}: ${missing.join(", ")}`);
  process.exit(1);
}

// Identifiers referenced anywhere inside the moved block.
const usedIds = new Set<string>();
for (const s of moved) for (const id of s.getDescendantsOfKind(SyntaxKind.Identifier)) usedIds.add(id.getText());

// Imports the moved block needs — carried to the target verbatim (same dir).
const carried = source.getImportDeclarations().flatMap((imp) => {
  const named = imp.getNamedImports().filter((ni) => usedIds.has((ni.getAliasNode() ?? ni.getNameNode()).getText()));
  const def = imp.getDefaultImport();
  const ns = imp.getNamespaceImport();
  const wantDef = def !== undefined && usedIds.has(def.getText());
  const wantNs = ns !== undefined && usedIds.has(ns.getText());
  if (!wantDef && !wantNs && named.length === 0) return [];
  return [{
    moduleSpecifier: imp.getModuleSpecifierValue(),
    isTypeOnly: imp.isTypeOnly(),
    defaultImport: wantDef ? def!.getText() : undefined,
    namespaceImport: wantNs ? ns!.getText() : undefined,
    namedImports: named.map((ni) => {
      const alias = ni.getAliasNode()?.getText();
      return alias ? { name: ni.getNameNode().getText(), alias, isTypeOnly: ni.isTypeOnly() }
                   : { name: ni.getNameNode().getText(), isTypeOnly: ni.isTypeOnly() };
    }),
  }];
});
const carriedNames = new Set(
  carried.flatMap((c) => [c.defaultImport, c.namespaceImport, ...c.namedImports.map((n) => n.alias ?? n.name)])
    .filter((x): x is string => x !== undefined),
);

// A symbol the block uses that is still a top-level decl in the source (and not
// moved/imported) would force a target → source import = a cycle. Refuse.
const sourceTopLevel = new Set(source.getStatements().flatMap(statementNames));
const localDeps = [...usedIds].filter((id) => sourceTopLevel.has(id) && !movedNames.has(id) && !carriedNames.has(id));
if (localDeps.length) {
  console.error(
    `refusing: the block uses source-local symbol(s) [${localDeps.join(", ")}] still defined in ${sourceRel}.\n` +
      `Importing them back would create a source⇄target cycle. Either add them to the move list, or\n` +
      `extract them to a shared leaf module first, then re-run.`,
  );
  process.exit(1);
}

const movedText = moved.map((s) => s.getText()).join("\n\n");
for (const s of moved) s.remove();

const remaining = source.getFullText();
const reimport = [...movedNames].filter((n) => new RegExp(`\\b${n}\\b`).test(remaining)).sort();

const target = project.createSourceFile(targetRel, "", { overwrite: true });
target.insertText(0,
  `// Extracted from ${sourceRel} by scripts/codemod/extract-module.ts — part of the\n` +
  `// §4 decomposition of the pr-state/cli.ts monolith into focused modules.\n\n`,
);
for (const c of carried) {
  target.addImportDeclaration({
    moduleSpecifier: c.moduleSpecifier,
    ...(c.isTypeOnly ? { isTypeOnly: true } : {}),
    ...(c.defaultImport ? { defaultImport: c.defaultImport } : {}),
    ...(c.namespaceImport ? { namespaceImport: c.namespaceImport } : {}),
    namedImports: c.namedImports,
  });
}
target.addStatements(`\n${movedText}\n`);
for (const s of target.getStatements()) {
  if (Node.isExportable(s) && statementNames(s).some((n) => reimport.includes(n)) && !s.isExported()) {
    s.setIsExported(true);
  }
}

if (reimport.length) {
  source.addImportDeclaration({
    moduleSpecifier: `./${targetRel.split("/").pop()!.replace(/\.ts$/, ".ts")}`,
    namedImports: reimport.map((name) => ({ name, isTypeOnly: typeNames.has(name) })),
  });
}

source.saveSync();
target.saveSync();

console.log(`extracted ${movedNames.size} declarations → ${targetRel}`);
console.log(`  carried imports: ${carried.length}; re-imported into source: ${reimport.join(", ") || "(none)"}`);
