// Ambient declaration for `import … from "*.sql" with { type: "text" }`.
//
// Bun's `type: "text"` loader exposes the file contents as a string and
// `bun build --compile` embeds the asset into the bundle. bun-types ships
// this declaration for `*.txt`/`*.toml`/… but not `*.sql`, so we add it here.
// (prx-eky — embedded audit schema.)
declare module "*.sql" {
  const contents: string;
  export default contents;
}
