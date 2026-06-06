// GH-245: `import x from './m.sql' with { type: 'text' }` — the migration SQL is
// embedded as a string so `bun build --compile` binaries carry it (the on-disk
// ./migrations folder is absent there). This ambient declaration gives the text
// import a type.
declare module '*.sql' {
  const content: string;
  export default content;
}
