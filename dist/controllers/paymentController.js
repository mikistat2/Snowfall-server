"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.list = list;
exports.summary = summary;
exports.amend = amend;
const paymentModel = __importStar(require("../models/paymentModel"));
const paymentService = __importStar(require("../services/paymentService"));
const pagination_1 = require("../utils/pagination");
const errors_1 = require("../utils/errors");
/** The filter both the list and the summary read, parsed once. */
function paymentFilter(req) {
    return {
        from: req.query.from,
        to: req.query.to,
        method: req.query.method,
        member_id: req.query.member_id ? Number(req.query.member_id) : undefined,
    };
}
async function list(req, res) {
    res.json(await paymentModel.list(req.auth.gymId, { ...paymentFilter(req), offset: (0, pagination_1.parseOffset)(req.query.offset) }, (0, pagination_1.parseLimit)(req.query.limit) ?? 200));
}
/**
 * Count and total for the current filter, across every matching payment.
 *
 * Separate from the list because it answers a different question and changes
 * far less often: the page fetches more rows as the reader scrolls, but the
 * headline figure is settled by the filter alone, so it is fetched once per
 * filter rather than once per page.
 */
async function summary(req, res) {
    res.json(await paymentModel.summary(req.auth.gymId, paymentFilter(req)));
}
/**
 * Correct or remove a payment. Owner-only (see the route) — staff record
 * money, only the person answerable for the books rewrites the record of it.
 *
 * `replacement` absent means "this payment should not exist at all": the row
 * is voided with nothing put in its place.
 */
async function amend(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id))
        throw (0, errors_1.notFound)('Payment not found');
    const { reason, replacement } = req.body;
    const result = await paymentService.amend({
        gymId: req.auth.gymId,
        paymentId: id,
        userId: req.auth.sub,
        reason,
        replacement,
    });
    res.json({ ok: true, ...result });
}
//# sourceMappingURL=paymentController.js.map