/**
 * The generated `drizzle/migrations.js` imports each migration's `.sql`
 * file directly; `babel-plugin-inline-import` (see babel.config.js) inlines
 * its contents as a string literal at build/transform time, so this is the
 * only thing TypeScript needs to resolve the import for type-checking.
 */
declare module '*.sql' {
  const sql: string;
  export default sql;
}
