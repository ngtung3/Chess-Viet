import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Chess } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import { io } from 'socket.io-client';
import {
  Bell,
  Bot,
  CalendarDays,
  Clock,
  Flag,
  Handshake,
  History,
  MessageSquare,
  Shuffle,
  Swords,
  Timer,
  UserCircle,
  Users,
  Zap,
  Wifi
} from 'lucide-react';
import { getBestMove } from './lib/chessEngine';
import './styles.css';

const api = import.meta.env.VITE_API_URL || '/api';
const socket = io(import.meta.env.VITE_WS_URL || '/', { transports: ['websocket'], autoConnect: false, reconnection: true });

type User = { id: string; username: string; email?: string; rating: number; guest?: boolean };
type TimeControl = 'blitz_3' | 'blitz_3_1' | 'blitz_5' | 'rapid_10' | 'rapid_15' | 'rapid_30' | 'daily_1' | 'daily_3' | 'daily_7';
type PlayerColor = 'white' | 'black' | 'spectator';
type BotSide = 'white' | 'black' | 'random';
type RailMode = 'match' | 'bot';
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
type AnalysisNotice = {
  id: string;
  type: 'draw' | 'system';
  message: string;
  event?: any;
};
type GamePlayers = {
  whiteId?: string;
  blackId?: string;
  whiteName?: string;
  blackName?: string;
};

const timeControlOptions: Record<TimeControl, { label: string; group: 'Blitz' | 'Rapid' | 'Daily'; initialTimeMs: number; incrementMs: number }> = {
  blitz_3: { label: '3 min', group: 'Blitz', initialTimeMs: 180000, incrementMs: 0 },
  blitz_3_1: { label: '3+1', group: 'Blitz', initialTimeMs: 180000, incrementMs: 1000 },
  blitz_5: { label: '5 min', group: 'Blitz', initialTimeMs: 300000, incrementMs: 0 },
  rapid_10: { label: '10 min', group: 'Rapid', initialTimeMs: 600000, incrementMs: 0 },
  rapid_15: { label: '15 min', group: 'Rapid', initialTimeMs: 900000, incrementMs: 0 },
  rapid_30: { label: '30 min', group: 'Rapid', initialTimeMs: 1800000, incrementMs: 0 },
  daily_1: { label: '1 day', group: 'Daily', initialTimeMs: 86400000, incrementMs: 0 },
  daily_3: { label: '3 days', group: 'Daily', initialTimeMs: 259200000, incrementMs: 0 },
  daily_7: { label: '7 days', group: 'Daily', initialTimeMs: 604800000, incrementMs: 0 }
};

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

function skillFromElo(elo: number) {
  return Math.max(0, Math.min(20, Math.round(((elo - 400) / 2000) * 20)));
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

function TimeControlIcon({ group }: { group: 'Blitz' | 'Rapid' | 'Daily' }) {
  if (group === 'Blitz') return <Zap size={15} />;
  if (group === 'Daily') return <CalendarDays size={15} />;
  return <Timer size={15} />;
}

function TimeControlPicker({ value, onChange }: { value: TimeControl; onChange: (value: TimeControl) => void }) {
  return (
    <div className="timeGrid">
      {(Object.entries(timeControlOptions) as [TimeControl, typeof timeControlOptions[TimeControl]][]).map(([key, option]) => (
        <button type="button" key={key} className={value === key ? 'active' : ''} onClick={() => onChange(key)}>
          <TimeControlIcon group={option.group} />
          <span>{option.group}</span>
          <b>{option.label}</b>
        </button>
      ))}
    </div>
  );
}

function AuthScreen({
  onLogin,
  onRegister,
  onGuest
}: {
  onLogin: (token: string, user: User) => void;
  onRegister: (token: string, user: User) => void;
  onGuest: (rating: number) => void;
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
  const [guestSetup, setGuestSetup] = useState(false);
  const [guestRating, setGuestRating] = useState(1200);

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
    let cancelled = false;
    let thinking = false;

    const playEngineMove = async () => {
      if (thinking || cancelled) return;
      thinking = true;

      try {
        if (heroChess.isGameOver()) heroChess.reset();

        const bestMove = await getBestMove(heroChess.fen(), 4);
        if (cancelled) return;

        if (bestMove && bestMove.length >= 4) {
          try {
            heroChess.move({
              from: bestMove.slice(0, 2),
              to: bestMove.slice(2, 4),
              promotion: bestMove.slice(4, 5) || 'q'
            });
          } catch {
            heroChess.reset();
          }
        }

        if (heroChess.isGameOver()) heroChess.reset();
        setFen(heroChess.fen());
      } catch {
        if (!cancelled) setFen(heroChess.fen());
      } finally {
        thinking = false;
      }
    };

    const timer = window.setInterval(() => {
      void playEngineMove();
    }, 900);

    void playEngineMove();

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
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

          <button type="button" className="guest-link" onClick={() => setGuestSetup((open) => !open)}>
            Play without login
          </button>
          {guestSetup && (
            <div className="guestSetup">
              <label>Starting Elo <strong>{guestRating}</strong></label>
              <input
                type="range"
                min="400"
                max="2400"
                step="100"
                value={guestRating}
                onChange={(event) => setGuestRating(Number(event.target.value))}
              />
              <button type="button" className="auth-v2-secondary" onClick={() => onGuest(guestRating)}>
                Continue as guest
              </button>
            </div>
          )}
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
  const [analysisNotices, setAnalysisNotices] = useState<AnalysisNotice[]>([]);
  const [connected, setConnected] = useState(socket.connected);
  const [whiteTimeMs, setWhiteTimeMs] = useState(timeControlOptions.rapid_10.initialTimeMs);
  const [blackTimeMs, setBlackTimeMs] = useState(timeControlOptions.rapid_10.initialTimeMs);
  const [timeControl, setTimeControl] = useState<TimeControl>('rapid_10');
  const [botTimeControl, setBotTimeControl] = useState<TimeControl>('rapid_10');
  const [botSide, setBotSide] = useState<BotSide>('black');
  const [botElo, setBotElo] = useState(1200);
  const [railMode, setRailMode] = useState<RailMode>('match');
  const [gameStatus, setGameStatus] = useState('idle');
  const [matchmakingStatus, setMatchmakingStatus] = useState('Ready');
  const [searching, setSearching] = useState(false);
  const [presence, setPresence] = useState<PresenceState>(emptyPresence(gameId));
  const [playerColor, setPlayerColor] = useState<PlayerColor>('white');
  const [boardWidth, setBoardWidth] = useState(640);
  const [selectedSquare, setSelectedSquare] = useState('');
  const [moveSquares, setMoveSquares] = useState<Record<string, React.CSSProperties>>({});
  const gameIdRef = useRef(gameId);
  const gameStatusRef = useRef(gameStatus);

  useEffect(() => {
    gameStatusRef.current = gameStatus;
  }, [gameStatus]);

  useEffect(() => {
    const resize = () => {
      const sidePanel = window.innerWidth >= 1180 ? 420 : window.innerWidth >= 760 ? 300 : 36;
      setBoardWidth(Math.max(340, Math.min(720, window.innerWidth - sidePanel)));
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

  const handleAuth = (authToken: string, userData: User) => {
    setToken(authToken);
    setUser(userData);
  };

  const handleGuest = (rating: number) => {
    const guest = { ...newGuestUser(), rating };
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
    setAnalysisNotices([]);
    setSelectedSquare('');
    setMoveSquares({});
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
      setSelectedSquare('');
      setMoveSquares({});
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
    socket.on('draw.offered', (event) => {
      setNotifications((items) => [{ topic: 'draw.offered', event }, ...items]);
      setAnalysisNotices((items) => [{
        id: `${Date.now()}-draw`,
        type: 'draw',
        message: `${shortName(event.fromUserId)} offered a draw`,
        event
      }, ...items.slice(0, 5)]);
    });
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

  function canMoveNow() {
    if (!user || !socket.connected || isFinishedStatus(gameStatus)) return false;
    const turnColor = chess.turn() === 'w' ? 'white' : 'black';
    if (playerColor === 'spectator' || playerColor !== turnColor) {
      setGameStatus('not your turn');
      return false;
    }
    return true;
  }

  function submitMove(sourceSquare: string, targetSquare: string) {
    if (!canMoveNow()) return false;
    socket.emit('game:move', { gameId, from: sourceSquare, to: targetSquare, promotion: 'q' }, (ack: any) => {
      if (!ack?.accepted) setGameStatus(`move rejected: ${ack?.reason || 'unknown'}`);
    });
    setSelectedSquare('');
    setMoveSquares({});
    return true;
  }

  function onDrop(sourceSquare: string, targetSquare: string) {
    return submitMove(sourceSquare, targetSquare);
  }

  function showMoveHints(square: string) {
    const moves = chess.moves({ square: square as any, verbose: true }) as any[];
    if (!moves.length) {
      setSelectedSquare('');
      setMoveSquares({});
      return false;
    }
    const styles: Record<string, React.CSSProperties> = {
      [square]: { background: 'rgba(255, 255, 0, 0.35)' }
    };
    for (const move of moves) {
      styles[move.to] = {
        background: chess.get(move.to)
          ? 'radial-gradient(circle, rgba(20, 20, 20, 0.18) 55%, transparent 58%)'
          : 'radial-gradient(circle, rgba(20, 20, 20, 0.22) 18%, transparent 20%)'
      };
    }
    setSelectedSquare(square);
    setMoveSquares(styles);
    return true;
  }

  function onSquareClick(square: string) {
    if (!canMoveNow()) return;
    if (selectedSquare && selectedSquare !== square) {
      const legal = (chess.moves({ square: selectedSquare as any, verbose: true }) as any[]).some((move) => move.to === square);
      if (legal) {
        submitMove(selectedSquare, square);
        return;
      }
    }
    showMoveHints(square);
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
    const skill = skillFromElo(botElo);
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

  function moveCountFromGame(g: any) {
    return Number(g.move_count || g.moves || g.moveNumber || 0);
  }

  function historyParticipants(g: any) {
    return {
      white: g.white_name || shortName(g.white_id),
      black: g.black_name || shortName(g.black_id)
    };
  }

  if (!user) return <AuthScreen onLogin={handleAuth} onRegister={handleAuth} onGuest={handleGuest} />;

  const hasGamePanel = gameStatus === 'active' || gameStatus.startsWith('playing Stockfish') || moveTracker.length > 0 || isFinishedStatus(gameStatus);
  const shellClass = user.guest ? 'shell guestShell' : 'shell';

  return (
    <main className={shellClass}>
      {!user.guest && (
        <aside className="rail">
          <div className="railBrand">
            <h1>Chess Viet</h1>
            <span>Realtime chess</span>
          </div>
          <div className="railModeTabs">
            <button type="button" className={railMode === 'match' ? 'active' : ''} onClick={() => setRailMode('match')}><Swords size={18} /> Find Match</button>
            <button type="button" className={railMode === 'bot' ? 'active' : ''} onClick={() => setRailMode('bot')}><Bot size={18} /> AI Bot</button>
          </div>
          <section className="railSetup">
            {railMode === 'match' ? (
              <>
                <h2><Swords size={17} /> Online Match</h2>
                <TimeControlPicker value={timeControl} onChange={setTimeControl} />
                <button className="wide" onClick={findMatch} disabled={searching}>{searching ? 'Searching...' : 'Start Search'}</button>
                <p className="statusLine">{matchmakingStatus}</p>
              </>
            ) : (
              <>
                <h2><Bot size={17} /> Bot Match</h2>
                <TimeControlPicker value={botTimeControl} onChange={setBotTimeControl} />
                <label className="fieldLabel">Your side</label>
                <select value={botSide} onChange={(e) => setBotSide(e.target.value as BotSide)}>
                  <option value="black">White</option>
                  <option value="white">Black</option>
                  <option value="random">Random</option>
                </select>
                <label className="fieldLabel">Bot Elo</label>
                <div className="eloSlider">
                  <input type="range" min="400" max="2400" step="100" value={botElo} onChange={(e) => setBotElo(Number(e.target.value))} />
                  <strong>{botElo}</strong>
                </div>
                <button className="wide" onClick={startAiGame}><Shuffle size={16} /> Start Bot Game</button>
              </>
            )}
          </section>
          <section className="railFriend">
            <h2><Users size={17} /> Friend Invite</h2>
            <form onSubmit={inviteFriend}><input name="friendId" placeholder="Friend user id" /><button>Invite</button></form>
          </section>
          <button onClick={() => { localStorage.clear(); location.reload(); }}><Users size={18} /> Logout</button>
        </aside>
      )}

      <section className="boardArea">
        <div className="topbar">
          <span><Wifi size={16} /> {connected ? 'Realtime online' : 'Reconnecting'}</span>
          {!user.guest && <div className="sessionPill"><Swords size={15} /> <span>{gameStatus === 'idle' ? 'No active game' : shortName(gameId)}</span></div>}
          <div className="accountPill"><UserCircle size={17} /> <span>{user.username}</span></div>
          {user.guest && (
            <button className="topbarButton" onClick={() => { localStorage.clear(); location.reload(); }}>Exit guest</button>
          )}
          {!user.guest && <div className="notifWrap" onMouseEnter={() => setNotificationOpen(true)} onMouseLeave={() => setNotificationOpen(false)}>
            <button className="iconButton" type="button" onClick={() => setNotificationOpen((open) => !open)}>
              <Bell size={18} />
              {notifications.length > 0 && <span>{notifications.length}</span>}
            </button>
            {notificationOpen && (
              <div className="notifPopover">
                <h3>Notifications</h3>
                {notifications.length === 0 && <p>No notifications</p>}
                {notifications.slice(0, 6).map((n, i) => (
                  <button
                    className="notifItem"
                    key={n.id || i}
                    type="button"
                    onClick={() => {
                      const nextGameId = n.event?.gameId || n.event?.matchId;
                      if (nextGameId) {
                        setGameId(nextGameId);
                        socket.emit('game:join', { gameId: nextGameId });
                      }
                      setNotificationOpen(false);
                    }}
                  >
                    <b>{n.topic}</b><small>{notificationText(n)}</small>
                  </button>
                ))}
              </div>
            )}
          </div>}
        </div>

        {user.guest && (
          <section className="guestMatchBar">
            <div>
              <h2><Swords size={18} /> Find a guest game</h2>
              <p>{matchmakingStatus}</p>
            </div>
            <TimeControlPicker value={timeControl} onChange={setTimeControl} />
            <button className="wide" onClick={findMatch} disabled={searching}>{searching ? 'Searching...' : 'Find Match'}</button>
          </section>
        )}

        <div className={`gameStage ${!hasGamePanel ? 'boardOnly' : ''}`}>
          <div className="boardColumn">
            {hasGamePanel && playerCard(topColor)}
            <div className="board">
              <Chessboard
                position={fen}
                onPieceDrop={onDrop}
                onSquareClick={onSquareClick}
                boardOrientation={boardOrientation}
                boardWidth={boardWidth}
                customSquareStyles={moveSquares}
                customDarkSquareStyle={{ backgroundColor: '#779556' }}
                customLightSquareStyle={{ backgroundColor: '#ebecd0' }}
              />
            </div>
            {hasGamePanel && playerCard(bottomColor)}
            {hasGamePanel && <div className="actionbar">
              <button onClick={resign}><Flag size={16} /> Resign</button>
              <button onClick={offerDraw}><Handshake size={16} /> Draw</button>
              <span>{gameStatus}</span>
            </div>}
            {!user.guest && (
            <section className="historyUnderBoard">
              <h2><History size={18} /> Match History</h2>
              <div className="historyStrip">
                {history.length === 0 && <p className="emptyLine">No games yet</p>}
                {history.map((g) => {
                  const players = historyParticipants(g);
                  const tc = (g.time_control || g.timeControl || 'rapid_10') as TimeControl;
                  const option = timeControlOptions[tc] || timeControlOptions.rapid_10;
                  return (
                    <button className="historyCard" key={g.id} onClick={() => loadReplay(g.id)}>
                      <span className="historyIcon"><TimeControlIcon group={option.group} /></span>
                      <span className="historyPlayers"><b>{players.white}</b><b>{players.black}</b></span>
                      <span className="historyMeta">{option.group} {option.label} · {moveCountFromGame(g)} moves · {g.status}</span>
                      <strong>{g.result || '*'}</strong>
                    </button>
                  );
                })}
              </div>
            </section>
            )}
          </div>

          {hasGamePanel && <aside className="analysisPanel" style={{ height: boardWidth }}>
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
            <div className="analysisNotices">
              {analysisNotices.map((notice) => (
                <div className={`analysisNotice ${notice.type}`} key={notice.id}>
                  <span>{notice.message}</span>
                  {notice.type === 'draw' && (
                    <button onClick={() => {
                      request(`/games/${gameId}/draw`, { method: 'POST', body: JSON.stringify({ accept: true }) });
                      setAnalysisNotices((items) => items.filter((item) => item.id !== notice.id));
                    }}>
                      Accept
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div className="analysisChat">
              <h2><MessageSquare size={18} /> Chat</h2>
              <div className="chat">{messages.map((m, i) => <p key={i}><b>{m.username || shortName(m.userId)}</b> {m.body}</p>)}</div>
              <form onSubmit={sendMessage}><input name="message" placeholder="Message" /><button>Send</button></form>
            </div>
          </aside>}
        </div>
      </section>

    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
