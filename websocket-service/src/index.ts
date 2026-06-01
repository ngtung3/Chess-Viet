import express from 'express';
import http from 'http';
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { Kafka } from 'kafkajs';
import { createClient } from 'redis';

const service = 'websocket-service';
const port = Number(process.env.PORT || 3005);
const jwtSecret = process.env.JWT_SECRET || 'dev-secret-change-me';
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });
const redis = createClient({ url: process.env.REDIS_URL || `redis://${process.env.REDIS_HOST || 'redis'}:6379` });
const kafka = new Kafka({ clientId: service, brokers: (process.env.KAFKA_BROKERS || 'kafka:9092').split(',') });
const producer = kafka.producer();
const consumer = kafka.consumer({ groupId: `${service}-group` });
type SocketUser = { id: string; username?: string; guest?: boolean };
type PresenceRole = 'white' | 'black' | 'spectator' | 'viewer';
type PresenceEntry = {
  socketId: string;
  userId: string;
  username?: string;
  spectator: boolean;
  role: PresenceRole;
  connectedAt: number;
  connections: number;
};

app.get('/health', (_req, res) => res.json({ service, status: 'ok', sockets: io.engine.clientsCount }));
app.get('/metrics', (_req, res) => res.type('text/plain').send(`service_up{service="${service}"} 1\nwebsocket_clients ${io.engine.clientsCount}\n`));

function parsePresence(socketId: string, raw: string, state: Record<string, string>) {
  let parsed: { userId?: string; username?: string; spectator?: boolean; at?: number } = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }

  const userId = parsed.userId || socketId;
  const spectator = !!parsed.spectator;
  const role: PresenceRole = spectator
    ? 'spectator'
    : userId === state.whiteId
      ? 'white'
      : userId === state.blackId
        ? 'black'
        : state.id
          ? 'spectator'
          : 'viewer';

  return {
    socketId,
    userId,
    username: parsed.username,
    spectator,
    role,
    connectedAt: Number(parsed.at || Date.now()),
    connections: 1
  };
}

function dedupePresence(entries: PresenceEntry[]) {
  const byUserRole = new Map<string, PresenceEntry>();
  for (const entry of entries) {
    const key = `${entry.role}:${entry.userId}`;
    const existing = byUserRole.get(key);
    if (!existing) {
      byUserRole.set(key, entry);
      continue;
    }
    existing.connections += 1;
    existing.connectedAt = Math.min(existing.connectedAt, entry.connectedAt);
  }
  return [...byUserRole.values()].sort((a, b) => a.connectedAt - b.connectedAt);
}

async function getPresence(gameId: string) {
  const [rawPresence, state] = await Promise.all([
    redis.hGetAll(`presence:${gameId}`),
    redis.hGetAll(`game:${gameId}`)
  ]);
  const entries = dedupePresence(Object.entries(rawPresence).map(([socketId, raw]) => parsePresence(socketId, raw, state)));
  const players = entries.filter((entry) => entry.role === 'white' || entry.role === 'black');
  const spectators = entries.filter((entry) => entry.role === 'spectator' || entry.role === 'viewer');
  return {
    gameId,
    total: entries.length,
    playersOnline: players.length,
    spectatorsOnline: spectators.length,
    white: entries.find((entry) => entry.role === 'white') || null,
    black: entries.find((entry) => entry.role === 'black') || null,
    players,
    spectators
  };
}

async function emitPresence(gameId: string) {
  io.to(`game:${gameId}`).emit('presence:changed', await getPresence(gameId));
}

async function leaveGameRooms(socket: Socket, keepGameId?: string) {
  const rooms = [...socket.rooms].filter((room) => room.startsWith('game:'));
  for (const room of rooms) {
    const gameId = room.replace('game:', '');
    if (gameId === keepGameId) continue;
    socket.leave(room);
    await redis.hDel(`presence:${gameId}`, socket.id);
    await emitPresence(gameId);
  }
}

io.use((socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  const rawGuestId = socket.handshake.auth?.guestId || socket.handshake.query?.guestId;
  const guestId = typeof rawGuestId === 'string' && rawGuestId.startsWith('guest-') ? rawGuestId.slice(0, 80) : '';
  if (!token && guestId) {
    socket.data.user = {
      id: guestId,
      username: String(socket.handshake.auth?.username || socket.handshake.query?.username || guestId).slice(0, 80),
      guest: true
    } satisfies SocketUser;
    return next();
  }
  if (!token && process.env.AUTH_REQUIRED === 'false') {
    socket.data.user = { id: `guest-${socket.id}`, guest: true } satisfies SocketUser;
    return next();
  }
  if (!token) return next(new Error('missing_token'));
  try {
    const decoded = jwt.verify(String(token), jwtSecret) as jwt.JwtPayload;
    socket.data.user = { id: String(decoded.sub), username: decoded.username ? String(decoded.username) : undefined } satisfies SocketUser;
    next();
  } catch {
    next(new Error('invalid_token'));
  }
});

io.on('connection', (socket) => {
  const authedUser = socket.data.user as SocketUser;
  socket.join(`user:${authedUser.id}`);

  socket.on('game:join', async ({ gameId, spectator }) => {
    const nextGameId = String(gameId || '');
    if (!nextGameId) return;
    await leaveGameRooms(socket, nextGameId);
    socket.join(`game:${nextGameId}`);
    await redis.hSet(`presence:${nextGameId}`, socket.id, JSON.stringify({ userId: authedUser.id, username: authedUser.username, spectator: !!spectator, at: Date.now() }));
    const state = await redis.hGetAll(`game:${nextGameId}`);
    socket.emit('game:state', state);
    await emitPresence(nextGameId);
  });

  socket.on('game:move', async (payload, ack) => {
    const gameId = String(payload.gameId || '');
    const state = await redis.hGetAll(`game:${gameId}`);
    if (!state.id) {
      const rejected = { gameId, reason: 'game_not_found' };
      socket.emit('move.rejected', rejected);
      ack?.({ accepted: false, ...rejected });
      return;
    }
    if (state.status !== 'active') {
      const rejected = { gameId, reason: 'game_not_active' };
      socket.emit('move.rejected', rejected);
      ack?.({ accepted: false, ...rejected });
      return;
    }

    const playerColor = authedUser.id === state.whiteId ? 'white' : authedUser.id === state.blackId ? 'black' : null;
    if (!playerColor) {
      const rejected = { gameId, reason: 'player_not_in_game' };
      socket.emit('move.rejected', rejected);
      ack?.({ accepted: false, ...rejected });
      return;
    }
    if (playerColor !== state.turn) {
      const rejected = { gameId, reason: 'not_your_turn' };
      socket.emit('move.rejected', rejected);
      ack?.({ accepted: false, ...rejected });
      return;
    }

    const event = {
      gameId,
      playerId: authedUser.id,
      from: payload.from,
      to: payload.to,
      promotion: payload.promotion || 'q',
      fen: state.fen,
      moveNumber: state.moveNumber,
      socketId: socket.id,
      at: new Date().toISOString()
    };
    try {
      await producer.send({ topic: 'move.requested', messages: [{ key: gameId, value: JSON.stringify(event) }] });
      ack?.({ accepted: true, queued: true });
    } catch (error) {
      console.warn(error);
      const rejected = { gameId, reason: 'message_queue_unavailable' };
      socket.emit('move.rejected', rejected);
      ack?.({ accepted: false, ...rejected });
    }
  });

  socket.on('chat:message', async (payload) => {
    const event = { ...payload, userId: authedUser.id, username: authedUser.username, body: String(payload.body || '').slice(0, 500) };
    await producer.send({ topic: 'chat.message.sent', messages: [{ key: event.roomId || event.gameId, value: JSON.stringify(event) }] }).catch(console.warn);
    io.to(`game:${event.gameId}`).emit('chat:message', event);
  });

  socket.on('disconnecting', async () => {
    for (const room of socket.rooms) {
      if (room.startsWith('game:')) {
        const gameId = room.replace('game:', '');
        await redis.hDel(`presence:${gameId}`, socket.id);
        await emitPresence(gameId);
      }
    }
  });
});

async function main() {
  await Promise.all([redis.connect(), producer.connect().catch(() => undefined), consumer.connect().catch(() => undefined)]);
  await consumer.subscribe({ topic: 'move.played', fromBeginning: false }).catch(() => undefined);
  await consumer.subscribe({ topic: 'move.rejected', fromBeginning: false }).catch(() => undefined);
  await consumer.subscribe({ topic: 'match.created', fromBeginning: false }).catch(() => undefined);
  await consumer.subscribe({ topic: 'game.started', fromBeginning: false }).catch(() => undefined);
  await consumer.subscribe({ topic: 'game.finished', fromBeginning: false }).catch(() => undefined);
  await consumer.subscribe({ topic: 'timer.tick', fromBeginning: false }).catch(() => undefined);
  await consumer.subscribe({ topic: 'draw.offered', fromBeginning: false }).catch(() => undefined);
  await consumer.subscribe({ topic: 'friend.invited', fromBeginning: false }).catch(() => undefined);
  consumer.run({
    eachMessage: async ({ topic, message }) => {
      if (!message.value) return;
      const event = JSON.parse(message.value.toString());
      if (topic === 'move.rejected' && event.socketId) {
        io.to(event.socketId).emit(topic, event);
        return;
      }
      if (topic === 'match.created') {
        io.to(`user:${event.whiteId}`).emit('match:found', { ...event, color: 'white' });
        io.to(`user:${event.blackId}`).emit('match:found', { ...event, color: 'black' });
        return;
      }
      if (topic === 'friend.invited') {
        io.to(`user:${event.toUserId || event.userId}`).emit(topic, event);
      }
      const gameId = event.gameId || event.matchId;
      io.to(`game:${gameId}`).emit(topic, event);
      if (topic === 'game.started') await emitPresence(gameId);
      if (topic === 'move.played') io.to(`game:${event.gameId}`).emit('game:state:patch', event);
    }
  }).catch(console.warn);
  server.listen(port, () => console.log(`${service} listening on ${port}`));
}
main().catch((error) => { console.error(error); process.exit(1); });
