import knexFactory from 'knex';
import { types } from 'pg';
import { knexConfig } from '../config/database';

// node-postgres returns BIGINT (int8) columns as strings. Our ids fit safely
// in JS numbers, and string ids break zod validation (recognize payloads) and
// the monitor's client-side cache keys — parse them as numbers.
types.setTypeParser(types.builtins.INT8, (value) => parseInt(value, 10));

export const db = knexFactory(knexConfig);
