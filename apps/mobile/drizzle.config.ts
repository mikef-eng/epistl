import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit config for the on-device message history database. Run
 * `npm run db:generate` (or `moon run mobile:db-generate`) after changing
 * `src/storage/schema.ts` to produce a new migration under `drizzle/` — see
 * docs/decisions/0012-mobile-local-storage-uses-drizzle-going-forward.md.
 */
export default defineConfig({
  schema: './src/storage/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  driver: 'expo',
});
