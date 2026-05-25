# Chess Viet Distributed Realtime Chess

Demo microservices cho website chơi cờ vua online realtime. Scope hiện tại đã được rút gọn để dễ demo môn Hệ thống phân tán:

- Giữ: realtime chess, JWT auth, matchmaking theo Elo, AI bot đơn giản, chat, replay, notification, Redis locking, Kafka event flow, monitoring.
- Bỏ khỏi luồng chạy chính: tournament mode và leaderboard.
- AI bot chỉ còn một chế độ đơn giản: chọn ngẫu nhiên một nước hợp lệ.

## Kiến Trúc
### Kiến trúc Microservice
<img width="1536" height="1024" alt="1" src="https://github.com/user-attachments/assets/80e44935-22a7-4bd6-a806-cf10505f9516" />

```text
Browser React/Vite
  | HTTP + Socket.IO
Nginx API Gateway
  |-- /api/auth          -> auth-service
  |-- /api/matchmaking   -> matchmaking-service
  |-- /api/games         -> game-session-service
  |-- /api/validate      -> move-validation-service
  |-- /api/chat          -> chat-service
  |-- /api/replay        -> replay-service
  |-- /api/notifications -> notification-service
  |-- /api/ai            -> ai-bot-service
  |-- /socket.io         -> websocket-service

Redis: matchmaking queue, game state cache, presence, distributed lock
Kafka: match.created, game.started, move.requested, move.validated, move.played, move.rejected, game.finished, chat.message.sent
MySQL: users, queue_events, games, game_events, chat messages
Prometheus/Grafana: scrape /metrics endpoints
```

## Service Ports

| Service | Port | Vai trò |
| --- | ---: | --- |
| frontend | 3000 | UI dark theme chơi cờ realtime |
| api-gateway | 80 | Reverse proxy entrypoint |
| auth-service | 3001 | Register/login/JWT |
| matchmaking-service | 3002 | Queue theo Elo bằng Redis sorted set |
| game-session-service | 3003 | Game state, event sourcing, Redis lock, timer |
| move-validation-service | 3004 | Validate nước đi bằng chess.js theo FEN hiện tại |
| websocket-service | 3005 | Socket.IO sync, reconnect, spectator presence |
| notification-service | 3007 | Kafka consumer notification stream |
| chat-service | 3009 | Chat persistence + Kafka event |
| replay-service | 3010 | Replay từ game_events |
| ai-bot-service | 3011 | Bot đơn giản chọn nước hợp lệ ngẫu nhiên |
| prometheus | 9090 | Metrics |
| grafana | 3008 | Dashboard, admin/admin |
| jaeger | 16686 | Tracing UI placeholder |

## Chạy Local

```bash
docker compose up --build
```

Mở:

- App: `http://localhost`
- Frontend direct: `http://localhost:3000`
- Prometheus: `http://localhost:9090`
- Grafana: `http://localhost:3008` (`admin` / `admin`)

## API Mẫu

```bash
curl -X POST http://localhost/api/auth/register \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"huy\",\"email\":\"huy@example.com\",\"password\":\"123456\"}"

curl -X POST http://localhost/api/matchmaking/queue \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d "{\"rating\":1200,\"timeControl\":\"rapid\"}"

curl -X POST http://localhost/api/games \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d "{\"blackId\":\"ai-bot\",\"initialTimeMs\":300000,\"incrementMs\":2000}"

curl -X POST http://localhost/api/ai/games/<gameId>/configure \
  -H "Content-Type: application/json" \
  -d "{\"botColor\":\"black\",\"fen\":\"startpos\"}"
```

Frontend có nút `Find Match`. Khi hai người chơi có Elo gần nhau cùng queue, service publish `match.created`, game-service tạo ván, websocket-service gửi `match:found` về cả hai client và UI tự join `matchId`.

## WebSocket Events

Client kết nối Socket.IO qua `/socket.io`.

| Event | Direction | Payload |
| --- | --- | --- |
| `game:join` | client -> server | `{ gameId, spectator?: boolean }` |
| `game:state` | server -> client | Redis game state |
| `match:found` | server -> client | `{ matchId, whiteId, blackId, color, timeControl }` |
| `game:move` | client -> server | `{ gameId, from, to, promotion? }` |
| `move.played` | server -> client | committed move from Kafka |
| `move.rejected` | server -> client | `{ gameId, reason }` |
| `game:state:patch` | server -> client | realtime state patch |
| `timer.tick` | server -> client | `{ gameId, whiteTimeMs, blackTimeMs, turn }` |
| `game.finished` | server -> client | `{ gameId, winnerId, result, reason, fen }` |
| `chat:message` | both | `{ gameId, roomId, userId, body }` |
| `presence:changed` | server -> client | `{ gameId, playersOnline, spectatorsOnline, white, black, spectators }` |

## Flow Nước Đi

1. Client emit `game:move`.
2. `websocket-service` đọc state hiện tại từ Redis, kiểm tra game active, đúng người chơi, đúng lượt, rồi publish `move.requested` kèm FEN hiện tại.
3. `move-validation-service` validate bằng `chess.js` từ FEN trong event, publish `move.validated` hoặc `move.rejected`.
4. `game-session-service` nhận `move.validated`, lấy Redis lock `lock:game:{gameId}`, validate lại bằng state authoritative, ghi `game_events`, cập nhật Redis/MySQL, publish `move.played`.
5. `websocket-service` broadcast patch về room.

## Ghi Chú Demo

Đây là scaffold demo, chưa phải production hardening. Các phần nên nâng cấp nếu triển khai thật: refresh token, Socket.IO Redis adapter khi scale nhiều websocket node, Kafka retry topic/DLQ, OpenTelemetry tracing, MySQL replication thực tế, Redis Redlock đa node và anti-cheat nâng cao.
