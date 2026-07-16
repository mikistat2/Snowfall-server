"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initSocket = initSocket;
exports.emitToGym = emitToGym;
const socket_io_1 = require("socket.io");
const jwt_1 = require("../utils/jwt");
let io = null;
/**
 * One Socket.io server, one room per gym (`gym:<id>`). Clients authenticate
 * with their JWT access token in `handshake.auth.token` and only ever join
 * their own gym's room. Events: checkin:result, occupancy:update, event:new.
 */
function initSocket(server, corsOrigin) {
    io = new socket_io_1.Server(server, {
        cors: { origin: corsOrigin, credentials: true },
    });
    io.use((socket, next) => {
        try {
            const token = socket.handshake.auth?.token;
            if (!token)
                throw new Error('missing token');
            const payload = (0, jwt_1.verifyAccessToken)(token);
            socket.data.gymId = payload.gymId;
            next();
        }
        catch {
            next(new Error('unauthorized'));
        }
    });
    io.on('connection', (socket) => {
        socket.join(`gym:${socket.data.gymId}`);
    });
    return io;
}
function emitToGym(gymId, event, payload) {
    io?.to(`gym:${gymId}`).emit(event, payload);
}
//# sourceMappingURL=index.js.map