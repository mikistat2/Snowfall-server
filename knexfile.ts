import type { Knex } from 'knex';
import { knexConfig } from './src/config/database';

// CLI config (npm run migrate / seed) — shares SSL + pool logic with the app,
// so pointing DATABASE_URL at Neon works for migrations and seeds too.
const config: Knex.Config = {
  ...knexConfig,
  migrations: {
    directory: './src/db/migrations',
    extension: 'ts',
    tableName: 'knex_migrations',
  },
  seeds: {
    directory: './src/db/seeds',
    extension: 'ts',
  },
};

export default config;
