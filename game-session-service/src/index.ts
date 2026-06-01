import express from 'express';
import { Chess } from 'chess.js';
import jwt from 'jsonwebtoken';
import { Kafka } from 'kafkajs';
import mysql from 'mysql2/promise';
import { createClient } from 'redis';
import { randomUUID } from 'crypto';

const service = 'game-session-service';
const port = Number(process.env.PORT || 3003);
const jwtSecret = process.env.JWT_SECRET || 'dev-secret-change-me';
const kafka = new Kafka({ clientId: service, brokers: (process.env.KAFKA_BROKERS || 'kafka:9092').split(',') });
const producer = kafka.producer();
const consumer = kafka.consumer({ groupId: `${service}-group` });
const redis = createClient({ url: process.env.REDIS_URL || `redis://${process.env.REDIS_HOST || 'redis'}:6379` });
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'mysql',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'chess_user',
  password: process.env.DB_PASSWORD || 'chess_password',
  database: process.env.DB_NAME || 'chess_games',
  waitForConnections: true
});
type AuthedRequest = express.Request & { user?: { id: string; username?: string; guest?: boolean } };

const timeControls: Record<string, { initialTimeMs: number; incrementMs: number }> = {
  blitz: { initialTimeMs: 180000, incrementMs: 0 },
  rapid: { initialTimeMs: 600000, incrementMs: 0 },
  classical: { initialTimeMs: 2700000, incrementMs: 0 }
};

function normalizeTimeControl(value: unknown) {
  return typeof value === 'string' && timeControls[value] ? value : 'rapid';
}

function guestIdFrom(req: express.Request) {
  const raw = req.body?.guestId || req.header('x-guest-id');
  const guestId = typeof raw === 'string' ? raw.trim() : '';
  return guestId.startsWith('guest-') ? guestId.slice(0, 80) : '';
}

async function initDb() {
  await pool.query(`CREATE TABLE IF NOT EXISTS games (
    id VARCHAR(36) PRIMARY KEY, white_id VARCHAR(36), black_id VARCHAR(36), status VARCHAR(20),
    fen TEXT, pgn TEXT, turn VARCHAR(10), winner_id VARCHAR(36) NULL, result VARCHAR(20) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, finished_at TIMESTAMP NULL
  )`);
  await pool.query(`ALTER TABLE games ADD COLUMN winner_id VARCHAR(36) NULL`).catch(() => undefined);
  await pool.query(`ALTER TABLE games ADD COLUMN result VARCHAR(20) NULL`).catch(() => undefined);
  await pool.query(`CREATE TABLE IF NOT EXISTS game_events (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, game_id VARCHAR(36), event_type VARCHAR(50), payload JSON,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX(game_id)
  )`);
}

function requireAuth(req: AuthedRequest, res: express.Response, next: express.NextFunction) {
  if (process.env.AUTH_REQUIRED === 'false') return next();
  const raw = req.headers.authorization?.replace('Bearer ', '');
  if (!raw) {
    const guestId = guestIdFrom(req);
    if (guestId) {
      req.user = { id: guestId, username: req.body?.guestName || guestId, guest: true };
      return next();
    }
  }
  if (!raw) {
    res.status(401).json({ error: 'missing_token' });
    return;
  }
  try {
    const decoded = jwt.verify(raw, jwtSecret) as jwt.JwtPayload;
    req.user = { id: String(decoded.sub), username: decoded.username ? String(decoded.username) : undefined };
    next();
  } catch {
    res.status(401).json({ error: 'invalid_token' });
  }
}

async function retry<T>(label: string, fn: () => Promise<T>, attempts = 30): Promise<T> {
  let lastError: unknown;
  for (let i = 1; i <= attempts; i += 1) {
    try { return await fn(); } catch (error) {
      lastError = error;
      console.log(`${label} not ready (${i}/${attempts})`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  throw lastError;
}

async function publish(topic: string, key: string, value: object) {
  await producer.send({ topic, messages: [{ key, value: JSON.stringify({ ...value, service, at: new Date().toISOString() }) }] }).catch(console.warn);
}

async function withLock<T>(key: string, ttlMs: number, fn: () => Promise<T>) {
  const token = randomUUID();
  const ok = await redis.set(key, token, { NX: true, PX: ttlMs });
  if (!ok) throw new Error('move_conflict_locked');
  try {
    return await fn();
  } finally {
    if ((await redis.get(key)) === token) await redis.del(key);
  }
}

async function createGame(event: any) {
  const initialTimeMs = Number(event.initialTimeMs || 300000);
  const incrementMs = Number(event.incrementMs || 0);
  const initialFen = new Chess().fen();
  await pool.execute('INSERT IGNORE INTO games (id, white_id, black_id, status, fen, turn) VALUES (?, ?, ?, ?, ?, ?)', [
    event.matchId, event.whiteId, event.blackId, 'active', initialFen, 'white'
  ]);
  await pool.execute('INSERT INTO game_events (game_id, event_type, payload) VALUES (?, ?, ?)', [event.matchId, 'game.created', JSON.stringify(event)]);
  await redis.hSet(`game:${event.matchId}`, {
    id: event.matchId,
    whiteId: event.whiteId,
    blackId: event.blackId,
    fen: initialFen,
    pgn: '',
    turn: 'white',
    moveNumber: '0',
    status: 'active',
    whiteTimeMs: String(initialTimeMs),
    blackTimeMs: String(initialTimeMs),
    incrementMs: String(incrementMs),
    lastTickAt: String(Date.now())
  });
  await publish('game.started', event.matchId, {
    ...event,
    gameId: event.matchId,
    fen: initialFen,
    pgn: '',
    turn: 'white',
    status: 'active',
    whiteTimeMs: initialTimeMs,
    blackTimeMs: initialTimeMs,
    incrementMs
  });
}

function colorOf(playerId: string, state: Record<string, string>) {
  if (playerId === state.whiteId) return 'white';
  if (playerId === state.blackId) return 'black';
  if (playerId === 'ai-bot') return state.turn;
  return null;
}

async function finishGame(gameId: string, state: Record<string, string>, reason: string, winnerId: string | null, result: string, patch: Record<string, string> = {}) {
  if (state.status === 'finished') return { gameId, winnerId, loserId: winnerId ? (winnerId === state.whiteId ? state.blackId : state.whiteId) : null, result, reason, fen: patch.fen || state.fen, pgn: patch.pgn || state.pgn || '' };
  const loserId = winnerId ? (winnerId === state.whiteId ? state.blackId : state.whiteId) : null;
  const finished = { gameId, winnerId, loserId, result, reason, fen: patch.fen || state.fen, pgn: patch.pgn || state.pgn || '' };
  await redis.hSet(`game:${gameId}`, { ...patch, status: 'finished', winnerId: winnerId || '', result, finishReason: reason });
  await pool.execute('UPDATE games SET fen = ?, pgn = ?, status = ?, winner_id = ?, result = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?', [
    finished.fen,
    finished.pgn,
    'finished',
    winnerId,
    result,
    gameId
  ]);
  await pool.execute('INSERT INTO game_events (game_id, event_type, payload) VALUES (?, ?, ?)', [gameId, 'game.finished', JSON.stringify(finished)]);
  await publish('game.finished', gameId, finished);
  return finished;
}

async function tickTimers() {
  const now = Date.now();
  for await (const key of redis.scanIterator({ MATCH: 'game:*', COUNT: 50 })) {
    const gameKey = String(key);
    const gameId = gameKey.replace('game:', '');
    const state = await redis.hGetAll(gameKey);
    if (!state.id || state.status !== 'active') continue;
    const lastTickAt = Number(state.lastTickAt || now);
    const elapsed = Math.max(0, now - lastTickAt);
    const turn = state.turn as 'white' | 'black';
    const whiteTimeMs = Math.max(0, Number(state.whiteTimeMs || 300000) - (turn === 'white' ? elapsed : 0));
    const blackTimeMs = Math.max(0, Number(state.blackTimeMs || 300000) - (turn === 'black' ? elapsed : 0));
    await redis.hSet(gameKey, { whiteTimeMs: String(whiteTimeMs), blackTimeMs: String(blackTimeMs), lastTickAt: String(now) });
    await publish('timer.tick', gameId, { gameId, whiteTimeMs, blackTimeMs, turn });
    if (whiteTimeMs <= 0 || blackTimeMs <= 0) {
      const winnerId = whiteTimeMs <= 0 ? state.blackId : state.whiteId;
      const result = whiteTimeMs <= 0 ? '0-1' : '1-0';
      await finishGame(gameId, { ...state, whiteTimeMs: String(whiteTimeMs), blackTimeMs: String(blackTimeMs) }, 'timeout', winnerId, result, {
        whiteTimeMs: String(whiteTimeMs),
        blackTimeMs: String(blackTimeMs),
        lastTickAt: String(now)
      }).catch(console.warn);
    }
  }
}

function applyClock(state: Record<string, string>, movingColor: 'white' | 'black') {
  const now = Date.now();
  const lastTickAt = Number(state.lastTickAt || now);
  const elapsed = Math.max(0, now - lastTickAt);
  const whiteTimeMs = Number(state.whiteTimeMs || 300000);
  const blackTimeMs = Number(state.blackTimeMs || 300000);
  const incrementMs = Number(state.incrementMs || 0);
  const nextWhite = movingColor === 'white' ? whiteTimeMs - elapsed + incrementMs : whiteTimeMs;
  const nextBlack = movingColor === 'black' ? blackTimeMs - elapsed + incrementMs : blackTimeMs;
  return { whiteTimeMs: Math.max(0, nextWhite), blackTimeMs: Math.max(0, nextBlack), now };
}

function chessFromState(state: Record<string, string>) {
  const chess = new Chess();
  if (state.pgn) {
    try {
      chess.loadPgn(state.pgn);
      return chess;
    } catch {
      // Fall back to the current FEN if stored PGN is incomplete or corrupt.
    }
  }
  return new Chess(state.fen && state.fen !== 'startpos' ? state.fen : undefined);
}

async function applyMove(gameId: string, payload: any) {
  return withLock(`lock:game:${gameId}`, 3000, async () => {
    const state = await redis.hGetAll(`game:${gameId}`);
    if (!state.id) throw new Error('game_not_found');
    if (state.status === 'finished') throw new Error('game_already_finished');
    const playerId = payload.playerId || payload.userId;
    const expectedColor = state.turn as 'white' | 'black';
    const playerColor = colorOf(playerId, state);
    if (!playerColor) throw new Error('player_not_in_game');
    if (playerColor !== expectedColor) throw new Error('not_your_turn');
    const clock = applyClock(state, expectedColor);
    if ((expectedColor === 'white' && clock.whiteTimeMs <= 0) || (expectedColor === 'black' && clock.blackTimeMs <= 0)) {
      const winnerId = expectedColor === 'white' ? state.blackId : state.whiteId;
      const result = expectedColor === 'white' ? '0-1' : '1-0';
      const finished = await finishGame(gameId, state, 'timeout', winnerId, result, {
        whiteTimeMs: String(clock.whiteTimeMs),
        blackTimeMs: String(clock.blackTimeMs),
        lastTickAt: String(clock.now)
      });
      return { finished };
    }

    const chess = chessFromState(state);
    let legalMove = null;
    try {
      legalMove = chess.move({ from: payload.from, to: payload.to, promotion: payload.promotion || 'q' });
    } catch {
      legalMove = null;
    }
    if (!legalMove) throw new Error('illegal_move');

    const moveNumber = Number(state.moveNumber || 0) + 1;
    const nextTurn = expectedColor === 'white' ? 'black' : 'white';
    const move = {
      id: payload.id || randomUUID(),
      gameId,
      moveNumber,
      playerId,
      from: payload.from,
      to: payload.to,
      san: legalMove.san,
      fen: chess.fen(),
      pgn: chess.pgn(),
      check: chess.isCheck(),
      checkmate: chess.isCheckmate()
    };
    const gameEnded = chess.isGameOver();
    const winnerId = chess.isCheckmate() ? playerId : null;
    const loserId = winnerId ? (winnerId === state.whiteId ? state.blackId : state.whiteId) : null;
    const result = chess.isCheckmate()
      ? (winnerId === state.whiteId ? '1-0' : '0-1')
      : gameEnded
        ? '1/2-1/2'
        : null;
    const finishReason = chess.isCheckmate()
      ? 'checkmate'
      : chess.isStalemate()
        ? 'stalemate'
        : chess.isDraw()
          ? 'draw'
          : chess.isGameOver()
            ? 'game_over'
            : null;

    await redis.hSet(`game:${gameId}`, {
      turn: nextTurn,
      moveNumber: String(moveNumber),
      lastMove: JSON.stringify(move),
      fen: chess.fen(),
      pgn: chess.pgn(),
      status: gameEnded ? 'finished' : 'active',
      whiteTimeMs: String(clock.whiteTimeMs),
      blackTimeMs: String(clock.blackTimeMs),
      lastTickAt: String(clock.now),
      ...(winnerId ? { winnerId } : {}),
      ...(result ? { result } : {}),
      ...(finishReason ? { finishReason } : {})
    });
    await pool.execute('INSERT INTO game_events (game_id, event_type, payload) VALUES (?, ?, ?)', [gameId, 'move.played', JSON.stringify(move)]);
    await pool.execute('UPDATE games SET fen = ?, pgn = ?, turn = ?, status = ?, winner_id = ?, result = ?, finished_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE finished_at END WHERE id = ?', [
      chess.fen(),
      chess.pgn(),
      nextTurn,
      gameEnded ? 'finished' : 'active',
      winnerId,
      result,
      gameEnded,
      gameId
    ]);
    await publish('move.played', gameId, { ...move, nextTurn, status: gameEnded ? 'finished' : 'active', whiteTimeMs: clock.whiteTimeMs, blackTimeMs: clock.blackTimeMs });

    if (gameEnded) {
      const finished = { gameId, winnerId, loserId, result, reason: finishReason, fen: chess.fen(), pgn: chess.pgn(), lastMove: move };
      await pool.execute('INSERT INTO game_events (game_id, event_type, payload) VALUES (?, ?, ?)', [gameId, 'game.finished', JSON.stringify(finished)]);
      await publish('game.finished', gameId, finished);
      return { move, nextTurn, finished };
    }

    return { move, nextTurn };
  });
}

const app = express();
app.use(express.json());
app.get('/health', (_req, res) => res.json({ service, status: 'ok' }));
app.get('/metrics', (_req, res) => res.type('text/plain').send(`service_up{service="${service}"} 1\n`));

app.post('/games', requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const timeControl = normalizeTimeControl(req.body.timeControl);
    const clock = timeControls[timeControl];
    const event = {
      matchId: randomUUID(),
      whiteId: req.body.whiteId || req.user!.id,
      blackId: req.body.blackId,
      timeControl,
      initialTimeMs: req.body.initialTimeMs || clock.initialTimeMs,
      incrementMs: req.body.incrementMs ?? clock.incrementMs
    };
    await createGame(event);
    res.status(201).json(event);
  } catch (error) { next(error); }
});

app.get('/games', requireAuth, async (req: AuthedRequest, res) => {
  const [rows] = await pool.execute(`
    SELECT
      g.id, g.white_id, g.black_id, g.status, g.result, g.winner_id, g.created_at, g.finished_at,
      COALESCE(w.username, CASE WHEN g.white_id = 'ai-bot' THEN 'Stockfish' WHEN g.white_id LIKE 'guest-%' THEN CONCAT('Guest ', RIGHT(g.white_id, 4)) ELSE g.white_id END) AS white_name,
      COALESCE(b.username, CASE WHEN g.black_id = 'ai-bot' THEN 'Stockfish' WHEN g.black_id LIKE 'guest-%' THEN CONCAT('Guest ', RIGHT(g.black_id, 4)) ELSE g.black_id END) AS black_name
    FROM games g
    LEFT JOIN chess_auth.users w ON w.id = g.white_id
    LEFT JOIN chess_auth.users b ON b.id = g.black_id
    WHERE g.white_id = ? OR g.black_id = ?
    ORDER BY g.created_at DESC
    LIMIT 30
  `, [req.user!.id, req.user!.id]);
  res.json(rows);
});

app.get('/games/:id', requireAuth, async (req, res) => {
  const state = await redis.hGetAll(`game:${req.params.id}`);
  if (Object.keys(state).length) return res.json(state);
  const [rows] = await pool.execute('SELECT * FROM games WHERE id = ?', [req.params.id]);
  res.json((rows as any[])[0] || null);
});

app.post('/games/:id/move', requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const gameId = req.params.id;
    const result = await applyMove(gameId, { ...req.body, playerId: req.user!.id });
    res.json(result);
  } catch (error) { next(error); }
});

app.post('/games/:id/resign', requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const gameId = req.params.id;
    const result = await withLock(`lock:game:${gameId}`, 3000, async () => {
      const state = await redis.hGetAll(`game:${gameId}`);
      if (!state.id) throw new Error('game_not_found');
      if (state.status === 'finished') throw new Error('game_already_finished');
      const loserColor = colorOf(req.user!.id, state);
      if (!loserColor) throw new Error('player_not_in_game');
      const winnerId = loserColor === 'white' ? state.blackId : state.whiteId;
      const resultText = loserColor === 'white' ? '0-1' : '1-0';
      return finishGame(gameId, state, 'resign', winnerId, resultText);
    });
    res.json(result);
  } catch (error) { next(error); }
});

app.post('/games/:id/draw', requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const gameId = req.params.id;
    const result = await withLock(`lock:game:${gameId}`, 3000, async () => {
      const state = await redis.hGetAll(`game:${gameId}`);
      if (!state.id) throw new Error('game_not_found');
      if (!colorOf(req.user!.id, state)) throw new Error('player_not_in_game');
      if (req.body.accept === true) return finishGame(gameId, state, 'draw_agreement', null, '1/2-1/2');
      await redis.set(`draw:${gameId}`, req.user!.id, { EX: 60 });
      await publish('draw.offered', gameId, { gameId, fromUserId: req.user!.id });
      return { offered: true };
    });
    res.json(result);
  } catch (error) { next(error); }
});

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(409).json({ error: err.message }));

async function main() {
  await Promise.all([retry('redis', () => redis.connect()), producer.connect().catch(() => undefined), consumer.connect().catch(() => undefined), retry('mysql', initDb)]);
  await consumer.subscribe({ topic: 'match.created', fromBeginning: true }).catch(() => undefined);
  await consumer.subscribe({ topic: 'move.validated', fromBeginning: false }).catch(() => undefined);
  consumer.run({ eachMessage: async ({ topic, message }) => {
    if (!message.value) return;
    const event = JSON.parse(message.value.toString());
    if (topic === 'match.created') await createGame(event);
    if (topic === 'move.validated') await applyMove(event.gameId, event).catch(console.warn);
  } }).catch(console.warn);
  setInterval(() => tickTimers().catch(console.warn), 1000);
  app.listen(port, () => console.log(`${service} listening on ${port}`));
}
main().catch((error) => { console.error(error); process.exit(1); });
