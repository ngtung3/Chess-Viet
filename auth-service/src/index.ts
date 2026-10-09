import bcrypt from 'bcryptjs';
import cors from 'cors';
import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import jwt from 'jsonwebtoken';
import { Kafka } from 'kafkajs';
import mysql from 'mysql2/promise';
import { randomUUID } from 'crypto';

const service = 'auth-service';
const port = Number(process.env.PORT || 3001);
const jwtSecret = process.env.JWT_SECRET || 'dev-secret-change-me';
const kafka = new Kafka({ clientId: service, brokers: (process.env.KAFKA_BROKERS || 'kafka:9092').split(',') });
const producer = kafka.producer();
const consumer = kafka.consumer({ groupId: `${service}-group` });
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'mysql',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'chess_user',
  password: process.env.DB_PASSWORD || 'chess_password',
  database: process.env.DB_NAME || 'chess_auth',
  waitForConnections: true,
  connectionLimit: 10
});

type AuthedRequest = Request & { user?: { id: string; username: string } };

function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => fn(req, res, next).catch(next);
}

async function publish(topic: string, key: string, value: object) {
  try {
    await producer.send({ topic, messages: [{ key, value: JSON.stringify({ ...value, service, at: new Date().toISOString() }) }] });
  } catch (error) {
    console.warn('kafka unavailable', error);
  }
}

async function applyGameResult(payload: {
  winnerId: string | null; loserId: string | null;
  whiteId?: string; blackId?: string; result: string
}) {
  const K = 16;
  if (payload.winnerId && payload.loserId) {
    await pool.execute('UPDATE users SET rating = rating + ?, wins = wins + 1 WHERE id = ?', [K, payload.winnerId]);
    await pool.execute('UPDATE users SET rating = GREATEST(rating - ?, 0), losses = losses + 1 WHERE id = ?', [K, payload.loserId]);
    return;
  }
  // Hòa: winnerId/loserId đều null, dùng whiteId/blackId thay thế
  if (payload.whiteId) await pool.execute('UPDATE users SET draws = draws + 1 WHERE id = ?', [payload.whiteId]);
  if (payload.blackId) await pool.execute('UPDATE users SET draws = draws + 1 WHERE id = ?', [payload.blackId]);
}

function tokenFor(user: { id: string; username: string; email: string; rating: number }) {
  return jwt.sign({ sub: user.id, username: user.username, email: user.email, rating: user.rating }, jwtSecret, { expiresIn: '2h' });
}

function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const raw = req.headers.authorization?.replace('Bearer ', '');
  if (!raw) {
    res.status(401).json({ error: 'missing_token' });
    return;
  }
  try {
    const decoded = jwt.verify(raw, jwtSecret) as jwt.JwtPayload;
    req.user = { id: String(decoded.sub), username: String(decoded.username) };
    next();
  } catch {
    res.status(401).json({ error: 'invalid_token' });
  }
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(36) PRIMARY KEY,
      username VARCHAR(40) UNIQUE NOT NULL,
      email VARCHAR(160) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      rating INT NOT NULL DEFAULT 1200,
      wins INT NOT NULL DEFAULT 0,
      losses INT NOT NULL DEFAULT 0,
      draws INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`CREATE TABLE IF NOT EXISTS friends (
    id VARCHAR(36) PRIMARY KEY,
    requester_id VARCHAR(36) NOT NULL,
    addressee_id VARCHAR(36) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY unique_friend_pair (requester_id, addressee_id), 
    CONSTRAINT fk_friends_requester FOREIGN KEY (requester_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_friends_addressee FOREIGN KEY (addressee_id) REFERENCES users(id) ON DELETE CASCADE 
  )`);
}

async function retry<T>(label: string, fn: () => Promise<T>, attempts = 30): Promise<T> {
  let lastError: unknown;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      console.log(`${label} not ready (${i}/${attempts})`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  throw lastError;
}

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => res.json({ service, status: 'ok' }));
app.get('/metrics', (_req, res) => res.type('text/plain').send(`service_up{service="${service}"} 1\n`));

app.post('/register', asyncHandler(async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) {
    res.status(400).json({ error: 'username_email_password_required' });
    return;
  }
  const id = randomUUID();
  const passwordHash = await bcrypt.hash(password, 10);
  await pool.execute('INSERT INTO users (id, username, email, password_hash) VALUES (?, ?, ?, ?)', [id, username, email, passwordHash]);
  const user = { id, username, email, rating: 1200 };
  await publish('user.registered', id, user);
  res.status(201).json({ user, token: tokenFor(user) });
}));

app.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const [rows] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
  const user = (rows as any[])[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    res.status(401).json({ error: 'invalid_credentials' });
    return;
  }
  res.json({ user: { id: user.id, username: user.username, email: user.email, rating: user.rating }, token: tokenFor(user) });
}));

app.get('/me', requireAuth, asyncHandler(async (req: AuthedRequest, res) => {
  const [rows] = await pool.execute('SELECT id, username, email, rating, wins, losses, draws FROM users WHERE id = ?', [req.user!.id]);
  res.json((rows as any[])[0]);
}));

app.get('/friends', requireAuth, asyncHandler(async (req: AuthedRequest, res) => {
  const [rows] = await pool.execute('SELECT * FROM friends WHERE requester_id = ? OR addressee_id = ? ORDER BY created_at DESC', [req.user!.id, req.user!.id]);
  res.json(rows);
}));

app.post('/friends/request', requireAuth, asyncHandler(async (req: AuthedRequest, res) => {
  const addresseeId = req.body.userId;
  if (!addresseeId || addresseeId === req.user!.id) {
    res.status(400).json({ error: 'valid_userId_required' });
    return;
  }
  const id = randomUUID();
  await pool.execute('INSERT IGNORE INTO friends (id, requester_id, addressee_id, status) VALUES (?, ?, ?, ?)', [id, req.user!.id, addresseeId, 'pending']);
  const event = { id, requesterId: req.user!.id, addresseeId, userId: addresseeId };
  await publish('friend.requested', id, event);
  res.status(201).json(event);
}));

app.post('/friends/:id/respond', requireAuth, asyncHandler(async (req: AuthedRequest, res) => {
  const status = req.body.accept ? 'accepted' : 'declined';
  await pool.execute('UPDATE friends SET status = ? WHERE id = ? AND addressee_id = ?', [status, req.params.id, req.user!.id]);
  const event = { id: req.params.id, userId: req.user!.id, status };
  await publish('friend.responded', req.params.id, event);
  res.json(event);
}));

app.post('/friends/invite', requireAuth, asyncHandler(async (req: AuthedRequest, res) => {
  const event = { id: randomUUID(), fromUserId: req.user!.id, toUserId: req.body.userId, gameId: req.body.gameId, userId: req.body.userId };
  await publish('friend.invited', event.id, event);
  res.status(201).json(event);
}));

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'internal_error', message: err.message });
});

async function main() {
  await retry('mysql', initDb);
  app.listen(port, () => console.log(`${service} listening on ${port}`));
  await producer.connect().catch(() => undefined);
  await consumer.connect().catch(() => undefined);
  await consumer.subscribe({ topic: 'game.finished', fromBeginning: false });
  await consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      try {
        const payload = JSON.parse(message.value.toString());
        await applyGameResult(payload);
      } catch (error) {
        console.warn('failed to apply game result', error);
      }
    }
  });
}

async function shutdown() {
  await consumer.disconnect().catch(() => undefined);
  await producer.disconnect().catch(() => undefined);
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

main().catch((error) => {
  console.error(error);
  process.exit(1);
});