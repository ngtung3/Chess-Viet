import express from 'express';
import { Kafka } from 'kafkajs';

const service = 'notification-service';
const port = Number(process.env.PORT || 3007);
const kafka = new Kafka({ clientId: service, brokers: (process.env.KAFKA_BROKERS || 'kafka:9092').split(',') });
const consumer = kafka.consumer({ groupId: `${service}-group` });
const notifications: any[] = [];

const app = express();
app.use(express.json());
app.get('/health', (_req, res) => res.json({ service, status: 'ok' }));
app.get('/metrics', (_req, res) => res.type('text/plain').send(`service_up{service="${service}"} 1\nnotifications_total ${notifications.length}\n`));
app.get('/:userId', (req, res) => res.json(notifications.filter((n) => n.userId === req.params.userId || n.toUserId === req.params.userId).slice(-50)));

function recipientsFor(topic: string, event: any) {
  const ids = new Set<string>();
  if (event.userId) ids.add(event.userId);
  if (event.toUserId) ids.add(event.toUserId);
  if (event.addresseeId) ids.add(event.addresseeId);
  if (event.requesterId && topic === 'friend.responded') ids.add(event.requesterId);
  if (event.whiteId) ids.add(event.whiteId);
  if (event.blackId) ids.add(event.blackId);
  if (event.fromUserId && topic === 'draw.offered') {
    if (event.whiteId && event.whiteId !== event.fromUserId) ids.add(event.whiteId);
    if (event.blackId && event.blackId !== event.fromUserId) ids.add(event.blackId);
  }
  return [...ids].filter(Boolean);
}

async function main() {
  await consumer.connect().catch(() => undefined);
  for (const topic of ['match.created', 'game.finished', 'draw.offered', 'friend.requested', 'friend.responded', 'friend.invited']) {
    await consumer.subscribe({ topic, fromBeginning: false }).catch(() => undefined);
  }
  consumer.run({
    eachMessage: async ({ topic, message }) => {
      if (!message.value) return;
      const event = JSON.parse(message.value.toString());
      const recipients = recipientsFor(topic, event);
      for (const userId of recipients) {
        notifications.push({ id: `${Date.now()}-${notifications.length}`, topic, userId, toUserId: event.toUserId, event, read: false });
      }
      console.log('notification', topic, event);
    }
  }).catch(console.warn);
  app.listen(port, () => console.log(`${service} listening on ${port}`));
}
main().catch((error) => { console.error(error); process.exit(1); });
