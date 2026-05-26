import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Chess } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import { io } from 'socket.io-client';
import { Bell, Bot, Clock, Eye, Flag, Handshake, History, MessageSquare, Swords, Users, Wifi } from 'lucide-react';
import './styles.css';

const api = import.meta.env.VITE_API_URL || '/api';
const socket = io(import.meta.env.VITE_WS_URL || '/', { transports: ['websocket'], autoConnect: false, reconnection: true });

type User = { id: string; username: string; email: string; rating: number };
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

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
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
  const base = person.username || person.userId.slice(0, 8);
  return person.connections && person.connections > 1 ? `${base} (${person.connections})` : base;
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

function AuthScreen({
  onLogin,
  onRegister,
  onDemo
}: {
  onLogin: (token: string, user: User) => void;
  onRegister: (token: string, user: User) => void;
  onDemo: () => Promise<void>;
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
      setError('Mật khẩu xác nhận không khớp');
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
          <strong>♟ Chess Viet</strong>
          <span>Hệ thống phân tán · Realtime</span>
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
          <h1>Chơi cờ vua online</h1>
          <p>Cùng hàng ngàn người chơi realtime</p>

          <div className="auth-v2-tabs">
            <span style={{ left: tab === 'login' ? '0%' : '50%' }} />
            <button type="button" className={tab === 'login' ? 'active' : ''} onClick={() => setTab('login')}>
              Đăng nhập
            </button>
            <button type="button" className={tab === 'register' ? 'active' : ''} onClick={() => setTab('register')}>
              Đăng ký
            </button>
          </div>

          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder={tab === 'login' ? 'Email hoặc tên đăng nhập' : 'Tên đăng nhập'}
            required
          />
          <input
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Mật khẩu"
            type="password"
            required
          />
          {tab === 'register' && (
            <input
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              placeholder="Xác nhận mật khẩu"
              type="password"
              required
            />
          )}

          <button className="auth-v2-submit" disabled={loading}>
            {loading ? 'Đang xử lý...' : tab === 'login' ? 'Đăng nhập' : 'Tạo tài khoản'}
          </button>

          {error && <div className="error-message">{error}</div>}

          <div className="auth-v2-divider"><span />hoặc<span /></div>
          <button type="button" className="auth-v2-secondary" onClick={() => void onDemo()}>
            Chơi bằng tài khoản demo
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
  const [messages, setMessages] = useState<any[]>([]);
  const [history, setHistory] = useState<any[]>([]);
  const [replay, setReplay] = useState<any[]>([]);
  const [notifications, setNotifications] = useState<any[]>([]);
  const [notificationOpen, setNotificationOpen] = useState(false);
  const [moveTracker, setMoveTracker] = useState<MoveTrackerItem[]>([]);
  const [connected, setConnected] = useState(socket.connected);
  const [whiteTimeMs, setWhiteTimeMs] = useState(300000);
  const [blackTimeMs, setBlackTimeMs] = useState(300000);
  const [aiColor, setAiColor] = useState<'white' | 'black'>('black');
  const [gameStatus, setGameStatus] = useState('idle');
  const [matchmakingStatus, setMatchmakingStatus] = useState('Ready');
  const [searching, setSearching] = useState(false);
  const [presence, setPresence] = useState<PresenceState>(emptyPresence(gameId));
  const [playerColor, setPlayerColor] = useState<'white' | 'black' | 'spectator'>('white');
  const gameIdRef = useRef(gameId);
  const gameStatusRef = useRef(gameStatus);

  useEffect(() => {
    gameStatusRef.current = gameStatus;
  }, [gameStatus]);

  async function request(path: string, options: RequestInit = {}) {
    const res = await fetch(`${api}${path}`, {
      ...options,
      headers: { ...(token ? authHeaders(token) : { 'Content-Type': 'application/json' }), ...(options.headers || {}) }
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

  function resetBoard() {
    chess.reset();
    setFen(chess.fen());
    setPgn('');
    setMoveTracker([]);
    setWhiteTimeMs(300000);
    setBlackTimeMs(300000);
    setPresence(emptyPresence(gameIdRef.current));
  }

  function joinMatchedGame(match: any) {
    const nextGameId = match.matchId || match.gameId;
    if (!nextGameId || !user) return;
    resetBoard();
    setGameId(nextGameId);
    setPresence(emptyPresence(nextGameId));
    setWhiteTimeMs(Number(match.initialTimeMs || 300000));
    setBlackTimeMs(Number(match.initialTimeMs || 300000));
    setPlayerColor(match.color || (match.whiteId === user.id ? 'white' : 'black'));
    setSearching(false);
    setMatchmakingStatus(`Matched as ${match.color || (match.whiteId === user.id ? 'white' : 'black')}`);
    setGameStatus('active');
    socket.emit('game:join', { gameId: nextGameId });
    refreshData();
  }

  useEffect(() => {
    gameIdRef.current = gameId;
    setPresence(emptyPresence(gameId));
    if (token && user && socket.connected) socket.emit('game:join', { gameId });
  }, [token, user?.id, gameId]);

  useEffect(() => {
    if (!token || !user) return;
    socket.auth = { token };
    socket.connect();
    socket.on('connect', () => { setConnected(true); socket.emit('game:join', { gameId: gameIdRef.current }); });
    socket.on('disconnect', () => setConnected(false));
    socket.on('game:state', (state) => {
      if (state.fen) {
        chess.load(state.fen);
        setFen(state.fen);
      }
      if (state.pgn) setPgn(state.pgn);
      if (state.whiteTimeMs) setWhiteTimeMs(Number(state.whiteTimeMs));
      if (state.blackTimeMs) setBlackTimeMs(Number(state.blackTimeMs));
      if (state.status) setGameStatus(state.status);
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
      if (event.whiteTimeMs !== undefined) setWhiteTimeMs(event.whiteTimeMs);
      if (event.blackTimeMs !== undefined) setBlackTimeMs(event.blackTimeMs);
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
      setGameStatus('active');
      socket.emit('game:join', { gameId: nextGameId });
    });
    socket.on('timer.tick', (event) => {
      setWhiteTimeMs(event.whiteTimeMs);
      setBlackTimeMs(event.blackTimeMs);
    });
    socket.on('game.finished', (event) => setGameStatus(`${event.reason}: ${event.result}`));
    socket.on('move.rejected', (event) => setGameStatus(`move rejected: ${event.reason}`));
    socket.on('match:found', joinMatchedGame);
    socket.on('presence:changed', (payload) => setPresence(normalizePresence(payload, gameIdRef.current)));
    socket.on('draw.offered', () => setNotifications((items) => [{ topic: 'draw.offered', event: { message: 'Draw offered' } }, ...items]));
    socket.on('friend.invited', (event) => setNotifications((items) => [{ topic: 'friend.invited', event }, ...items]));
    socket.on('chat:message', (event) => setMessages((items) => [...items.slice(-20), event]));
    socket.emit('game:join', { gameId: gameIdRef.current });
    refreshData();
    return () => { socket.removeAllListeners(); socket.disconnect(); };
  }, [token, user?.id]);

  async function refreshData() {
    if (!token || !user) return;
    request('/games').then(setHistory).catch(() => setHistory([]));
    request(`/notifications/${user.id}`).then(setNotifications).catch(() => setNotifications([]));
  }

  function onDrop(sourceSquare: string, targetSquare: string) {
    if (!token || !socket.connected || gameStatus.includes('finished') || gameStatus.includes('checkmate') || gameStatus.includes('draw')) return false;
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

  async function findMatch() {
    if (!user || searching) return;
    resetBoard();
    setSearching(true);
    setMatchmakingStatus('Searching...');
    setGameStatus('Searching...');
    try {
      await fetch(`${api}/matchmaking/queue/${user.id}`, { method: 'DELETE' }).catch(() => undefined);
      const result = await request('/matchmaking/queue', {
        method: 'POST',
        body: JSON.stringify({ rating: user.rating || 1200, timeControl: 'rapid' })
      });
      if (result.status === 'matched') joinMatchedGame(result);
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
    setGameStatus('spectating');
    socket.emit('game:join', { gameId, spectator: true });
  }

  async function startAiGame() {
    if (!user) return;
    resetBoard();
    await fetch(`${api}/matchmaking/queue/${user.id}`, { method: 'DELETE' }).catch(() => undefined);
    setSearching(false);
    setMatchmakingStatus('Ready');
    setGameStatus('creating');
    setPlayerColor(aiColor === 'black' ? 'white' : 'black');
    const body = aiColor === 'black'
      ? { whiteId: user.id, blackId: 'ai-bot', timeControl: 'rapid' }
      : { whiteId: 'ai-bot', blackId: user.id, timeControl: 'rapid' };
    const game = await request('/games', { method: 'POST', body: JSON.stringify(body) });
    setGameId(game.matchId);
    socket.emit('game:join', { gameId: game.matchId });
    await request(`/ai/games/${game.matchId}/configure`, { method: 'POST', body: JSON.stringify({ botColor: aiColor, fen: chess.fen() }) });
    setGameStatus(`playing Stockfish (${aiColor})`);
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
    await request('/auth/friends/invite', { method: 'POST', body: JSON.stringify({ userId: input.value, gameId }) });
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

  const trackerRows = moveTracker.map((move) => ({
    ...move,
    side: move.playerId === user?.id ? 'You' : move.playerId === 'ai-bot' ? 'Stockfish' : 'Opponent',
    evalScore: materialScore(move.fen)
  }));

  if (!token || !user) return <AuthScreen onLogin={handleAuth} onRegister={handleAuth} onDemo={demoLogin} />;

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
                  <p key={i}><b>{n.topic}</b><small>{JSON.stringify(n.event).slice(0, 90)}</small></p>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="players"><strong>Black {playerColor === 'black' ? '(you)' : ''}</strong><span><Clock size={16} /> {formatClock(blackTimeMs)}</span></div>
        <div className="board">
          <Chessboard
            position={fen}
            onPieceDrop={onDrop}
            boardOrientation={playerColor === 'black' ? 'black' : 'white'}
            boardWidth={Math.min(680, Math.max(320, window.innerWidth - 440))}
            customDarkSquareStyle={{ backgroundColor: '#779556' }}
            customLightSquareStyle={{ backgroundColor: '#ebecd0' }}
          />
        </div>
        <div className="players"><strong>{playerColor === 'white' ? user.username : 'White'}</strong><span><Clock size={16} /> {formatClock(whiteTimeMs)}</span></div>
        <div className="actionbar">
          <button onClick={resign}><Flag size={16} /> Resign</button>
          <button onClick={offerDraw}><Handshake size={16} /> Draw</button>
          <span>{gameStatus}</span>
        </div>
      </section>

      <aside className="panel">
        <section>
          <h2><Swords size={18} /> Play Online</h2>
          <button className="wide" onClick={findMatch} disabled={searching}>{searching ? 'Searching...' : 'Find Match'}</button>
          <p className="statusLine">{matchmakingStatus}</p>
        </section>

        <section>
          <h2><Bot size={18} /> AI Bot</h2>
          <div className="controls">
            <select value={aiColor} onChange={(e) => setAiColor(e.target.value as 'white' | 'black')}><option value="black">Bot black</option><option value="white">Bot white</option></select>
            <button onClick={startAiGame}>Start</button>
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
          <div className="list">{history.map((g) => <button key={g.id} onClick={() => loadReplay(g.id)}>{g.id.slice(0, 8)} {g.status} {g.result || ''}</button>)}</div>
          <pre>{replay.slice(-6).map((e) => `${e.event_type}: ${JSON.stringify(e.payload).slice(0, 90)}`).join('\n')}</pre>
        </section>

        <section>
          <h2><Swords size={18} /> Move Tracker</h2>
          <div className="tracker">
            {trackerRows.length === 0 && <p className="emptyLine">No moves yet</p>}
            {trackerRows.map((move) => (
              <div className="trackerRow" key={`${move.moveNumber}-${move.from}-${move.to}`}>
                <b>{move.moveNumber}. {move.san}</b>
                <span>{move.side} · {move.from}-{move.to}</span>
                <small>Eval {formatEval(move.evalScore)} {move.checkmate ? '· checkmate' : move.check ? '· check' : ''}</small>
              </div>
            ))}
          </div>
        </section>

        <section>
          <h2><Users size={18} /> Friend Invite</h2>
          <form onSubmit={inviteFriend}><input name="friendId" placeholder="Friend user id" /><button>Invite</button></form>
        </section>

        <section>
          <h2><MessageSquare size={18} /> Chat</h2>
          <div className="chat">{messages.map((m, i) => <p key={i}><b>{m.username || m.userId}</b> {m.body}</p>)}</div>
          <form onSubmit={sendMessage}><input name="message" placeholder="Message" /><button>Send</button></form>
        </section>
      </aside>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
