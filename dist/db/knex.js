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
exports.db = (0, knex_1.default)(database_1.knexConfig);
//# sourceMappingURL=knex.js.map