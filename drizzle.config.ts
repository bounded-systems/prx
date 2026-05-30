import type { Config } from 'drizzle-kit';

export default {
  schema: './packages/anchored-chain-sqlite/src/schema.ts',
  out: './packages/anchored-chain-sqlite/src/migrations',
  dialect: 'sqlite',
} satisfies Config;
