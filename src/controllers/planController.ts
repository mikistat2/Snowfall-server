import type { Request, Response } from 'express';
import * as planModel from '../models/planModel';
import * as auditLogModel from '../models/auditLogModel';
import { notFound } from '../utils/errors';

export async function list(req: Request, res: Response): Promise<void> {
  res.json(await planModel.listByGym(req.auth.gymId, req.query.active === 'true'));
}

export async function create(req: Request, res: Response): Promise<void> {
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

export async function update(req: Request, res: Response): Promise<void> {
  const plan = await planModel.update(req.auth.gymId, Number(req.params.id), req.body);
  if (!plan) throw notFound('Plan not found');
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
export async function remove(req: Request, res: Response): Promise<void> {
  const id = Number(req.params.id);
  const plan = await planModel.findById(req.auth.gymId, id);
  if (!plan) throw notFound('Plan not found');

  if (await planModel.isReferenced(id)) {
    await planModel.update(req.auth.gymId, id, { active: false });
    res.json({ deactivated: true });
  } else {
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
