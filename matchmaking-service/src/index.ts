import express from 'express';
import jwt from 'jsonwebtoken';
import { Kafka } from 'kafkajs';
import mysql from 'mysql2/promise';
import { createClient } from 'redis';
import { randomUUID } from 'crypto';

const service = 'matchmaking-service';
const port = Number(process.env.PORT || 3002);
const jwtSecret = process.env.JWT_SECRET || 'dev-secret-change-me';
const kafka = new Kafka({ clientId: service, brokers: (process.env.KAFKA_BROKERS || 'kafka:9092').split(',') });
const producer = kafka.producer();
const redis = createClient({ url: process.env.REDIS_URL || `redis://${process.env.REDIS_HOST || 'redis'}:6379` });
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'mysql',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'chess_user',
  password: process.env.DB_PASSWORD || 'chess_password',
  database: process.env.DB_NAME || 'chess_matchmaking',
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
  await pool.query(`CREATE TABLE IF NOT EXISTS queue_events (
    id VARCHAR(36) PRIMARY KEY, user_id VARCHAR(36), rating INT, time_control VARCHAR(20),
    event_type VARCHAR(40), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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

async function matchCandidate(userId: string, rating: number, timeControl: string, poolName: string) {
  const key = `queue:${poolName}:${timeControl}`;
  const min = rating - 150;
  const max = rating + 150;
  const candidates = await redis.zRangeByScoreWithScores(key, min, max, { LIMIT: { offset: 0, count: 10 } });
  const opponent = candidates.find((c) => c.value !== userId);
  if (!opponent) return null;
  await redis.zRem(key, opponent.value);
  await redis.zRem(key, userId);
  return { opponentId: opponent.value, opponentRating: opponent.score };
}

const app = express();
app.use(express.json());
app.get('/health', (_req, res) => res.json({ service, status: 'ok' }));
app.get('/metrics', (_req, res) => res.type('text/plain').send(`service_up{service="${service}"} 1\n`));

app.post('/queue', requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const userId = req.body.userId || req.user!.id;
    const { rating = 1200 } = req.body;
    const timeControl = normalizeTimeControl(req.body.timeControl);
    const poolName = req.user?.guest ? 'guest' : 'registered';
    const key = `queue:${poolName}:${timeControl}`;
    await redis.zAdd(key, [{ score: Number(rating), value: userId }]);
    await pool.execute('INSERT INTO queue_events (id, user_id, rating, time_control, event_type) VALUES (?, ?, ?, ?, ?)', [randomUUID(), userId, rating, timeControl, 'queued']);
    const match = await matchCandidate(userId, Number(rating), timeControl, poolName);
    if (!match) return res.status(202).json({ status: 'queued', userId, rating, timeControl });
    const matchId = randomUUID();
    const clock = timeControls[timeControl];
    const event = { matchId, whiteId: userId, blackId: match.opponentId, timeControl, ...clock, pool: poolName };
    await publish('match.created', matchId, event);
    res.status(201).json({ status: 'matched', ...event });
  } catch (error) {
    next(error);
  }
});

app.delete('/queue/:userId', async (req, res) => {
  const pattern = 'queue:*';
  for await (const key of redis.scanIterator({ MATCH: pattern })) await redis.zRem(String(key), req.params.userId);
  res.json({ status: 'cancelled', userId: req.params.userId });
});

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).json({ error: err.message }));

async function main() {
  await Promise.all([retry('redis', () => redis.connect()), producer.connect().catch(() => undefined), retry('mysql', initDb)]);
  app.listen(port, () => console.log(`${service} listening on ${port}`));
}
main().catch((error) => { console.error(error); process.exit(1); });
