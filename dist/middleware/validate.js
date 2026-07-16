"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validate = void 0;
const errors_1 = require("../utils/errors");
/** Validates req.body (or query) against a zod schema and replaces it with the parsed value. */
const validate = (schema, target = 'body') => (req, _res, next) => {
    const result = schema.safeParse(req[target]);
    if (!result.success) {
        const first = result.error.issues[0];
        throw (0, errors_1.badRequest)(first ? `${first.path.join('.') || target}: ${first.message}` : 'Invalid input', 'validation');
    }
    if (target === 'body')
        req.body = result.data;
    else
        Object.assign(req.query, result.data);
    next();
};
exports.validate = validate;
//# sourceMappingURL=validate.js.map