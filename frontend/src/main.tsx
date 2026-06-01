import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Chess } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import { io } from 'socket.io-client';
import {
  Bell,
  Bot,
  Clock,
  Eye,
  Flag,
  Handshake,
  History,
  MessageSquare,
  Shuffle,
  Swords,
  UserCircle,
  Users,
  Wifi
} from 'lucide-react';
import './styles.css';

const api = import.meta.env.VITE_API_URL || '/api';
const socket = io(import.meta.env.VITE_WS_URL || '/', { transports: ['websocket'], autoConnect: false, reconnection: true });

type User = { id: string; username: string; email?: string; rating: number; guest?: boolean };
type TimeControl = 'blitz' | 'rapid' | 'classical';
type PlayerColor = 'white' | 'black' | 'spectator';
type BotSide = 'white' | 'black' | 'random';
type PresencePerson = {
  userId: string;
  username?: string;
  role: 'white' | 'black' | 'spectator' | 'viewer';
  connections?: number;
};
type PresenceState = {
  gameId: string;
  total: number;
  playersOnline: number;
  spectatorsOnline: number;
  white: PresencePerson | null;
  black: PresencePerson | null;
  players: PresencePerson[];
  spectators: PresencePerson[];
};
type MoveTrackerItem = {
  moveNumber: number;
  playerId?: string;
  from: string;
  to: string;
  san: string;
  fen: string;
  check?: boolean;
  checkmate?: boolean;
  status?: string;
  whiteTimeMs?: number;
  blackTimeMs?: number;
};
type GamePlayers = {
  whiteId?: string;
  blackId?: string;
  whiteName?: string;
  blackName?: string;
};

const timeControlOptions: Record<TimeControl, { label: string; initialTimeMs: number; incrementMs: number }> = {
  blitz: { label: 'Blitz 3 min', initialTimeMs: 180000, incrementMs: 0 },
  rapid: { label: 'Rapid 10 min', initialTimeMs: 600000, incrementMs: 0 },
  classical: { label: 'Classical 45 min', initialTimeMs: 2700000, incrementMs: 0 }
};

const botEloOptions = [
  { elo: 400, skill: 0 },
  { elo: 800, skill: 3 },
  { elo: 1200, skill: 6 },
  { elo: 1600, skill: 10 },
  { elo: 2000, skill: 14 },
  { elo: 2400, skill: 18 }
];

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

function guestHeaders(user: User | null): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (user?.guest) {
    headers['X-Guest-Id'] = user.id;
    headers['X-Guest-Name'] = user.username;
  }
  return headers;
}

function newGuestUser(): User {
  const id = `guest-${crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
  return { id, username: `Guest ${id.slice(-4)}`, rating: 1200, guest: true };
}

function formatClock(ms: number) {
  const safe = Math.max(0, Math.floor(ms / 1000));
  const minutes = String(Math.floor(safe / 60)).padStart(2, '0');
  const seconds = String(safe % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function emptyPresence(gameId: string): PresenceState {
  return { gameId, total: 0, playersOnline: 0, spectatorsOnline: 0, white: null, black: null, players: [], spectators: [] };
}

function normalizePresence(payload: any, fallbackGameId: string): PresenceState {
  if (typeof payload === 'number') return { ...emptyPresence(fallbackGameId), total: payload };
  return {
    gameId: payload?.gameId || fallbackGameId,
    total: Number(payload?.total || 0),
    playersOnline: Number(payload?.playersOnline || 0),
    spectatorsOnline: Number(payload?.spectatorsOnline || 0),
    white: payload?.white || null,
    black: payload?.black || null,
    players: payload?.players || [],
    spectators: payload?.spectators || []
  };
}

function displayPresenceName(person?: PresencePerson | null) {
  if (!person) return 'Offline';
  const base = person.username || shortName(person.userId);
  return person.connections && person.connections > 1 ? `${base} (${person.connections})` : base;
}

function shortName(id?: string) {
  if (!id) return 'Waiting';
  if (id === 'ai-bot') return 'Stockfish';
  if (id.startsWith('guest-')) return `Guest ${id.slice(-4)}`;
  return id.slice(0, 8);
}

function materialScore(fen: string) {
  const values: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9 };
  const board = fen.split(' ')[0];
  let score = 0;
  for (const piece of board) {
    const value = values[piece.toLowerCase()];
    if (!value) continue;
    score += piece === piece.toUpperCase() ? value : -value;
  }
  return score;
}

function formatEval(score: number) {
  if (score === 0) return '0.0';
  return `${score > 0 ? '+' : ''}${score.toFixed(1)}`;
}

function isFinishedStatus(status: string) {
  return status.includes('finished') || status.includes('checkmate') || status.includes('draw') || status.includes('timeout') || status.includes('resign');
}

function notificationText(n: any) {
  const event = n.event || {};
  if (n.topic === 'friend.invited') return `Game invite from ${shortName(event.fromUserId)}`;
  if (n.topic === 'friend.requested') return `Friend request from ${shortName(event.requesterId)}`;
  if (n.topic === 'friend.responded') return `Friend request ${event.status || 'updated'}`;
  if (n.topic === 'draw.offered') return `Draw offered by ${shortName(event.fromUserId)}`;
  if (n.topic === 'game.finished') return `Game finished: ${event.result || ''} ${event.reason || ''}`.trim();
  if (n.topic === 'match.created') return `Match found: ${event.timeControl || 'rapid'}`;
  return n.topic || 'Notification';
}

function AuthScreen({
  onLogin,
  onRegister,
  onDemo,
  onGuest
}: {
  onLogin: (token: string, user: User) => void;
  onRegister: (token: string, user: User) => void;
  onDemo: () => Promise<void>;
  onGuest: () => void;
}) {
  const heroChess = useMemo(() => new Chess(), []);
  const [fen, setFen] = useState(heroChess.fen());
  const [tab, setTab] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [boardWidth, setBoardWidth] = useState(520);

  useEffect(() => {
    const resize = () => {
      const desktop = Math.min(window.innerWidth * 0.44, 520);
      const mobile = Math.min(window.innerWidth - 48, 360);
      setBoardWidth(Math.max(220, Math.floor(window.innerWidth < 760 ? mobile : desktop)));
    };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (heroChess.isGameOver()) heroChess.reset();
      const moves = heroChess.moves();
      const move = moves[Math.floor(Math.random() * moves.length)];
      if (move) heroChess.move(move);
      setFen(heroChess.fen());
    }, 900);
    return () => window.clearInterval(timer);
  }, [heroChess]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    if (tab === 'register' && password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    setLoading(true);
    try {
      const email = username.includes('@') ? username : `${username.trim()}@chess-viet.local`;
      const path = tab === 'login' ? '/auth/login' : '/auth/register';
      const body = tab === 'login' ? { email, password } : { username, email, password };
      const response = await fetch(`${api}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!response.ok) throw new Error(await response.text());
      const auth = await response.json();
      localStorage.setItem('token', auth.token);
      localStorage.setItem('user', JSON.stringify(auth.user));
      tab === 'login' ? onLogin(auth.token, auth.user) : onRegister(auth.token, auth.user);
    } catch (err: any) {
      setError(err.message || 'Authentication failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="auth-v2">
      <section className="auth-v2-hero">
        <div className="brand-lockup">
          <strong>Chess Viet</strong>
          <span>Realtime chess</span>
        </div>
        <div className="hero-board">
          <Chessboard
            position={fen}
            boardWidth={boardWidth}
            arePiecesDraggable={false}
            customDarkSquareStyle={{ backgroundColor: '#779556' }}
            customLightSquareStyle={{ backgroundColor: '#ebecd0' }}
          />
        </div>
      </section>

      <section className="auth-v2-panel">
        <form className="auth-v2-form" onSubmit={submit}>
          <h1>Play chess online</h1>
          <p>Sign in, create an account, or play as a guest.</p>

          <div className="auth-v2-tabs">
            <span style={{ left: tab === 'login' ? '0%' : '50%' }} />
            <button type="button" className={tab === 'login' ? 'active' : ''} onClick={() => setTab('login')}>
              Login
            </button>
            <button type="button" className={tab === 'register' ? 'active' : ''} onClick={() => setTab('register')}>
              Register
            </button>
          </div>

          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder={tab === 'login' ? 'Email or username' : 'Username'}
            required
          />
          <input
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Password"
            type="password"
            required
          />
          {tab === 'register' && (
            <input
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              placeholder="Confirm password"
              type="password"
              required
            />
          )}

          <button className="auth-v2-submit" disabled={loading}>
            {loading ? 'Working...' : tab === 'login' ? 'Login' : 'Create account'}
          </button>

          {error && <div className="error-message">{error}</div>}

          <div className="auth-v2-divider"><span />or<span /></div>
          <button type="button" className="auth-v2-secondary" onClick={() => void onDemo()}>
            Create demo account
          </button>
          <button type="button" className="auth-v2-secondary" onClick={onGuest}>
            Play without login
          </button>
        </form>
      </section>
    </main>
  );
}

function App() {
  const chess = useMemo(() => new Chess(), []);
  const [token, setToken] = useState(localStorage.getItem('token') || '');
  const [user, setUser] = useState<User | null>(JSON.parse(localStorage.getItem('user') || 'null'));
  const [fen, setFen] = useState(chess.fen());
  const [pgn, setPgn] = useState('');
  const [gameId, setGameId] = useState('demo-room');
  const [gamePlayers, setGamePlayers] = useState<GamePlayers>({});
  const [messages, setMessages] = useState<any[]>([]);
  const [history, setHistory] = useState<any[]>([]);
  const [replay, setReplay] = useState<any[]>([]);
  const [notifications, setNotifications] = useState<any[]>([]);
  const [notificationOpen, setNotificationOpen] = useState(false);
  const [moveTracker, setMoveTracker] = useState<MoveTrackerItem[]>([]);
  const [connected, setConnected] = useState(socket.connected);
  const [whiteTimeMs, setWhiteTimeMs] = useState(timeControlOptions.rapid.initialTimeMs);
  const [blackTimeMs, setBlackTimeMs] = useState(timeControlOptions.rapid.initialTimeMs);
  const [timeControl, setTimeControl] = useState<TimeControl>('rapid');
  const [botTimeControl, setBotTimeControl] = useState<TimeControl>('rapid');
  const [botSide, setBotSide] = useState<BotSide>('black');
  const [botElo, setBotElo] = useState(1200);
  const [gameStatus, setGameStatus] = useState('idle');
  const [matchmakingStatus, setMatchmakingStatus] = useState('Ready');
  const [searching, setSearching] = useState(false);
  const [presence, setPresence] = useState<PresenceState>(emptyPresence(gameId));
  const [playerColor, setPlayerColor] = useState<PlayerColor>('white');
  const [boardWidth, setBoardWidth] = useState(640);
  const gameIdRef = useRef(gameId);
  const gameStatusRef = useRef(gameStatus);

  useEffect(() => {
    gameStatusRef.current = gameStatus;
  }, [gameStatus]);

  useEffect(() => {
    const resize = () => {
      const sidePanel = window.innerWidth >= 1180 ? 600 : window.innerWidth >= 760 ? 260 : 36;
      setBoardWidth(Math.max(300, Math.min(640, window.innerWidth - sidePanel)));
    };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  async function request(path: string, options: RequestInit = {}) {
    const headers = new Headers(token ? authHeaders(token) : guestHeaders(user));
    if (options.headers) {
      new Headers(options.headers).forEach((value, key) => headers.set(key, value));
    }
    const res = await fetch(`${api}${path}`, {
      ...options,
      headers
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  async function demoLogin() {
    const suffix = Math.floor(Math.random() * 100000);
    const payload = { username: `demo${suffix}`, email: `demo${suffix}@chess.local`, password: '123456' };
    const auth = await fetch(`${api}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then((r) => r.json());
    localStorage.setItem('token', auth.token);
    localStorage.setItem('user', JSON.stringify(auth.user));
    setToken(auth.token);
    setUser(auth.user);
  }

  const handleAuth = (authToken: string, userData: User) => {
    setToken(authToken);
    setUser(userData);
  };

  const handleGuest = () => {
    const guest = newGuestUser();
    localStorage.removeItem('token');
    localStorage.setItem('user', JSON.stringify(guest));
    setToken('');
    setUser(guest);
  };

  function resetBoard(nextTimeControl: TimeControl = timeControl) {
    const clock = timeControlOptions[nextTimeControl].initialTimeMs;
    chess.reset();
    setFen(chess.fen());
    setPgn('');
    setMoveTracker([]);
    setWhiteTimeMs(clock);
    setBlackTimeMs(clock);
    setGamePlayers({});
    setPresence(emptyPresence(gameIdRef.current));
  }

  function updatePlayersFromState(state: any) {
    setGamePlayers((current) => ({
      whiteId: state.whiteId || state.white_id || current.whiteId,
      blackId: state.blackId || state.black_id || current.blackId,
      whiteName: state.whiteName || state.white_name || current.whiteName,
      blackName: state.blackName || state.black_name || current.blackName
    }));
  }

  function joinMatchedGame(match: any) {
    const nextGameId = match.matchId || match.gameId;
    if (!nextGameId || !user) return;
    const matchedColor = match.color || (match.whiteId === user.id ? 'white' : 'black');
    const matchedTimeControl = (match.timeControl && timeControlOptions[match.timeControl as TimeControl] ? match.timeControl : timeControl) as TimeControl;
    resetBoard(matchedTimeControl);
    setGameId(nextGameId);
    setPresence(emptyPresence(nextGameId));
    setWhiteTimeMs(Number(match.initialTimeMs || timeControlOptions[matchedTimeControl].initialTimeMs));
    setBlackTimeMs(Number(match.initialTimeMs || timeControlOptions[matchedTimeControl].initialTimeMs));
    setGamePlayers({ whiteId: match.whiteId, blackId: match.blackId });
    setPlayerColor(matchedColor);
    setSearching(false);
    setMatchmakingStatus(`Matched as ${matchedColor} (${timeControlOptions[matchedTimeControl].label})`);
    setGameStatus('active');
    socket.emit('game:join', { gameId: nextGameId });
    refreshData();
  }

  useEffect(() => {
    gameIdRef.current = gameId;
    setPresence(emptyPresence(gameId));
    if (user && socket.connected) socket.emit('game:join', { gameId });
  }, [user?.id, gameId]);

  useEffect(() => {
    if (!user) return;
    socket.auth = token ? { token } : { guestId: user.id, username: user.username };
    socket.connect();
    socket.on('connect', () => { setConnected(true); socket.emit('game:join', { gameId: gameIdRef.current }); });
    socket.on('disconnect', () => setConnected(false));
    socket.on('game:state', (state) => {
      if (state.fen) {
        chess.load(state.fen);
        setFen(state.fen);
      }
      if (state.pgn) setPgn(state.pgn);
      if (state.whiteTimeMs !== undefined) setWhiteTimeMs(Number(state.whiteTimeMs));
      if (state.blackTimeMs !== undefined) setBlackTimeMs(Number(state.blackTimeMs));
      if (state.status) setGameStatus(state.status);
      updatePlayersFromState(state);
      if (state.whiteId === user.id) setPlayerColor('white');
      if (state.blackId === user.id) setPlayerColor('black');
    });
    socket.on('move.played', (event) => {
      if (event.fen) {
        chess.load(event.fen);
        setFen(event.fen);
      }
      if (event.pgn) setPgn(event.pgn);
      if (event.san && event.from && event.to) {
        setMoveTracker((items) => {
          if (items.some((item) => item.moveNumber === Number(event.moveNumber) && item.from === event.from && item.to === event.to)) return items;
          return [...items, {
            moveNumber: Number(event.moveNumber || items.length + 1),
            playerId: event.playerId,
            from: event.from,
            to: event.to,
            san: event.san,
            fen: event.fen,
            check: event.check,
            checkmate: event.checkmate,
            status: event.status,
            whiteTimeMs: event.whiteTimeMs,
            blackTimeMs: event.blackTimeMs
          }];
        });
      }
      if (event.whiteTimeMs !== undefined) setWhiteTimeMs(Number(event.whiteTimeMs));
      if (event.blackTimeMs !== undefined) setBlackTimeMs(Number(event.blackTimeMs));
      if (event.status === 'finished') setGameStatus('finished');
    });
    socket.on('game.started', (event) => {
      const nextGameId = event.gameId || event.matchId;
      if (!nextGameId || nextGameId !== gameIdRef.current) return;
      if (event.fen) {
        chess.load(event.fen);
        setFen(event.fen);
      }
      if (event.whiteTimeMs !== undefined) setWhiteTimeMs(Number(event.whiteTimeMs));
      if (event.blackTimeMs !== undefined) setBlackTimeMs(Number(event.blackTimeMs));
      updatePlayersFromState(event);
      setGameStatus('active');
      socket.emit('game:join', { gameId: nextGameId });
    });
    socket.on('timer.tick', (event) => {
      setWhiteTimeMs(Number(event.whiteTimeMs));
      setBlackTimeMs(Number(event.blackTimeMs));
    });
    socket.on('game.finished', (event) => {
      setGameStatus(`${event.reason}: ${event.result}`);
      setNotifications((items) => [{ topic: 'game.finished', event }, ...items]);
    });
    socket.on('move.rejected', (event) => setGameStatus(`move rejected: ${event.reason}`));
    socket.on('match:found', joinMatchedGame);
    socket.on('presence:changed', (payload) => setPresence(normalizePresence(payload, gameIdRef.current)));
    socket.on('draw.offered', (event) => setNotifications((items) => [{ topic: 'draw.offered', event }, ...items]));
    socket.on('friend.invited', (event) => setNotifications((items) => [{ topic: 'friend.invited', event }, ...items]));
    socket.on('chat:message', (event) => setMessages((items) => [...items.slice(-20), event]));
    socket.emit('game:join', { gameId: gameIdRef.current });
    refreshData();
    return () => { socket.removeAllListeners(); socket.disconnect(); };
  }, [token, user?.id]);

  async function refreshData() {
    if (!user) return;
    request('/games').then(setHistory).catch(() => setHistory([]));
    request(`/notifications/${user.id}`)
      .then((items) => setNotifications(items.filter((n: any) => !['game.started', 'move.played', 'move.rejected'].includes(n.topic))))
      .catch(() => setNotifications([]));
  }

  function onDrop(sourceSquare: string, targetSquare: string) {
    if (!user || !socket.connected || isFinishedStatus(gameStatus)) return false;
    const turnColor = chess.turn() === 'w' ? 'white' : 'black';
    if (playerColor === 'spectator' || playerColor !== turnColor) {
      setGameStatus('not your turn');
      return false;
    }
    socket.emit('game:move', { gameId, from: sourceSquare, to: targetSquare, promotion: 'q' }, (ack: any) => {
      if (!ack?.accepted) setGameStatus(`move rejected: ${ack?.reason || 'unknown'}`);
    });
    return true;
  }

  async function cancelQueue() {
    if (!user) return;
    await fetch(`${api}/matchmaking/queue/${user.id}`, { method: 'DELETE' }).catch(() => undefined);
  }

  async function findMatch() {
    if (!user || searching) return;
    resetBoard(timeControl);
    setSearching(true);
    setMatchmakingStatus(`Searching ${timeControlOptions[timeControl].label}...`);
    setGameStatus('Searching...');
    try {
      await cancelQueue();
      const result = await request('/matchmaking/queue', {
        method: 'POST',
        body: JSON.stringify({ rating: user.rating || 1200, timeControl, guestId: user.guest ? user.id : undefined, guestName: user.username })
      });
      if (result.status === 'matched') joinMatchedGame(result);
      else setMatchmakingStatus(`Queued for ${timeControlOptions[timeControl].label}`);
    } catch {
      setSearching(false);
      setMatchmakingStatus('Matchmaking failed');
      setGameStatus('matchmaking failed');
    }
  }

  function watchGame() {
    if (!gameId || !socket.connected) return;
    setSearching(false);
    setMatchmakingStatus('Ready');
    setPlayerColor('spectator');
    setGameStatus('spectating');
    socket.emit('game:join', { gameId, spectator: true });
  }

  async function startAiGame() {
    if (!user) return;
    const selectedBotSide = botSide === 'random' ? (Math.random() > 0.5 ? 'white' : 'black') : botSide;
    const clock = timeControlOptions[botTimeControl];
    resetBoard(botTimeControl);
    await cancelQueue();
    setSearching(false);
    setMatchmakingStatus('Ready');
    setGameStatus('creating');
    setPlayerColor(selectedBotSide === 'black' ? 'white' : 'black');
    const body = selectedBotSide === 'black'
      ? { whiteId: user.id, blackId: 'ai-bot', timeControl: botTimeControl, initialTimeMs: clock.initialTimeMs, incrementMs: clock.incrementMs, guestId: user.guest ? user.id : undefined }
      : { whiteId: 'ai-bot', blackId: user.id, timeControl: botTimeControl, initialTimeMs: clock.initialTimeMs, incrementMs: clock.incrementMs, guestId: user.guest ? user.id : undefined };
    const game = await request('/games', { method: 'POST', body: JSON.stringify(body) });
    const nextGameId = game.matchId;
    setGameId(nextGameId);
    setGamePlayers({ whiteId: body.whiteId, blackId: body.blackId, whiteName: body.whiteId === 'ai-bot' ? 'Stockfish' : user.username, blackName: body.blackId === 'ai-bot' ? 'Stockfish' : user.username });
    socket.emit('game:join', { gameId: nextGameId });
    const skill = botEloOptions.find((level) => level.elo === botElo)?.skill ?? 6;
    await request(`/ai/games/${nextGameId}/configure`, { method: 'POST', body: JSON.stringify({ botColor: selectedBotSide, fen: chess.fen(), skill }) });
    setGameStatus(`playing Stockfish ${botElo} (${selectedBotSide})`);
  }

  async function resign() {
    await request(`/games/${gameId}/resign`, { method: 'POST', body: '{}' });
  }

  async function offerDraw() {
    await request(`/games/${gameId}/draw`, { method: 'POST', body: JSON.stringify({ offer: true }) });
  }

  async function loadReplay(id: string) {
    const data = await request(`/replay/games/${id}/replay`);
    setReplay(data.events || []);
    setGameId(id);
  }

  async function inviteFriend(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem('friendId') as HTMLInputElement;
    if (!input.value.trim()) return;
    await request('/auth/friends/invite', { method: 'POST', body: JSON.stringify({ userId: input.value.trim(), gameId }) });
    input.value = '';
    refreshData();
  }

  function sendMessage(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem('message') as HTMLInputElement;
    if (!input.value.trim()) return;
    socket.emit('chat:message', { gameId, roomId: gameId, body: input.value });
    input.value = '';
  }

  function colorName(color: 'white' | 'black') {
    const id = color === 'white' ? gamePlayers.whiteId : gamePlayers.blackId;
    const name = color === 'white' ? gamePlayers.whiteName : gamePlayers.blackName;
    if (user && id === user.id) return user.username;
    if (name) return name;
    const person = color === 'white' ? presence.white : presence.black;
    return person?.username || shortName(id);
  }

  function playerCard(color: 'white' | 'black') {
    const active = chess.turn() === (color === 'white' ? 'w' : 'b') && gameStatus === 'active';
    const time = color === 'white' ? whiteTimeMs : blackTimeMs;
    return (
      <div className={`players ${active ? 'active' : ''}`}>
        <strong>{colorName(color)}</strong>
        <span><Clock size={16} /> {formatClock(time)}</span>
      </div>
    );
  }

  const boardOrientation = playerColor === 'black' ? 'black' : 'white';
  const bottomColor = boardOrientation === 'black' ? 'black' : 'white';
  const topColor = bottomColor === 'white' ? 'black' : 'white';
  const trackerRows = moveTracker.map((move) => ({
    ...move,
    color: move.playerId === gamePlayers.whiteId ? 'white' : 'black',
    side: move.playerId === gamePlayers.whiteId ? colorName('white') : colorName('black'),
    evalScore: materialScore(move.fen)
  }));
  const trackerPairs = trackerRows.reduce<Record<number, { white?: typeof trackerRows[number]; black?: typeof trackerRows[number] }>>((rows, move) => {
    const fullMove = Math.ceil(move.moveNumber / 2);
    rows[fullMove] ||= {};
    rows[fullMove][move.color as 'white' | 'black'] = move;
    return rows;
  }, {});

  function historyLabel(g: any) {
    const myColor = g.white_id === user?.id ? 'white' : 'black';
    const opponent = myColor === 'white' ? g.black_name || shortName(g.black_id) : g.white_name || shortName(g.white_id);
    const result = g.result ? ` - ${g.result}` : '';
    return `vs ${opponent}${result}`;
  }

  if (!user) return <AuthScreen onLogin={handleAuth} onRegister={handleAuth} onDemo={demoLogin} onGuest={handleGuest} />;

  return (
    <main className="shell">
      <aside className="rail">
        <h1>Chess Viet</h1>
        <button onClick={findMatch}><Swords size={18} /> Find Match</button>
        <button onClick={watchGame}><Eye size={18} /> Watch</button>
        <button onClick={startAiGame}><Bot size={18} /> AI Bot</button>
        <button onClick={() => { localStorage.clear(); location.reload(); }}><Users size={18} /> Logout</button>
      </aside>

      <section className="boardArea">
        <div className="topbar">
          <span><Wifi size={16} /> {connected ? 'Realtime online' : 'Reconnecting'}</span>
          <input value={gameId} onChange={(e) => setGameId(e.target.value)} />
          <div className="accountPill"><UserCircle size={17} /> <span>{user.username}</span></div>
          <div className="notifWrap" onMouseEnter={() => setNotificationOpen(true)} onMouseLeave={() => setNotificationOpen(false)}>
            <button className="iconButton" type="button" onClick={() => setNotificationOpen((open) => !open)}>
              <Bell size={18} />
              {notifications.length > 0 && <span>{notifications.length}</span>}
            </button>
            {notificationOpen && (
              <div className="notifPopover">
                <h3>Notifications</h3>
                {notifications.length === 0 && <p>No notifications</p>}
                {notifications.slice(0, 6).map((n, i) => (
                  <p key={n.id || i}><b>{n.topic}</b><small>{notificationText(n)}</small></p>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="gameStage">
          <div className="boardColumn">
            {playerCard(topColor)}
            <div className="board">
              <Chessboard
                position={fen}
                onPieceDrop={onDrop}
                boardOrientation={boardOrientation}
                boardWidth={boardWidth}
                customDarkSquareStyle={{ backgroundColor: '#779556' }}
                customLightSquareStyle={{ backgroundColor: '#ebecd0' }}
              />
            </div>
            {playerCard(bottomColor)}
            <div className="actionbar">
              <button onClick={resign}><Flag size={16} /> Resign</button>
              <button onClick={offerDraw}><Handshake size={16} /> Draw</button>
              <span>{gameStatus}</span>
            </div>
          </div>

          <aside className="analysisPanel">
            <h2><Swords size={18} /> Move Tracker</h2>
            <div className="tracker chessTracker">
              {trackerRows.length === 0 && <p className="emptyLine">No moves yet</p>}
              {Object.entries(trackerPairs).map(([moveNo, pair]) => (
                <div className="trackerPair" key={moveNo}>
                  <b>{moveNo}</b>
                  <span title={pair.white ? `${pair.white.side}: ${pair.white.from}-${pair.white.to}` : ''}>{pair.white?.san || ''}</span>
                  <span title={pair.black ? `${pair.black.side}: ${pair.black.from}-${pair.black.to}` : ''}>{pair.black?.san || ''}</span>
                </div>
              ))}
            </div>
            <div className="evalBox">
              <span>Material</span>
              <strong>{trackerRows.length ? formatEval(trackerRows[trackerRows.length - 1].evalScore) : '0.0'}</strong>
            </div>
          </aside>
        </div>
      </section>

      <aside className="panel">
        <section>
          <h2><Swords size={18} /> Play Online</h2>
          <label className="fieldLabel">Time control</label>
          <select value={timeControl} onChange={(e) => setTimeControl(e.target.value as TimeControl)}>
            {Object.entries(timeControlOptions).map(([value, option]) => <option key={value} value={value}>{option.label}</option>)}
          </select>
          <button className="wide" onClick={findMatch} disabled={searching}>{searching ? 'Searching...' : 'Find Match'}</button>
          <p className="statusLine">{matchmakingStatus}</p>
        </section>

        <section>
          <h2><Bot size={18} /> AI Bot</h2>
          <div className="stackedControls">
            <label className="fieldLabel">Time control</label>
            <select value={botTimeControl} onChange={(e) => setBotTimeControl(e.target.value as TimeControl)}>
              {Object.entries(timeControlOptions).map(([value, option]) => <option key={value} value={value}>{option.label}</option>)}
            </select>
            <label className="fieldLabel">Your side</label>
            <select value={botSide} onChange={(e) => setBotSide(e.target.value as BotSide)}>
              <option value="black">White</option>
              <option value="white">Black</option>
              <option value="random">Random</option>
            </select>
            <label className="fieldLabel">Bot Elo</label>
            <select value={botElo} onChange={(e) => setBotElo(Number(e.target.value))}>
              {botEloOptions.map((level) => <option key={level.elo} value={level.elo}>{level.elo}</option>)}
            </select>
            <button className="wide" onClick={startAiGame}><Shuffle size={16} /> Start Bot Game</button>
          </div>
        </section>

        <section>
          <h2><Eye size={18} /> Spectators</h2>
          <div className="presenceMeta">
            <span><Users size={15} /> {presence.playersOnline}/2</span>
            <span><Eye size={15} /> {presence.spectatorsOnline}</span>
          </div>
          <div className="presenceRows">
            <p><b>White</b><span>{displayPresenceName(presence.white)}</span></p>
            <p><b>Black</b><span>{displayPresenceName(presence.black)}</span></p>
          </div>
          <div className="presenceRows compact">
            {presence.spectators.length
              ? presence.spectators.map((person) => <p key={`${person.role}:${person.userId}`}><b>{person.role === 'viewer' ? 'Viewer' : 'Spectator'}</b><span>{displayPresenceName(person)}</span></p>)
              : <p><b>Spectators</b><span>0 online</span></p>}
          </div>
          <button className="wide secondary" onClick={watchGame}>Watch</button>
        </section>

        <section>
          <h2><History size={18} /> Match History</h2>
          <div className="list">{history.map((g) => <button key={g.id} onClick={() => loadReplay(g.id)}>{historyLabel(g)}<small>{g.status}</small></button>)}</div>
          <pre>{replay.slice(-6).map((e) => `${e.event_type}: ${JSON.stringify(e.payload).slice(0, 90)}`).join('\n')}</pre>
        </section>

        {!user.guest && (
          <section>
            <h2><Users size={18} /> Friend Invite</h2>
            <form onSubmit={inviteFriend}><input name="friendId" placeholder="Friend user id" /><button>Invite</button></form>
          </section>
        )}

        <section>
          <h2><MessageSquare size={18} /> Chat</h2>
          <div className="chat">{messages.map((m, i) => <p key={i}><b>{m.username || shortName(m.userId)}</b> {m.body}</p>)}</div>
          <form onSubmit={sendMessage}><input name="message" placeholder="Message" /><button>Send</button></form>
        </section>
      </aside>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
