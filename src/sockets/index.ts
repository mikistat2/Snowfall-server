import { Server } from 'socket.io';
import type http from 'http';
import { verifyAccessToken } from '../utils/jwt';

let io: Server | null = null;

/**
 * One Socket.io server, one room per gym (`gym:<id>`). Clients authenticate
 * with their JWT access token in `handshake.auth.token` and only ever join
 * their own gym's room. Events: checkin:result, occupancy:update, event:new.
 */
export function initSocket(server: http.Server, corsOrigin: string | string[]): Server {
  io = new Server(server, {
    cors: { origin: corsOrigin, credentials: true },
  });

  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token as string | undefined;
      if (!token) throw new Error('missing token');
      const payload = verifyAccessToken(token);
      socket.data.gymId = payload.gymId;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    socket.join(`gym:${socket.data.gymId as number}`);
  });

  return io;
}

export function emitToGym(gymId: number, event: string, payload: unknown): void {
  io?.to(`gym:${gymId}`).emit(event, payload);
}
