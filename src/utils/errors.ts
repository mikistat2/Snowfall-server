export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (msg: string, code?: string) => new AppError(400, msg, code);
export const unauthorized = (msg = 'Unauthorized') => new AppError(401, msg);
export const forbidden = (msg = 'Forbidden', code?: string) => new AppError(403, msg, code);
export const notFound = (msg = 'Not found') => new AppError(404, msg);
export const conflict = (msg: string) => new AppError(409, msg);
