import express from 'express';
import jwt from 'jsonwebtoken';
import { Kafka } from 'kafkajs';
import mysql from 'mysql2/promise';
import { randomUUID } from 'crypto';

const service = 'chat-service';
const port = Number(process.env.PORT || 3009);
const jwtSecret = process.env.JWT_SECRET || 'dev-secret-change-me';
const kafka = new Kafka({ clientId: service, brokers: (process.env.KAFKA_BROKERS || 'kafka:9092').split(',') });
const producer = kafka.producer();
const consumer = kafka.consumer({ groupId: `${service}-group` });
const pool = mysql.createPool({ host: process.env.DB_HOST || 'mysql', user: process.env.DB_USER || 'chess_user', password: process.env.DB_PASSWORD || 'chess_password', database: process.env.DB_NAME || 'chess_chat' });
type AuthedRequest = express.Request & { user?: { id: string; username?: string } };

async function initDb() {
  await pool.query(`CREATE TABLE IF NOT EXISTS messages (
    id VARCHAR(36) PRIMARY KEY, room_id VARCHAR(80), user_id VARCHAR(80), username VARCHAR(80) NULL,
    body VARCHAR(500), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX(room_id)
  )`);
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

const app = express();
app.use(express.json());
function requireAuth(req: AuthedRequest, res: express.Response, next: express.NextFunction) {
  if (process.env.AUTH_REQUIRED === 'false') return next();
  const raw = req.headers.authorization?.replace('Bearer ', '');
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
app.get('/health', (_req, res) => res.json({ service, status: 'ok' }));
app.get('/metrics', (_req, res) => res.type('text/plain').send(`service_up{service="${service}"} 1\n`));
app.get('/rooms/:roomId/messages', requireAuth, async (req, res) => {
  const [rows] = await pool.execute('SELECT * FROM messages WHERE room_id = ? ORDER BY created_at DESC LIMIT 100', [req.params.roomId]);
  res.json(rows);
});
app.post('/rooms/:roomId/messages', requireAuth, async (req: AuthedRequest, res) => {
  const id = randomUUID();
  await pool.execute('INSERT INTO messages (id, room_id, user_id, body) VALUES (?, ?, ?, ?)', [id, req.params.roomId, req.user!.id, req.body.body]);
  const event = { id, roomId: req.params.roomId, userId: req.user!.id, body: req.body.body };
  await producer.send({ topic: 'chat.message.sent', messages: [{ key: req.params.roomId, value: JSON.stringify(event) }] }).catch(console.warn);
  res.status(201).json(event);
});

async function main() {
  await retry('mysql', initDb);
  await retry('kafka', async () => { await producer.connect(); await consumer.connect(); });
  await consumer.subscribe({ topic: 'chat.message.sent', fromBeginning: false });
  await consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      try {
        const event = JSON.parse(message.value.toString());
        await pool.execute(
          'INSERT IGNORE INTO messages (id, room_id, user_id, username, body) VALUES (?, ?, ?, ?, ?)',
          [event.id || randomUUID(), event.roomId || event.gameId, event.userId, event.username || null, String(event.body || '').slice(0, 500)]
        );
      } catch (error) { console.error('chat save failed', error); }
    }
  });
  app.listen(port, () => console.log(`${service} listening on ${port}`));
}
main().catch((error) => { console.error(error); process.exit(1); });