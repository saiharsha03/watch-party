import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { startScore, setScoreDelay, getScoreDelay } from './score.js';
import { createAuto } from './auto.js';
import { getIceServers } from './ice.js';
import { preState, prePoints, handlePre, autoResolvePre, lockPicks, myPicks, QUESTIONS } from './prematch.js';

const REACTIONS = ['4️⃣', '6️⃣', '☝️', '😩', '🔥', '🥇', '🇮🇳', '🇵🇰'];
// Only a browser on the host PC itself may host; tunnel visitors arrive with the tunnel hostname.
const LOCAL_HOST = /^(localhost|127\.0\.0\.1)(:\d+)?$/i;
// ...and the page itself must come from there too, so another website open in the host's browser can't host.
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

// Only the page itself may open a socket: the Origin's host must equal the Host it was served from
// (the tunnel hostname for friends, localhost for the host), so another website can't join through a visitor's browser.
function originAllowed(req) {
  try {
    return new URL(req.headers.origin).host.toLowerCase() === String(req.headers.host || '').toLowerCase();
  } catch {
    return false;
  }
}

const wss = new WebSocketServer({
  port: Number(process.env.PORT) || 8080,
  path: '/ws',
  maxPayload: 64 * 1024,
  verifyClient: ({ req }, done) => (originAllowed(req) ? done(true) : done(false, 403, 'Origin not allowed')),
});
const clients = new Map(); // id -> { ws, name, role, local, bucket }
let hostId = null;
let live = false;
let score = null;

const send = (c, msg) => c?.ws.readyState === 1 && c.ws.send(JSON.stringify(msg));
const broadcast = (msg) => clients.forEach((c) => c.role && send(c, msg));
const people = () =>
  broadcast({
    t: 'people',
    list: [...clients].filter(([, c]) => c.role).map(([id, c]) => ({ id, name: c.name, role: c.role, inCall: c.inCall, cam: c.cam })),
  });

const CELEBRATIONS = ['four', 'six', 'wicket', 'win'];
const TEAM = (process.env.MATCH_TEAM || 'India').toLowerCase();
let lastCelebration = 0;
function celebrate(kind, name, auto = false) {
  if (!auto && Date.now() - lastCelebration < 4000) return; // one party moment at a time
  lastCelebration = Date.now();
  broadcast({ t: 'celebrate', kind, name, auto });
}

// Score feeds only give totals, so this works from the change between two updates:
// an opponent wicket, or India's total jumping by exactly 4 or 6 with no wicket (almost always a boundary
// when updates are ~30 s apart, i.e. about one ball).
const AUTO_BOUNDARIES = (process.env.AUTO_BOUNDARIES ?? 'true') !== 'false';
function autoCelebrate(prev, next) {
  if (!prev || prev.error || next.error) return;
  for (const inn of next.innings) {
    const old = prev.innings.find((i) => i.label === inn.label);
    if (!old) continue;
    const ours = (inn.label || '').toLowerCase().includes(TEAM);
    if (!ours && inn.w > old.w) return celebrate('wicket', 'Scoreboard', true);
    if (ours && AUTO_BOUNDARIES && inn.w === old.w) {
      if (inn.r - old.r === 6) return celebrate('six', 'Scoreboard', true);
      if (inn.r - old.r === 4) return celebrate('four', 'Scoreboard', true);
    }
  }
  if (!prev.ended && next.ended && (next.status || '').toLowerCase().startsWith(`${TEAM} won`)) celebrate('win', 'Scoreboard', true);
}

function allow(c) {
  const now = Date.now();
  c.bucket = c.bucket.filter((t) => now - t < 2000);
  if (c.bucket.length >= 8) return false;
  c.bucket.push(now);
  return true;
}

// Signaling and call-state messages get their own, far more generous limit. It exists only to protect the
// server from floods; ICE gathering can send dozens of messages a second at connect time, which must pass.
function allowSignal(c) {
  const now = Date.now();
  c.sigBucket = c.sigBucket.filter((t) => now - t < 1000);
  if (c.sigBucket.length >= 300) return false;
  c.sigBucket.push(now);
  return true;
}

// ---------- prediction game: guess the runs in an over ----------
// Kept in memory: a server restart resets the leaderboard.
let round = null; // { over, phase: 'open'|'locked'|'done', guesses: Map(id -> { name, guess }), actual, winners }
const points = new Map(); // id -> { name, pts }

function predState() {
  const r = round && {
    over: round.over,
    phase: round.phase,
    count: round.guesses.size,
    guessed: [...round.guesses.values()].map((g) => g.name),
    // guesses stay hidden until the host locks the over
    guesses: round.phase === 'open' ? null : [...round.guesses.values()].sort((a, b) => a.guess - b.guess),
    actual: round.actual ?? null,
    winners: round.winners || [],
  };
  // One leaderboard: correct over guesses + correct match picks.
  const merged = new Map([...points].map(([id, p]) => [id, { ...p }]));
  for (const [id, p] of prePoints()) {
    const row = merged.get(id) || { name: p.name, pts: 0 };
    row.pts += p.pts;
    merged.set(id, row);
  }
  const board = [...merged].map(([id, p]) => ({ id, name: p.name, pts: p.pts })).sort((a, b) => b.pts - a.pts);
  return { t: 'pred', round: r, board, pre: preState() };
}

// Match picks lock themselves at kickoff.
const kickoffAt = Date.parse(process.env.KICKOFF_UTC || '');
const MAX_TIMEOUT = 2 ** 31 - 1; // setTimeout fires at once beyond ~24.8 days
function lockAtKickoff() {
  const ms = kickoffAt - Date.now();
  if (ms > MAX_TIMEOUT) return setTimeout(lockAtKickoff, MAX_TIMEOUT);
  setTimeout(() => {
    lockPicks(true);
    broadcast(predState());
  }, Math.max(0, ms));
}
if (kickoffAt) lockAtKickoff();

function onPrediction(c, id, m, asHost = false) {
  const isHost = asHost || id === hostId;
  if (m.t === 'pred-open' && isHost) {
    const over = Math.trunc(Number(m.over));
    if (!(over >= 1 && over <= 20)) return;
    round = { over, phase: 'open', guesses: new Map() };
  } else if (m.t === 'pred-guess' && round?.phase === 'open') {
    const guess = Math.trunc(Number(m.guess));
    if (!(guess >= 0 && guess <= 40)) return;
    round.guesses.set(id, { name: c.name, guess });
  } else if (m.t === 'pred-lock' && isHost && round?.phase === 'open') {
    round.phase = 'locked';
  } else if (m.t === 'pred-resolve' && isHost && round?.phase === 'locked') {
    const actual = Math.trunc(Number(m.actual));
    if (!(actual >= 0 && actual <= 40)) return;
    round.actual = actual;
    round.phase = 'done';
    // Only an exact guess scores.
    round.winners = [];
    for (const [pid, g] of round.guesses) {
      if (g.guess !== actual) continue;
      const p = points.get(pid) || { name: g.name, pts: 0 };
      p.name = g.name;
      p.pts += 1;
      points.set(pid, p);
      round.winners.push(g.name);
    }
  } else {
    return;
  }
  broadcast(predState());
}

const GRACE_MS = 8000; // a page that drops and comes back within this keeps its video running

wss.on('connection', (ws, req) => {
  let id = randomUUID().slice(0, 8);
  const c = { ws, name: 'Guest', role: null, local: LOCAL_HOST.test(req.headers.host || '') && LOCAL_ORIGIN.test(req.headers.origin || ''), bucket: [], sigBucket: [], alive: true, inCall: false, cam: false };
  clients.set(id, c);
  ws.on('pong', () => (c.alive = true));
  ws.on('error', (e) => console.log(`[ws] ${e.message}`)); // e.g. an oversized or malformed frame; ws closes the socket

  ws.on('message', async (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;

    if (m.t === 'join' && !c.role) {
      c.name = String(m.name || '').replace(/\s+/g, ' ').trim().slice(0, 24) || 'Guest';
      const hostKey = (process.env.HOST_KEY || '').trim();
      const keyOk = hostKey.length >= 12 && m.hostKey === hostKey;
      if (m.role === 'host' && !c.local && !keyOk) return send(c, { t: 'error', msg: 'That host link is wrong or out of date. Ask the host for the current one.' });

      // The page keeps one id for its whole life, so a reconnect is the same person, not a new one.
      // The sid stays private; others only ever see a hash of it, so nobody can take over someone else's id.
      const sid = typeof m.sid === 'string' && /^[a-z0-9]{8,32}$/.test(m.sid) ? m.sid : null;
      if (sid) {
        const pub = createHash('sha256').update(sid).digest('hex').slice(0, 16);
        const old = clients.get(pub);
        if (old && old !== c) {
          clients.delete(pub);
          old.ws.terminate();
        }
        clients.delete(id);
        id = pub;
        clients.set(id, c);
      }

      if (m.role === 'host') {
        if (hostId && hostId !== id) {
          clients.get(hostId)?.ws.close(4000, 'replaced');
          live = false;
        }
        hostId = id;
        // A reloaded host page isn't sharing any more, even though it kept its id.
        if (m.fresh && live) {
          live = false;
          broadcast({ t: 'live', on: false });
        }
      }
      c.role = m.role === 'host' ? 'host' : 'viewer';
      const iceServers = await getIceServers();
      console.log(`[join] ${c.name} as ${c.role} (${req.headers['user-agent']?.match(/\(([^;)]+)/)?.[1] || '?'})`);
      send(c, { t: 'welcome', id, role: c.role, live, score, detail, iceServers, delay: getScoreDelay(), kickoff: process.env.KICKOFF_UTC || null });
      if (c.role === 'viewer') send(clients.get(hostId), { t: 'viewer-joined', id, name: c.name });
      send(c, predState());
      send(c, { t: 'pre-mine', answers: myPicks(id) });
      people();
      return;
    }
    if (!c.role) return;
    if ((m.t === 'signal' || m.t === 'call') && !allowSignal(c)) return;

    if (m.t === 'signal' && m.ch === 'call') {
      // voice/camera call: everyone connects to everyone
      if (c.inCall && m.to !== id && clients.get(m.to)?.inCall) send(clients.get(m.to), { t: 'signal', ch: 'call', from: id, data: m.data });
    } else if (m.t === 'signal') {
      const to = c.role === 'host' ? m.to : hostId;
      if (to && clients.has(to) && to !== id) send(clients.get(to), { t: 'signal', from: id, data: m.data });
    } else if (String(m.t).startsWith('pred-') && allow(c)) {
      onPrediction(c, id, m);
    } else if (String(m.t).startsWith('pre-') && allow(c)) {
      if (handlePre(m, id, c.name, id === hostId)) broadcast(predState());
      if (m.t === 'pre-pick') send(c, { t: 'pre-mine', answers: myPicks(id) });
    } else if (m.t === 'sync' && c.role === 'host') {
      send(c, { t: 'sync', seconds: setScoreDelay(m.seconds) });
    } else if (m.t === 'log' && allow(c)) {
      console.log(`[rtc] ${c.name}: ${String(m.msg || '').replace(/\s+/g, ' ').slice(0, 300)}`);
    } else if (m.t === 'call') {
      c.inCall = !!m.on;
      c.cam = !!m.on && !!m.cam;
      people();
    } else if (m.t === 'celebrate' && CELEBRATIONS.includes(m.kind) && allow(c)) {
      celebrate(m.kind, c.name);
    } else if (m.t === 'live' && c.role === 'host') {
      live = !!m.on;
      broadcast({ t: 'live', on: live });
    } else if (m.t === 'chat' && allow(c)) {
      const text = String(m.text || '').trim().slice(0, 300);
      if (text) broadcast({ t: 'chat', id, name: c.name, role: c.role, text, ts: Date.now() });
    } else if (m.t === 'react' && REACTIONS.includes(m.emoji) && allow(c)) {
      broadcast({ t: 'react', id, name: c.name, emoji: m.emoji });
    }
  });

  ws.on('close', () => {
    if (clients.get(id) !== c) return; // already replaced by this page's reconnect
    clients.delete(id);
    if (!c.role) return;
    setTimeout(() => {
      if (clients.has(id)) return; // came back within the grace period
      if (id === hostId) {
        hostId = null;
        live = false;
        broadcast({ t: 'host-left' });
      } else if (c.role === 'viewer') {
        send(clients.get(hostId), { t: 'viewer-left', id });
      }
      people();
    }, GRACE_MS);
  });
});

// Keeps the tunnel connection warm and drops dead sockets.
setInterval(() => {
  clients.forEach((c) => {
    if (!c.alive) return c.ws.terminate();
    c.alive = false;
    c.ws.ping();
  });
}, 30000);

// ---------- admin channel: lets Claude (on this PC) push live details while watching the match ----------
// Bound to 127.0.0.1 on the host via docker-compose, so nobody on the tunnel or Wi-Fi can reach it.
let detail = null; // { overs, batters: [{ name, r, b, onStrike }], bowler: { name, figures }, note, at }

function adminUpdate(m) {
  const applied = [];
  if (m.detail && typeof m.detail === 'object') {
    detail = { ...m.detail, at: Date.now() };
    broadcast({ t: 'detail', detail });
    applied.push('detail');
  }
  if (m.answer) {
    if (handlePre({ t: 'pre-answer', qid: m.answer.qid, answer: m.answer.answer }, 'claude', 'Claude', true)) {
      broadcast(predState());
      applied.push(`answer:${m.answer.qid}`);
    }
  }
  if (m.over) {
    // { open: 7 } | { lock: true } | { resolve: 9 }
    const t = m.over.open != null ? 'pred-open' : m.over.lock ? 'pred-lock' : m.over.resolve != null ? 'pred-resolve' : null;
    if (t) {
      onPrediction({ name: 'Claude' }, 'claude', { t, over: m.over.open, actual: m.over.resolve }, true);
      applied.push(t);
    }
  }
  if (CELEBRATIONS.includes(m.celebrate)) {
    celebrate(m.celebrate, 'Claude', true);
    applied.push(`celebrate:${m.celebrate}`);
  }
  if (typeof m.chat === 'string' && m.chat.trim()) {
    broadcast({ t: 'chat', id: 'claude', name: 'Claude', role: 'bot', text: m.chat.trim().slice(0, 300), ts: Date.now() });
    applied.push('chat');
  }
  return { ok: true, applied, round: round && { over: round.over, phase: round.phase }, pre: preState().answers };
}

const ADMIN_PORT = process.env.ADMIN_PUBLIC_PORT || '8091'; // the host port docker-compose publishes
const ADMIN_HOSTS = new Set([`127.0.0.1:${ADMIN_PORT}`, `localhost:${ADMIN_PORT}`]);

http
  .createServer((req, res) => {
    if (!ADMIN_HOSTS.has(String(req.headers.host || '').toLowerCase())) {
      res.writeHead(403).end(); // DNS-rebinding guard: only the literal local addresses
      return;
    }
    const adminKey = process.env.ADMIN_KEY || '';
    const given = Buffer.from(String(req.headers['x-admin-key'] || ''));
    const want = Buffer.from(adminKey);
    if (!adminKey || given.length !== want.length || !timingSafeEqual(given, want)) {
      res.writeHead(401).end(); // refuses everything while ADMIN_KEY is unset
      return;
    }
    if (req.method !== 'POST' || req.url !== '/admin') {
      res.writeHead(404).end();
      return;
    }
    // JSON only: a web page can't send this cross-origin without a CORS preflight, which is never answered.
    if (!(req.headers['content-type'] || '').startsWith('application/json')) {
      res.writeHead(415).end('Send Content-Type: application/json');
      return;
    }
    let body = '';
    req.on('data', (d) => {
      body += d;
      if (body.length > 64 * 1024) req.destroy();
    });
    req.on('end', () => {
      try {
        const out = adminUpdate(JSON.parse(body));
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out));
      } catch (e) {
        res.writeHead(400).end(String(e.message));
      }
    });
  })
  .listen(8081);

// The Cricbuzz feed drives the over game, celebrations and pick answers automatically.
const say = (text) => broadcast({ t: 'chat', id: 'scoreboard', name: 'Scoreboard', role: 'bot', text, ts: Date.now() });
const asAuto = (m) => onPrediction({ name: 'Scoreboard' }, 'scoreboard', m, true);
const auto =
  (process.env.AUTO_GAME ?? 'true') !== 'false' &&
  createAuto({
    team: TEAM,
    questions: QUESTIONS,
    celebrate: (kind) => celebrate(kind, 'Scoreboard', true),
    // never overwrite an answer the host already set
    answer: (qid, a) => !preState().answers[qid] && handlePre({ t: 'pre-answer', qid, answer: a }, 'scoreboard', 'Scoreboard', true) && broadcast(predState()),
    over: {
      round: () => round && { over: round.over, phase: round.phase },
      open: (n) => asAuto({ t: 'pred-open', over: n }),
      lock: () => asAuto({ t: 'pred-lock' }),
      resolve: (runs) => asAuto({ t: 'pred-resolve', actual: runs }),
    },
    say,
  });

startScore((s) => {
  if ('detail' in s) {
    detail = s.detail;
    broadcast({ t: 'detail', detail });
    auto && auto(s);
  } else {
    autoCelebrate(score, s); // totals-only feeds: guess boundaries from score jumps
  }
  if (autoResolvePre(score, s)) broadcast(predState());
  score = s;
  broadcast({ t: 'score', score });
});

// One bad message must never take the party down.
process.on('unhandledRejection', (e) => console.log(`[error] ${e?.stack || e}`));

console.log('signal server on :8080');
