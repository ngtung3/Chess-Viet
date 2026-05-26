import express from 'express';
import { Chess } from 'chess.js';
import { Kafka } from 'kafkajs';
const initStockfish = require('stockfish');

const service = 'ai-bot-service';
const port = Number(process.env.PORT || 3011);
const kafka = new Kafka({ clientId: service, brokers: (process.env.KAFKA_BROKERS || 'kafka:9092').split(',') });
const producer = kafka.producer();
const consumer = kafka.consumer({ groupId: `${service}-group` });
const app = express();

type BotConfig = { botColor: 'white' | 'black'; playerId: string; skill: number };

const botGames = new Map<string, BotConfig>();
let stockfishPromise: Promise<any> | null = null;
let stockfishQueue: Promise<unknown> = Promise.resolve();

app.use(express.json());
app.get('/health', (_req, res) => res.json({ service, status: 'ok' }));
app.get('/metrics', (_req, res) => res.type('text/plain').send(`service_up{service="${service}"} 1\n`));

function normalizeFen(fen?: string) {
  return !fen || fen === 'startpos' ? undefined : fen;
}

function safeChess(fen?: string) {
  try {
    return new Chess(normalizeFen(fen));
  } catch {
    return new Chess();
  }
}

function chooseSimpleMove(chess: Chess) {
  const moves = chess.moves({ verbose: true });
  if (!moves.length) return null;
  return moves[Math.floor(Math.random() * moves.length)];
}

function getStockfish() {
  if (!stockfishPromise) {
    stockfishPromise = initStockfish('lite-single').then((engine: any) => {
      engine.sendCommand('uci');
      engine.sendCommand('isready');
      return engine;
    });
  }
  return stockfishPromise;
}

async function bestMoveFromStockfish(fen: string, skill: number) {
  stockfishQueue = stockfishQueue.catch(() => undefined).then(async () => {
    const engine = await getStockfish();
    return new Promise<string | null>((resolve) => {
      const timeout = setTimeout(() => {
        engine.listener = undefined;
        resolve(null);
      }, 1800);

      engine.listener = (line: string) => {
        if (!line.startsWith('bestmove ')) return;
        clearTimeout(timeout);
        engine.listener = undefined;
        const move = line.split(/\s+/)[1];
        resolve(move && move !== '(none)' ? move : null);
      };

      const safeSkill = Math.max(0, Math.min(20, Number(skill || 8)));
      engine.sendCommand(`setoption name Skill Level value ${safeSkill}`);
      engine.sendCommand(`position fen ${fen}`);
      engine.sendCommand('go depth 8');
    });
  });
  return stockfishQueue as Promise<string | null>;
}

async function chooseStockfishMove(chess: Chess, skill: number) {
  const uci = await bestMoveFromStockfish(chess.fen(), skill).catch(() => null);
  if (!uci || uci.length < 4) return chooseSimpleMove(chess);
  const preview = safeChess(chess.fen());
  const move = preview.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4, 5) || 'q' });
  return move || chooseSimpleMove(chess);
}

async function publishMove(gameId: string, fen: string | undefined, config: BotConfig) {
  const chess = safeChess(fen);
  if (chess.isGameOver()) return { gameOver: true, fen: chess.fen() };

  const expectedTurn = config.botColor === 'white' ? 'w' : 'b';
  if (chess.turn() !== expectedTurn) return { waiting: true, fen: chess.fen() };

  const move = await chooseStockfishMove(chess, config.skill);
  if (!move) return { gameOver: true, fen: chess.fen() };

  const payload = {
    gameId,
    playerId: config.playerId,
    from: move.from,
    to: move.to,
    promotion: move.promotion || 'q',
    san: move.san,
    fen: chess.fen()
  };
  await producer.send({ topic: 'move.requested', messages: [{ key: gameId, value: JSON.stringify(payload) }] }).catch(console.warn);
  return { ...payload, mode: 'stockfish', botColor: config.botColor };
}

app.get('/levels', (_req, res) => res.json([{ id: 'stockfish', label: 'Stockfish 18 lite single-threaded' }]));

app.post('/games/:gameId/configure', async (req, res) => {
  const config: BotConfig = {
    botColor: req.body.botColor === 'white' ? 'white' : 'black',
    playerId: req.body.playerId || 'ai-bot',
    skill: Number(req.body.skill || 8)
  };
  botGames.set(req.params.gameId, config);
  const firstMove = await publishMove(req.params.gameId, req.body.fen, config);
  res.status(201).json({ gameId: req.params.gameId, ...config, mode: 'stockfish', firstMove });
});

app.post('/move', async (req, res) => {
  const config: BotConfig = {
    botColor: req.body.color === 'white' ? 'white' : req.body.color === 'black' ? 'black' : safeChess(req.body.fen).turn() === 'w' ? 'white' : 'black',
    playerId: req.body.playerId || 'ai-bot',
    skill: Number(req.body.skill || 8)
  };
  res.json(await publishMove(req.body.gameId, req.body.fen, config));
});

async function main() {
  await Promise.all([producer.connect().catch(() => undefined), consumer.connect().catch(() => undefined)]);
  await consumer.subscribe({ topic: 'game.started', fromBeginning: false }).catch(() => undefined);
  await consumer.subscribe({ topic: 'move.played', fromBeginning: false }).catch(() => undefined);
  await consumer.subscribe({ topic: 'game.finished', fromBeginning: false }).catch(() => undefined);
  consumer.run({
    eachMessage: async ({ topic, message }) => {
      if (!message.value) return;
      const event = JSON.parse(message.value.toString());
      const gameId = event.gameId || event.matchId;
      if (!gameId) return;
      if (topic === 'game.finished') {
        botGames.delete(gameId);
        return;
      }
      const config = botGames.get(gameId);
      if (config) await publishMove(gameId, event.fen, config);
    }
  }).catch(console.warn);
  app.listen(port, () => console.log(`${service} listening on ${port}`));
}

main().catch((error) => { console.error(error); process.exit(1); });
