import express from 'express';
import { Chess } from 'chess.js';
import { Kafka } from 'kafkajs';

const service = 'move-validation-service';
const port = Number(process.env.PORT || 3004);
const kafka = new Kafka({ clientId: service, brokers: (process.env.KAFKA_BROKERS || 'kafka:9092').split(',') });
const producer = kafka.producer();
const consumer = kafka.consumer({ groupId: `${service}-group` });
const boards = new Map<string, Chess>();

function chessFromFen(fen?: string) {
  try {
    return fen && fen !== 'startpos' ? new Chess(fen) : new Chess();
  } catch {
    return new Chess();
  }
}

const app = express();
app.use(express.json());
app.get('/health', (_req, res) => res.json({ service, status: 'ok' }));
app.get('/metrics', (_req, res) => res.type('text/plain').send(`service_up{service="${service}"} 1\n`));
app.post('/validate', (req, res) => {
  const chess = chessFromFen(req.body.fen);
  let move = null;
  try {
    move = chess.move({ from: req.body.from, to: req.body.to, promotion: req.body.promotion || 'q' });
  } catch {
    move = null;
  }
  res.json({
    legal: !!move,
    fen: move ? chess.fen() : req.body.fen,
    san: move?.san,
    check: move ? chess.isCheck() : false,
    checkmate: move ? chess.isCheckmate() : false,
    draw: move ? chess.isDraw() : false,
    stalemate: move ? chess.isStalemate() : false,
    gameOver: move ? chess.isGameOver() : false
  });
});

async function publish(topic: string, key: string, value: object) {
  await producer.send({ topic, messages: [{ key, value: JSON.stringify({ ...value, service, at: new Date().toISOString() }) }] }).catch(console.warn);
}

async function main() {
  await Promise.all([producer.connect().catch(() => undefined), consumer.connect().catch(() => undefined)]);
  await consumer.subscribe({ topic: 'move.requested', fromBeginning: false }).catch(() => undefined);
  await consumer.subscribe({ topic: 'game.started', fromBeginning: false }).catch(() => undefined);
  await consumer.subscribe({ topic: 'game.finished', fromBeginning: false }).catch(() => undefined);
  consumer.run({
    eachMessage: async ({ topic, message }) => {
      if (!message.value) return;
      const event = JSON.parse(message.value.toString());
      const gameId = event.gameId || event.matchId;
      if (topic === 'game.started') {
        boards.set(gameId, chessFromFen(event.fen));
        return;
      }
      if (topic === 'game.finished') {
        boards.delete(gameId);
        return;
      }

      const chess = event.fen ? chessFromFen(event.fen) : boards.get(gameId) || new Chess();
      let move = null;
      try {
        move = chess.move({ from: event.from, to: event.to, promotion: event.promotion || 'q' });
      } catch {
        move = null;
      }
      if (!move) {
        await publish('move.rejected', gameId, { ...event, gameId, reason: 'illegal_move' });
        return;
      }
      boards.set(gameId, chess);
      await publish('move.validated', gameId, {
        ...event,
        gameId,
        san: move.san,
        fen: chess.fen(),
        check: chess.isCheck(),
        checkmate: chess.isCheckmate(),
        draw: chess.isDraw(),
        stalemate: chess.isStalemate(),
        insufficientMaterial: chess.isInsufficientMaterial(),
        threefoldRepetition: chess.isThreefoldRepetition(),
        gameOver: chess.isGameOver()
      });
    }
  }).catch(console.warn);
  app.listen(port, () => console.log(`${service} listening on ${port}`));
}
main().catch((error) => { console.error(error); process.exit(1); });
