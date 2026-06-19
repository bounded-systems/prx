// Build the GitHub Pages site — another projection of the project graph. The
// doc catalog (`collectDocRelPaths`, the same source the README/JSON-LD use),
// `prx.jsonld` (the hostable schema.org graph), and the `schemas/*` JSON Schema
// artifacts all become a static site under `_site/`, deployed by
// `.github/workflows/pages.yml`.
//
//   bun run site:build           # writes _site/
//
// No site framework: Markdown → HTML via `marked`, wrapped in one template.
// Internal `.md` links are rewritten to `.html` so navigation works on Pages.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { marked } from "marked";
import { findRepoRoot } from "../src/repo-root.ts";
const REPO_ROOT = findRepoRoot();
import { collectDocRelPaths } from "../src/graph/build.ts";

const OUT = join(REPO_ROOT, "_site");
const title = (md: string, fallback: string) => md.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? fallback;
const htmlPath = (rel: string) => rel.replace(/\.md$/, ".html");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Wrap rendered body in the site shell; `depth` sets the relative root. */
function page(pageTitle: string, body: string, depth: number): string {
  const root = depth === 0 ? "." : Array(depth).fill("..").join("/");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(pageTitle)} — prx</title>
<link rel="stylesheet" href="${root}/style.css">
</head>
<body>
<header><a href="${root}/index.html">prx</a></header>
<main>
${body}
</main>
<footer>Generated from the prx project graph · <a href="${root}/prx.jsonld">prx.jsonld</a></footer>
</body>
</html>
`;
}

function renderDoc(rel: string): { out: string; title: string } {
  const md = readFileSync(join(REPO_ROOT, rel), "utf8");
  const docTitle = title(md, rel);
  // Rewrite relative .md links to .html (keep any #anchor).
  const html = (marked.parse(md, { async: false }) as string).replace(
    /href="(?!https?:|\/\/)([^"]+?)\.md(#[^"]*)?"/g,
    'href="$1.html$2"',
  );
  const depth = htmlPath(rel).split("/").length - 1;
  return { out: page(docTitle, html, depth), title: docTitle };
}

// --- build -----------------------------------------------------------------
if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const docs = collectDocRelPaths();
const entries: Array<{ rel: string; href: string; title: string }> = [];
for (const rel of docs) {
  const { out, title: t } = renderDoc(rel);
  const dest = join(OUT, htmlPath(rel));
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, out);
  entries.push({ rel, href: htmlPath(rel), title: t });
}

// Publish the hostable graph + the JSON Schema artifacts at stable URLs.
cpSync(join(REPO_ROOT, "prx.jsonld"), join(OUT, "prx.jsonld"));
const schemasDir = join(REPO_ROOT, "packages/prx/schemas");
if (existsSync(schemasDir)) cpSync(schemasDir, join(OUT, "schemas"), { recursive: true });

// Group the index: top-level docs, docs/, package READMEs.
const group = (pred: (r: string) => boolean) =>
  entries
    .filter((e) => pred(e.rel))
    .map((e) => `  <li><a href="${e.href}">${esc(e.title)}</a> <code>${e.rel}</code></li>`)
    .join("\n");
const section = (name: string, items: string) =>
  items ? `<h2>${name}</h2>\n<ul>\n${items}\n</ul>` : "";

const index = [
  "<h1>prx documentation</h1>",
  "<p>The agent-run PR contract / work-unit CLI. This site is generated from the project graph.</p>",
  section(
    "Overview",
    group((r) => !r.includes("/") || r === "spec/README.md"),
  ),
  section(
    "Design docs",
    group((r) => r.startsWith("docs/")),
  ),
  section(
    "Packages",
    group((r) => r.startsWith("packages/")),
  ),
  "<h2>Machine-readable</h2>",
  '<ul>\n  <li><a href="prx.jsonld">prx.jsonld</a> — schema.org project graph</li>\n' +
    '  <li><a href="schemas/">schemas/</a> — JSON Schema artifacts</li>\n</ul>',
].join("\n");
writeFileSync(join(OUT, "index.html"), page("Documentation", index, 0));

// Minimal, professional stylesheet; Pages serves _site as-is (.nojekyll).
writeFileSync(
  join(OUT, "style.css"),
  `:root{--fg:#1b1f24;--muted:#57606a;--accent:#0969da;--line:#d0d7de;--bg:#fff}
*{box-sizing:border-box}body{margin:0;color:var(--fg);background:var(--bg);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
header,footer{padding:1rem 2rem;border-bottom:1px solid var(--line)}footer{border:0;border-top:1px solid var(--line);color:var(--muted);font-size:.875rem}
header a{font-weight:600;text-decoration:none;color:var(--fg)}
main{max-width:48rem;margin:0 auto;padding:2rem 1.5rem}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
h1,h2,h3{line-height:1.25;margin-top:1.8rem}h1{font-size:2rem}
code{background:#f6f8fa;padding:.15em .35em;border-radius:6px;font-size:.9em}
pre{background:#f6f8fa;padding:1rem;border-radius:8px;overflow:auto}pre code{background:none;padding:0}
table{border-collapse:collapse;width:100%}th,td{border:1px solid var(--line);padding:.4rem .6rem;text-align:left}
blockquote{margin:0;padding:.2rem 1rem;border-left:3px solid var(--line);color:var(--muted)}
ul{padding-left:1.2rem}li code{color:var(--muted);font-size:.85em}`,
);
writeFileSync(join(OUT, ".nojekyll"), "");

console.log(
  `wrote ${relative(REPO_ROOT, OUT)}/ — ${entries.length} doc pages + prx.jsonld + schemas/`,
);
