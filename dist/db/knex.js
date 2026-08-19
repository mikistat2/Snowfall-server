"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.db = void 0;
const knex_1 = __importDefault(require("knex"));
const pg_1 = require("pg");
const database_1 = require("../config/database");
// node-postgres returns BIGINT (int8) columns as strings. Our ids fit safely
// in JS numbers, and string ids break zod validation (recognize payloads) and
// the monitor's client-side cache keys — parse them as numbers.
pg_1.types.setTypeParser(pg_1.types.builtins.INT8, (value) => parseInt(value, 10));
/**
 * Postgres DATE columns (`subscriptions.starts_at` / `expires_at`) must stay
 * plain "YYYY-MM-DD" strings all the way to the client.
 *
 * By default node-postgres turns a DATE into a JS `Date` at **local** midnight,
 * and `res.json()` then serializes that as UTC. On any host east of UTC — a
 * laptop in Ethiopia is UTC+3 — a stored `2026-10-17` leaves the API as
 * `"2026-10-16T21:00:00.000Z"`, and every consumer that slices the first ten
 * characters (the members table, the member page, `daysLeft()`) reads the
 * expiry a day early. A 60-day package looked like 59 days.
 *
 * Returning the raw string removes the timezone from the round-trip entirely:
 * a date-only value never becomes an instant, so it cannot be shifted by one.
 */
pg_1.types.setTypeParser(pg_1.types.builtins.DATE, (value) => value);
exports.db = (0, knex_1.default)(database_1.knexConfig);
//# sourceMappingURL=knex.js.map