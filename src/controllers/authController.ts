import type { Request, Response } from 'express';
import * as authService from '../services/authService';

export async function registerGym(req: Request, res: Response): Promise<void> {
  const result = await authService.registerGym(req.body);
  res.status(201).json(result);
}

export async function login(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body;
  res.json(await authService.login(email, password));
}

export async function refresh(req: Request, res: Response): Promise<void> {
  res.json(await authService.refresh(req.body.refreshToken));
}

export async function logout(req: Request, res: Response): Promise<void> {
  await authService.logout(req.body.refreshToken);
  res.status(204).end();
}
