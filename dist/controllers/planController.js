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
exports.create = create;
exports.update = update;
exports.remove = remove;
const planModel = __importStar(require("../models/planModel"));
const auditLogModel = __importStar(require("../models/auditLogModel"));
const errors_1 = require("../utils/errors");
async function list(req, res) {
    res.json(await planModel.listByGym(req.auth.gymId, req.query.active === 'true'));
}
async function create(req, res) {
    const plan = await planModel.create(req.auth.gymId, req.body);
    await auditLogModel.log({
        gym_id: req.auth.gymId,
        user_id: req.auth.sub,
        action: 'plan.created',
        entity: 'plan',
        entity_id: plan.id,
    });
    res.status(201).json(plan);
}
async function update(req, res) {
    const plan = await planModel.update(req.auth.gymId, Number(req.params.id), req.body);
    if (!plan)
        throw (0, errors_1.notFound)('Plan not found');
    await auditLogModel.log({
        gym_id: req.auth.gymId,
        user_id: req.auth.sub,
        action: 'plan.updated',
        entity: 'plan',
        entity_id: plan.id,
    });
    res.json(plan);
}
/** Delete = deactivate when the plan has ever been used; hard delete otherwise. */
async function remove(req, res) {
    const id = Number(req.params.id);
    const plan = await planModel.findById(req.auth.gymId, id);
    if (!plan)
        throw (0, errors_1.notFound)('Plan not found');
    if (await planModel.isReferenced(id)) {
        await planModel.update(req.auth.gymId, id, { active: false });
        res.json({ deactivated: true });
    }
    else {
        await planModel.hardDelete(req.auth.gymId, id);
        res.json({ deleted: true });
    }
    await auditLogModel.log({
        gym_id: req.auth.gymId,
        user_id: req.auth.sub,
        action: 'plan.removed',
        entity: 'plan',
        entity_id: id,
    });
}
//# sourceMappingURL=planController.js.map