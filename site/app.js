const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
// You host from http://localhost:8090, or from any computer with the secret link (#host=KEY).
// Friends (tunnel link) or ?view are viewers. The key sits after '#', so it never reaches server logs.
const HOST_KEY = new URLSearchParams(location.hash.slice(1)).get('host');
const IS_HOST = (location.hostname === 'localhost' && !params.has('view')) || !!HOST_KEY;

const REACTIONS = ['4️⃣', '6️⃣', '☝️', '😩', '🔥', '🥇', '🇮🇳', '🇵🇰'];
let ICE = [{ urls: 'stun:stun.l.google.com:19302' }]; // replaced by the server's list (incl. TURN relay) on join
const START_KBPS = 3000;
const CEILING_BPS = 50_000_000;

let ws, myId, myName, lastClose;
// One id per tab (survives reloads), so reconnects keep video running and picks/points stay yours.
const SID = (() => {
  const fresh = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => (b % 36).toString(36)).join('');
  try {
    let s = sessionStorage.getItem('wp-sid');
    if (!s) sessionStorage.setItem('wp-sid', (s = fresh()));
    return s;
  } catch {
    return fresh();
  }
})();
let everConnected = false;
let stream = null;
let kickoff = null;
let score = null;
let viewerIds = new Set();
const pcs = new Map(); // host: viewerId -> RTCPeerConnection; viewer: 'host' -> RTCPeerConnection

const video = $('#video');

// ---------- connection ----------
function send(msg) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
}

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => {
    setPill('#connPill', 'Connected', 'pill-on');
    send({ t: 'join', role: IS_HOST ? 'host' : 'viewer', name: myName, sid: SID, fresh: !everConnected, hostKey: HOST_KEY || undefined });
    everConnected = true;
    if (lastClose) send({ t: 'log', msg: `page reconnected after drop (code ${lastClose.code}, ${Math.round((Date.now() - lastClose.at) / 1000)}s ago, tab ${document.visibilityState})` });
  };
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  ws.onclose = (e) => {
    lastClose = { code: e.code, at: Date.now() };
    setPill('#connPill', 'Reconnecting…', 'pill-off');
    // Video and voice keep flowing peer-to-peer; the server only tears them down if we stay gone.
    if (e.code !== 4000) setTimeout(connect, 2000);
    else system('This room was opened in another host tab.');
  };
}

function onMessage(m) {
  switch (m.t) {
    case 'welcome':
      myId = m.id;
      if (m.iceServers?.length) ICE = m.iceServers;
      kickoff = m.kickoff ? Date.parse(m.kickoff) : null;
      if (m.score) renderScore(m.score);
      if (m.detail) renderDetail(m.detail);
      if (IS_HOST && m.delay != null) $('#syncInput').value = m.delay;
      if (IS_HOST && stream) send({ t: 'live', on: true });
      if (mic) send({ t: 'call', on: true, cam: !!mic.getVideoTracks().length });
      if (!IS_HOST) setLive(m.live);
      break;
    case 'error':
      system(m.msg);
      break;
    case 'people':
      renderPeople(m.list);
      break;
    case 'viewer-joined':
      system(`${m.name} joined`);
      break;
    case 'viewer-left':
      closePeer(m.id);
      break;
    case 'signal':
      if (m.ch === 'call') onCallSignal(m.from, m.data);
      else onSignal(m.from, m.data);
      break;
    case 'celebrate':
      showCelebration(m);
      break;
    case 'live':
      if (!IS_HOST) setLive(m.on);
      break;
    case 'host-left':
      if (!IS_HOST) {
        setLive(false);
        system('Host disconnected. Hang tight.');
      }
      break;
    case 'chat':
      addChat(m);
      break;
    case 'react':
      floatReaction(m);
      break;
    case 'score':
      renderScore(m.score);
      break;
    case 'pred':
      renderPred(m);
      if (m.pre) renderPre(m.pre);
      break;
    case 'detail':
      renderDetail(m.detail);
      break;
    case 'sync':
      $('#syncInput').value = m.seconds;
      hostNote(`Scoreboard now runs ${m.seconds}s behind the live feed.`);
      break;
    case 'pre-mine':
      myPre = m.answers;
      if (!prePrompted && pre && !pre.locked && !myPre) openPreForm();
      prePrompted = true;
      if (pre) renderPre(pre);
      break;
  }
}

// ---------- WebRTC ----------
// Reports each connection's outcome to the server log (docker compose logs signal):
// which path it took (host = same network, srflx = direct over internet, relay = TURN) or why it failed.
function monitor(pc, label) {
  const local = new Set();
  pc.addEventListener('icecandidate', (e) => e.candidate && local.add(e.candidate.type));
  pc._label = label;
  pc.addEventListener('connectionstatechange', async () => {
    const st = pc.connectionState;
    if (st === 'connecting') send({ t: 'log', msg: `${label} connecting` });
    if (st === 'connected') {
      const stats = await pc.getStats().catch(() => null);
      let pair = null;
      stats?.forEach((r) => r.type === 'transport' && r.selectedCandidatePairId && (pair = stats.get(r.selectedCandidatePairId)));
      if (!pair) stats?.forEach((r) => r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded' && (pair = r));
      const l = pair && stats.get(pair.localCandidateId);
      const r = pair && stats.get(pair.remoteCandidateId);
      send({ t: 'log', msg: `${label} connected via ${l?.candidateType}/${l?.protocol} -> ${r?.candidateType}, rtt ${Math.round((pair?.currentRoundTripTime || 0) * 1000)}ms` });
    } else if (st === 'failed' || st === 'disconnected') {
      send({ t: 'log', msg: `${label} ${st}; my candidate types: ${[...local].join(',') || 'none'}; relay configured: ${ICE.some((s) => String(s.urls).includes('turn:'))}` });
    }
  });
}
// Each peer connection runs its signaling steps in order, even though messages arrive async.
function queue(pc, fn) {
  pc._chain = (pc._chain || Promise.resolve()).then(fn).catch((e) => console.warn('rtc', e));
}

function closePeer(id) {
  pcs.get(id)?.close();
  pcs.delete(id);
}

function closeAll() {
  [...pcs.keys()].forEach(closePeer);
}

// Auto quality: each friend's connection gets its own bitrate, set live by WebRTC's congestion
// control from what their internet can take. The ceiling is only there to lift Chrome's built-in
// ~2.5 Mbps screen-share cap; it is never reached in practice.
async function applyBitrate(pc) {
  for (const s of pc.getSenders()) {
    if (s.track?.kind !== 'video') continue;
    const p = s.getParameters();
    if (!p.encodings?.length) p.encodings = [{}];
    p.encodings[0].maxBitrate = CEILING_BPS;
    p.degradationPreference = 'balanced';
    await s.setParameters(p).catch(() => {});
  }
}

// WebRTC normally starts around 300 kbps and ramps up slowly, which looks blurry for the
// first 10-30s. Chrome reads these x-google hints from the answer to start high.
function boostSdp(sdp) {
  const hint = `x-google-start-bitrate=${START_KBPS};x-google-max-bitrate=${CEILING_BPS / 1000}`;
  const lines = sdp.split('\r\n');
  const codecPts = lines
    .map((l) => l.match(/^a=rtpmap:(\d+) (VP8|VP9|H264|AV1)\//i))
    .filter(Boolean)
    .map((m) => m[1]);
  const out = [];
  for (const l of lines) {
    const fmtp = l.match(/^a=fmtp:(\d+) /);
    if (fmtp && codecPts.includes(fmtp[1]) && !l.includes('x-google')) {
      out.push(`${l};${hint}`);
      continue;
    }
    out.push(l);
    const rtp = l.match(/^a=rtpmap:(\d+) (VP8|VP9|H264|AV1)\//i);
    if (rtp && !lines.some((x) => x.startsWith(`a=fmtp:${rtp[1]} `))) out.push(`a=fmtp:${rtp[1]} ${hint}`);
  }
  return out.join('\r\n');
}

function startPeer(id) {
  closePeer(id);
  const pc = new RTCPeerConnection({ iceServers: ICE });
  pcs.set(id, pc);
  monitor(pc, `stream to ${roster.find((p) => p.id === id)?.name || id}`);
  pc.onicecandidate = (e) => e.candidate && send({ t: 'signal', to: id, data: { ice: e.candidate } });
  stream.getTracks().forEach((tr) => pc.addTrack(tr, stream));
  queue(pc, async () => {
    await pc.setLocalDescription(await pc.createOffer());
    send({ t: 'signal', to: id, data: { sdp: pc.localDescription } });
  });
}

function onSignal(from, data) {
  if (IS_HOST) {
    const pc = pcs.get(from);
    if (!pc) return;
    if (data.sdp) queue(pc, async () => {
      await pc.setRemoteDescription({ type: data.sdp.type, sdp: boostSdp(data.sdp.sdp) });
      await applyBitrate(pc);
    });
    if (data.ice) queue(pc, () => pc.addIceCandidate(data.ice));
    return;
  }

  if (data.sdp?.type === 'offer') {
    closePeer('host');
    const pc = new RTCPeerConnection({ iceServers: ICE });
    pcs.set('host', pc);
    monitor(pc, 'stream from host');
    pc.onicecandidate = (e) => e.candidate && send({ t: 'signal', data: { ice: e.candidate } });
    pc.ontrack = (e) => attachStream(e.streams[0]);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        showStage("Couldn't connect to the stream", 'Your network may block direct video. Try another Wi-Fi or mobile data.');
      }
    };
    queue(pc, async () => {
      await pc.setRemoteDescription(data.sdp);
      await pc.setLocalDescription(await pc.createAnswer());
      send({ t: 'signal', data: { sdp: pc.localDescription } });
    });
  } else if (data.ice) {
    const pc = pcs.get('host');
    if (pc) queue(pc, () => pc.addIceCandidate(data.ice));
  }
}

function attachStream(s) {
  if (video.srcObject !== s) video.srcObject = s;
  hideStage();
  video.muted = false;
  video.play().catch(() => {
    video.muted = true;
    video.play().catch(() => {});
    $('#unmuteBtn').hidden = false;
  });
}

// ---------- host: screen share ----------
async function startShare() {
  let s;
  try {
    s = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 60 } }, // native resolution of the tab, as smooth as it plays
      audio: true,
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
    });
  } catch {
    return hostNote('Screen share was cancelled.');
  }
  stopShare(true);
  stream = s;
  const vt = s.getVideoTracks()[0];
  vt.contentHint = 'motion';
  vt.onended = () => stopShare();

  video.srcObject = s;
  video.muted = true; // the Willow tab already plays sound on your PC
  hideStage();
  $('#shareBtn').textContent = 'Change tab';
  $('#stopBtn').hidden = false;
  setPill('#livePill', 'Live', 'pill-live');

  hostNote(
    s.getAudioTracks().length
      ? 'Live. Friends get picture and sound.'
      : 'No sound is being shared. Click “Change tab”, pick the Willow tab and tick “Share tab audio”.',
    !s.getAudioTracks().length
  );
  send({ t: 'live', on: true });
  viewerIds.forEach(startPeer);
}

function stopShare(silent = false) {
  if (!stream) return;
  stream.getTracks().forEach((t) => t.stop());
  stream = null;
  closeAll();
  if (silent) return;
  video.srcObject = null;
  showStage('You are off air', 'Click “Share screen” and pick the Willow TV tab.');
  $('#shareBtn').textContent = 'Share screen';
  $('#stopBtn').hidden = true;
  setPill('#livePill', 'Off air', 'pill-off');
  hostNote('Stopped sharing.');
  send({ t: 'live', on: false });
}


// Live readout of what is actually being sent/received, plus Chrome's reason when it lowers quality.
const lastBytes = new Map();
setInterval(async () => {
  const el = $('#stats');
  if (!pcs.size) return (el.textContent = '');
  const rows = [];
  const reasons = new Set();
  for (const [id, pc] of pcs) {
    if (pc.connectionState !== 'connected') {
      rows.push(`${pc._label?.replace(/^stream (to|from) /, '') || id}: ${pc.connectionState}`);
      continue;
    }
    const stats = await pc.getStats().catch(() => null);
    stats?.forEach((r) => {
      const out = r.type === 'outbound-rtp';
      if (r.kind !== 'video' || !(out || r.type === 'inbound-rtp')) return;
      const bytes = out ? r.bytesSent : r.bytesReceived;
      const prev = lastBytes.get(id + r.type);
      lastBytes.set(id + r.type, { bytes, ts: r.timestamp });
      const mbps = prev ? (((bytes - prev.bytes) * 8) / (r.timestamp - prev.ts) / 1000).toFixed(1) : '…';
      if (out && r.qualityLimitationReason !== 'none') reasons.add(r.qualityLimitationReason);
      // Delay behind the host ≈ one-way network time + the receiver's jitter buffer.
      let delay = '';
      if (!out) {
        let rtt = 0;
        stats.forEach((s) => s.type === 'candidate-pair' && s.nominated && s.currentRoundTripTime && (rtt = s.currentRoundTripTime));
        const buffer = r.jitterBufferEmittedCount ? r.jitterBufferDelay / r.jitterBufferEmittedCount : 0;
        delay = ` · ~${Math.round((rtt / 2 + buffer) * 1000)}ms behind host`;
      }
      rows.push(`${r.frameWidth || '?'}×${r.frameHeight || '?'} · ${Math.round(r.framesPerSecond || 0)}fps · ${mbps} Mbps${delay}`);
    });
  }
  el.textContent = (IS_HOST ? `Sending to ${pcs.size}: ` : 'Receiving: ') + rows.join(' | ') +
    (reasons.size ? ` · limited by ${[...reasons].join(', ')}` : '');
  if (!IS_HOST) return;
  if (reasons.has('cpu')) hostNote('Your PC is struggling to encode. Close other apps or turn hardware acceleration back on.', true);
  else if (reasons.has('bandwidth')) hostNote("A friend's internet (or your upload) is the limit. Quality is adjusting for them.", true);
}, 2000);

// ---------- UI ----------
function setPill(sel, text, cls) {
  const el = $(sel);
  el.textContent = text;
  el.className = `pill ${cls}`;
}

function hostNote(text, warn = false) {
  const el = $('#hostNote');
  el.textContent = text;
  el.classList.toggle('warn', warn);
}

function showStage(title, hint) {
  $('#stageTitle').textContent = title;
  $('#stageHint').textContent = hint;
  $('#stageEmpty').hidden = false;
}

function hideStage() {
  $('#stageEmpty').hidden = true;
}

function setLive(on) {
  setPill('#livePill', on ? 'Live' : 'Off air', on ? 'pill-live' : 'pill-off');
  if (!on) {
    closePeer('host');
    video.srcObject = null;
    $('#unmuteBtn').hidden = true;
    showStage('Waiting for the host to go live', "The stream starts here as soon as it's shared.");
  } else if (!video.srcObject) {
    showStage('Connecting to the stream…', 'This usually takes a couple of seconds.');
  }
}

function renderPeople(list) {
  viewerIds = new Set(list.filter((p) => p.role === 'viewer').map((p) => p.id));
  if (IS_HOST && stream) viewerIds.forEach((id) => pcs.has(id) || startPeer(id));
  roster = list;
  syncCall();
  renderBoard();
  $('#peopleCount').textContent = list.length;
  $('#peopleList').replaceChildren(
    ...list.map((p) => {
      const li = document.createElement('li');
      li.textContent = p.name + (p.role === 'host' ? ' · host' : '');
      if (p.role === 'host') li.classList.add('host');
      if (p.id === myId) li.classList.add('me');
      return li;
    })
  );
}

function addLine(li) {
  const log = $('#chatLog');
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  log.append(li);
  while (log.children.length > 200) log.firstChild.remove();
  if (nearBottom) log.scrollTop = log.scrollHeight;
}

function addChat(m) {
  const li = document.createElement('li');
  const who = document.createElement('span');
  who.className = `who${m.role === 'host' ? ' host' : m.role === 'bot' ? ' bot' : ''}`;
  who.textContent = m.name;
  li.append(who, document.createTextNode(m.text));
  addLine(li);

  addToast(m.name, m.text); // in theater mode, chat pops up over the match
}

function system(text) {
  const li = document.createElement('li');
  li.className = 'sys';
  li.textContent = text;
  addLine(li);
}

function floatReaction(m) {
  const el = document.createElement('div');
  el.className = 'floater';
  el.style.left = `${8 + Math.random() * 80}%`;
  const e = document.createElement('span');
  e.className = 'e';
  e.textContent = m.emoji;
  const n = document.createElement('span');
  n.className = 'n';
  n.textContent = m.name;
  el.append(e, n);
  el.addEventListener('animationend', () => el.remove());
  $('#floatLayer').append(el);
}

function renderScore(s) {
  score = s;
  const main = $('#scoreMain');
  const meta = $('#scoreMeta');
  if (s.error) {
    main.className = 'score-main dim';
    main.textContent = s.error;
    meta.textContent = '';
    return;
  }
  main.className = 'score-main';
  main.replaceChildren(
    ...(s.innings.length ? s.innings : [{ label: s.name, r: null }]).map((i) => {
      const div = document.createElement('div');
      div.className = 'inn';
      const label = document.createElement('span');
      label.textContent = `${(i.label || '').replace(/ Inning 1$/, '')} `;
      div.append(label);
      if (i.r != null) {
        const b = document.createElement('b');
        b.textContent = `${i.r}/${i.w}`;
        div.append(b);
        if (i.o != null) {
          const o = document.createElement('span');
          o.textContent = ` (${i.o} ov)`;
          div.append(o);
        }
      }
      return div;
    })
  );
  updateScoreMeta();
}

// Batters / bowler / overs, pushed by Claude while it follows the match.
let detail = null;
function renderDetail(d) {
  celebrateMilestones(detail, d);
  detail = d;
  const box = $('#scoreDetail');
  const parts = [];
  if (d?.overs != null) parts.push(`${d.overs} ov`);
  for (const b of d?.batters || []) parts.push(`${b.name} ${b.r ?? ''}${b.onStrike ? '*' : ''}${b.b != null ? ` (${b.b})` : ''}`);
  if (d?.bowler?.name) parts.push(`${d.bowler.name} ${d.bowler.figures || ''}`.trim());
  if (d?.crr) parts.push(`CRR ${d.crr}`);
  if (d?.target) parts.push(`Target ${d.target}${d.rrr ? ` · RRR ${d.rrr}` : ''}`);
  if (d?.note) parts.push(d.note);
  box.textContent = parts.join(' · ');
  box.hidden = !parts.length;
}

// An India batter reaching 50 or 100 gets the full banner. Runs come with every scoreboard update,
// so each page spots it itself; the first update after joining only sets the baseline.
function celebrateMilestones(prev, next) {
  const battingIndia = (score?.innings || []).find((i) => i.batting)?.label?.toLowerCase().includes('india');
  if (!prev || !next || !battingIndia) return;
  for (const b of next.batters || []) {
    const old = (prev.batters || []).find((x) => x.name === b.name);
    if (!old) continue;
    for (const [mark, kind] of [[100, 'hundred'], [50, 'fifty']]) {
      if (old.r < mark && b.r >= mark) {
        showCelebration({ kind, auto: true, sub: `${b.name} · ${b.r} off ${b.b} balls` });
        break;
      }
    }
  }
}

function updateScoreMeta() {
  const meta = $('#scoreMeta');
  if (!score || score.error) return;
  const parts = [];
  if (kickoff && Date.now() < kickoff) {
    const mins = Math.round((kickoff - Date.now()) / 60000);
    parts.push(`Starts in ${Math.floor(mins / 60)}h ${mins % 60}m`);
  }
  if (score.fetchedAt) {
    const secs = Math.round((Date.now() - score.fetchedAt) / 1000);
    parts.push(`updated ${secs < 90 ? `${secs}s` : `${Math.round(secs / 60)}m`} ago, ${score.delayed}s spoiler delay`);
  }
  const status = document.createElement('span');
  status.className = 'status';
  status.textContent = score.status || '';
  meta.replaceChildren(status, document.createTextNode(parts.length ? ` · ${parts.join(' · ')}` : ''));
}
setInterval(updateScoreMeta, 5000);

// ---------- voice / camera call (everyone connects to everyone) ----------
let mic = null; // your mic (+ camera) stream while you're in the call
let roster = [];
const callPcs = new Map(); // peerId -> RTCPeerConnection
let audioCtx = null;

async function joinCall(withCam) {
  try {
    mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: withCam ? { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15 } } : false,
    });
  } catch {
    return system(`${withCam ? 'Camera or mic' : 'Mic'} is blocked. Allow it from the icon in the address bar, then try again.`);
  }
  addTile('me', mic, myName, true);
  send({ t: 'call', on: true, cam: withCam });
  updateCallButtons();
}

function leaveCall() {
  mic?.getTracks().forEach((t) => t.stop());
  mic = null;
  [...callPcs.keys()].forEach(closeCallPeer);
  removeTile('me');
  send({ t: 'call', on: false });
  updateCallButtons();
}

// The lower id makes the offer, so two people never call each other at the same moment.
function syncCall() {
  const inCall = new Set(roster.filter((p) => p.inCall && p.id !== myId).map((p) => p.id));
  for (const id of [...callPcs.keys()]) if (!inCall.has(id) || !mic) closeCallPeer(id);
  if (!mic) return;
  inCall.forEach((id) => !callPcs.has(id) && myId < id && startCallPeer(id));
}

function newCallPc(id) {
  const pc = new RTCPeerConnection({ iceServers: ICE });
  callPcs.set(id, pc);
  monitor(pc, `call with ${roster.find((p) => p.id === id)?.name || id}`);
  pc.onicecandidate = (e) => e.candidate && send({ t: 'signal', ch: 'call', to: id, data: { ice: e.candidate } });
  pc.ontrack = (e) => addTile(id, e.streams[0], roster.find((p) => p.id === id)?.name || 'Friend', false);
  mic.getTracks().forEach((t) => pc.addTrack(t, mic));
  return pc;
}

function startCallPeer(id) {
  const pc = newCallPc(id);
  queue(pc, async () => {
    await pc.setLocalDescription(await pc.createOffer());
    send({ t: 'signal', ch: 'call', to: id, data: { sdp: pc.localDescription } });
  });
}

function onCallSignal(from, data) {
  if (!mic) return;
  if (data.sdp?.type === 'offer') {
    closeCallPeer(from);
    const pc = newCallPc(from);
    queue(pc, async () => {
      await pc.setRemoteDescription(data.sdp);
      await pc.setLocalDescription(await pc.createAnswer());
      send({ t: 'signal', ch: 'call', to: from, data: { sdp: pc.localDescription } });
    });
    return;
  }
  const pc = callPcs.get(from);
  if (!pc) return;
  if (data.sdp) queue(pc, () => pc.setRemoteDescription(data.sdp));
  if (data.ice) queue(pc, () => pc.addIceCandidate(data.ice));
}

function closeCallPeer(id) {
  callPcs.get(id)?.close();
  callPcs.delete(id);
  removeTile(id);
}

function addTile(id, s, name, isMe) {
  let tile = document.querySelector(`.tile[data-id="${id}"]`);
  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'tile';
    tile.dataset.id = id;
    const v = document.createElement('video');
    v.autoplay = true;
    v.playsInline = true;
    v.muted = isMe; // never play your own mic back to yourself
    const initial = document.createElement('span');
    initial.className = 'initial';
    const label = document.createElement('span');
    label.className = 'label';
    tile.append(v, initial, label);
    $('#tiles').append(tile);
  }
  const v = tile.querySelector('video');
  if (v.srcObject !== s) v.srcObject = s;
  v.play().catch(() => {});
  tile.querySelector('.initial').textContent = (name || '?').slice(0, 1).toUpperCase();
  tile.querySelector('.label').textContent = isMe ? `${name} (you)` : name;
  tile.classList.toggle('no-cam', !s.getVideoTracks().some((t) => t.enabled));
  watchSpeaking(tile, s);
}

function removeTile(id) {
  const tile = document.querySelector(`.tile[data-id="${id}"]`);
  tile?._stopSpeaking?.();
  tile?.remove();
}

// Green ring around whoever is talking.
function watchSpeaking(tile, s) {
  if (tile._stream === s || !s.getAudioTracks().length) return;
  tile._stopSpeaking?.();
  tile._stream = s;
  audioCtx ||= new AudioContext();
  const src = audioCtx.createMediaStreamSource(s);
  const an = audioCtx.createAnalyser();
  an.fftSize = 512;
  src.connect(an);
  const buf = new Uint8Array(an.fftSize);
  const timer = setInterval(() => {
    an.getByteTimeDomainData(buf);
    let peak = 0;
    for (const x of buf) peak = Math.max(peak, Math.abs(x - 128));
    tile.classList.toggle('speaking', peak > 12);
  }, 150);
  tile._stopSpeaking = () => {
    clearInterval(timer);
    src.disconnect();
  };
}

function updateCallButtons() {
  const inCall = !!mic;
  const hasCam = !!mic?.getVideoTracks().length;
  $('#voiceBtn').hidden = inCall;
  $('#camJoinBtn').hidden = inCall;
  $('#muteBtn').hidden = !inCall;
  $('#leaveBtn').hidden = !inCall;
  $('#camBtn').hidden = !hasCam;
  if (inCall) {
    $('#muteBtn').textContent = mic.getAudioTracks()[0]?.enabled ? 'Mute' : 'Unmute';
    if (hasCam) $('#camBtn').textContent = mic.getVideoTracks()[0].enabled ? 'Camera off' : 'Camera on';
  }
}

// ---------- celebrations ----------
const CELEBRATIONS = {
  four: { text: 'Four!', sub: 'India find the rope' },
  six: { text: 'Six!', sub: 'Into the stands' },
  wicket: { text: 'Wicket!', sub: 'Gone!' },
  win: { text: 'Gold!', sub: 'India win the Asian Games' },
  fifty: { text: 'Fifty!', sub: 'Raise the bat' },
  hundred: { text: 'Hundred!', sub: 'What a knock' },
};
const BIG = new Set(['win', 'fifty', 'hundred']); // the long banner, extra confetti, full fanfare
const CONFETTI_COLORS = ['#ff9933', '#ffffff', '#1fa33a', '#f2c14e'];
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
let bannerTimer;

function showCelebration(m) {
  const c = CELEBRATIONS[m.kind];
  if (!c) return;
  $('#bannerText').textContent = c.text;
  $('#bannerSub').textContent = m.sub || (m.auto ? c.sub : `${c.sub} · ${m.name}`);
  const banner = $('#banner');
  banner.classList.remove('out');
  banner.hidden = false;
  void banner.offsetWidth; // restart the slam animation
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => {
    banner.classList.add('out');
    setTimeout(() => (banner.hidden = true), 500);
  }, BIG.has(m.kind) ? 4500 : 2200);
  if (!reduceMotion) confetti(BIG.has(m.kind) ? 420 : 200);
  fanfare(m.kind);
  system(`🎉 ${c.text} ${m.auto ? '(scoreboard)' : `· ${m.name}`}`);
}

function confetti(count) {
  const cv = $('#confetti');
  const ctx = cv.getContext('2d');
  cv.width = innerWidth * devicePixelRatio;
  cv.height = innerHeight * devicePixelRatio;
  ctx.scale(devicePixelRatio, devicePixelRatio);
  const bits = Array.from({ length: count }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * innerWidth * 0.3,
    y: innerHeight * 0.55,
    vx: (Math.random() - 0.5) * 16,
    vy: -8 - Math.random() * 14,
    size: 6 + Math.random() * 6,
    rot: Math.random() * Math.PI,
    spin: (Math.random() - 0.5) * 0.4,
    color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
  }));
  const end = performance.now() + 3200;
  (function frame(now) {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const b of bits) {
      b.vy += 0.35;
      b.vx *= 0.99;
      b.x += b.vx;
      b.y += b.vy;
      b.rot += b.spin;
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.rot);
      ctx.fillStyle = b.color;
      ctx.fillRect(-b.size / 2, -b.size / 4, b.size, b.size / 2);
      ctx.restore();
    }
    if (now < end) requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, innerWidth, innerHeight);
  })(performance.now());
}

// A short stadium-horn fanfare, synthesized so there are no sound files to host.
function fanfare(kind) {
  try {
    audioCtx ||= new AudioContext();
    const notes = BIG.has(kind) ? [523, 659, 784, 1047, 784, 1047] : kind === 'wicket' ? [392, 523, 659] : [440, 554, 659];
    const t0 = audioCtx.currentTime;
    notes.forEach((f, i) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = 'sawtooth';
      o.frequency.value = f;
      const t = t0 + i * 0.14;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.08, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
      o.connect(g).connect(audioCtx.destination);
      o.start(t);
      o.stop(t + 0.32);
    });
  } catch {}
}

// ---------- prediction game ----------
let pred = { round: null, board: [] };
let myGuess = null; // { over, guess }

function renderPred(m) {
  const prev = pred.round;
  pred = m;
  const r = m.round;
  if (r?.phase === 'open' && (prev?.over !== r.over || prev?.phase !== 'open')) {
    system(`Over ${r.over} is open. Guess the runs!`);
    addToast('Predict', `Over ${r.over}: how many runs?`);
  }

  const q = $('#predQ');
  q.replaceChildren();
  if (!r) q.textContent = 'No over open yet.';
  else {
    const o = document.createElement('span');
    o.className = 'over';
    o.textContent = `Over ${r.over}`;
    const rest = { open: ': how many runs?', locked: ': guesses locked', done: `: ${r.actual} runs` }[r.phase];
    q.append(o, document.createTextNode(rest));
  }

  const open = r?.phase === 'open';
  $('#predict').classList.toggle('open', open);
  $('#predForm').hidden = !open;
  const mine = myGuess && myGuess.over === r?.over ? myGuess.guess : null;
  $('#predSubmit').textContent = mine == null ? 'Guess' : 'Change';

  let note = '';
  if (open) note = `${mine != null ? `Your guess: ${mine}. ` : ''}${r.count} guessed${r.count ? `: ${r.guessed.join(', ')}` : ''}`;
  else if (r?.phase === 'locked') note = 'Locked. Waiting for the over to finish.';
  else if (r?.phase === 'done') {
    note = !r.guesses?.length ? 'Nobody guessed this one.' : r.winners.length ? `${r.winners.join(', ')} got it right (+1)` : 'Nobody got it right.';
  }
  $('#predNote').textContent = note;

  $('#predGuesses').replaceChildren(
    ...(r?.guesses || []).map((g) => {
      const li = document.createElement('li');
      li.textContent = `${g.name}: ${g.guess}`;
      if (r.winners.includes(g.name)) li.classList.add('win');
      return li;
    })
  );

  renderBoard();

  if (!IS_HOST) return;
  const input = $('#predOver');
  const btn = $('#predHostBtn');
  if (!r || r.phase === 'done') {
    input.hidden = false;
    input.placeholder = 'Over #';
    input.min = 1;
    input.max = 20;
    input.value = r ? Math.min(20, r.over + 1) : '';
    btn.textContent = 'Open over';
  } else if (r.phase === 'open') {
    input.hidden = true;
    btn.textContent = 'Lock guesses';
  } else {
    input.hidden = false;
    input.placeholder = 'Actual runs';
    input.min = 0;
    input.max = 40;
    input.value = '';
    btn.textContent = 'Score it';
  }
}

// Everyone in the room is on the board (0 until they score); scorers who left stay on it.
let lastLeader = null;
const lastPts = new Map();
function renderBoard() {
  const rows = new Map((pred.board || []).map((p) => [p.id, { ...p }]));
  for (const p of roster) if (!rows.has(p.id)) rows.set(p.id, { id: p.id, name: p.name, pts: 0 });
  const list = [...rows.values()].sort((a, b) => b.pts - a.pts || a.name.localeCompare(b.name));
  const top = list[0]?.pts > 0 ? list[0] : null;
  const leaderTied = top && list[1]?.pts === top.pts;

  $('#board').replaceChildren(
    ...list.map((p) => {
      const li = el('li');
      if (top && p.pts === top.pts) li.classList.add('lead');
      if (p.id === myId) li.classList.add('me');
      if (lastPts.has(p.id) && p.pts > lastPts.get(p.id)) li.classList.add('bump');
      li.append(el('span', 'bn', p.name), el('span', 'bp', String(p.pts)));
      return li;
    })
  );
  $('#boardStrip').textContent = top ? `🏆 ${list.slice(0, 3).map((p) => `${p.name} ${p.pts}`).join(' · ')}` : '';

  if (top && !leaderTied && lastLeader !== top.id) {
    if (lastLeader !== null) addToast('🏆', `${top.name} takes the lead with ${top.pts}!`);
    lastLeader = top.id;
  }
  list.forEach((p) => lastPts.set(p.id, p.pts));
}

function addToast(name, text) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  const b = document.createElement('b');
  b.textContent = name;
  toast.append(b, document.createTextNode(text));
  toast.addEventListener('animationend', () => toast.remove());
  $('#toasts').append(toast);
  while ($('#toasts').children.length > 4) $('#toasts').firstChild.remove();
}

$('#predForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const guess = Number($('#predInput').value);
  if (!pred.round || !Number.isInteger(guess) || guess < 0 || guess > 40) return;
  myGuess = { over: pred.round.over, guess };
  send({ t: 'pred-guess', guess });
  $('#predInput').value = '';
});

$('#predHostBtn').addEventListener('click', () => {
  const r = pred.round;
  const n = Number($('#predOver').value);
  if (!r || r.phase === 'done') Number.isInteger(n) && n >= 1 && n <= 20 && send({ t: 'pred-open', over: n });
  else if (r.phase === 'open') send({ t: 'pred-lock' });
  else Number.isInteger(n) && n >= 0 && n <= 40 && send({ t: 'pred-resolve', actual: n });
});

// ---------- match picks (pre-match predictions) ----------
let pre = null;
let myPre = null;
let prePrompted = false;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function renderPre(p) {
  pre = p;
  $('#preStatus').textContent = p.locked
    ? 'Picks are locked. Good luck!'
    : `${p.count} ${p.count === 1 ? 'person has' : 'people have'} picked. Picks lock at kickoff.`;
  $('#preOpenBtn').hidden = p.locked;
  $('#preOpenBtn').textContent = myPre ? 'Edit my picks' : 'Make my picks';
  if (IS_HOST) {
    $('#preLockBtn').hidden = false;
    $('#preLockBtn').textContent = p.locked ? 'Unlock picks' : 'Lock picks now';
  }

  const show = p.locked || myPre || IS_HOST;
  $('#preList').replaceChildren(
    ...(show ? p.questions : []).map((q) => {
      const li = el('li');
      const answer = p.answers[q.id];
      li.append(el('span', 'pq', q.q));
      li.append(el('span', `pa${answer ? '' : ' pending'}`, answer || (q.auto ? 'Resolves automatically' : 'Not decided yet')));
      const mine = myPre?.[q.id];
      if (mine) li.append(el('span', `mine${answer ? (mine === answer ? ' right' : ' wrong') : ''}`, `You: ${mine}${answer ? (mine === answer ? ' ✓ +1' : ' ✗') : ''}`));
      if (answer && p.reveal) {
        const right = p.reveal.filter((r) => r.answers[q.id] === answer).map((r) => r.name);
        li.append(el('span', 'who', right.length ? `Got it: ${right.join(', ')}` : 'Nobody got it'));
      }
      if (IS_HOST) {
        const row = el('div', 'pre-host');
        const sel = el('select');
        sel.setAttribute('aria-label', `Answer for ${q.q}`);
        sel.append(new Option('Not decided', ''), ...q.options.map((o) => new Option(o, o, false, o === answer)));
        const btn = el('button', 'btn btn-ghost', 'Set');
        btn.type = 'button';
        btn.addEventListener('click', () => send({ t: 'pre-answer', qid: q.id, answer: sel.value || null }));
        row.append(sel, btn);
        li.append(row);
      }
      return li;
    })
  );
}

function openPreForm() {
  if (!pre || pre.locked) return;
  $('#preQuestions').replaceChildren(
    ...pre.questions.map((q) => {
      const fs = el('fieldset', 'pre-q');
      fs.append(el('legend', null, q.q));
      if (q.options.length <= 6) {
        const chips = el('div', 'chips');
        q.options.forEach((o, i) => {
          const label = el('label', 'chip');
          const input = el('input');
          input.type = 'radio';
          input.name = `pre-${q.id}`;
          input.value = o;
          input.id = `pre-${q.id}-${i}`;
          input.checked = myPre?.[q.id] === o;
          label.append(input, el('span', null, o));
          chips.append(label);
        });
        fs.append(chips);
      } else {
        const sel = el('select');
        sel.name = `pre-${q.id}`;
        sel.id = `pre-${q.id}`;
        sel.append(new Option('Pick a player', ''), ...q.options.map((o) => new Option(o, o, false, myPre?.[q.id] === o)));
        fs.append(sel);
      }
      return fs;
    })
  );
  $('#preOverlay').hidden = false;
}

$('#preForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const answers = {};
  for (const q of pre?.questions || []) {
    const v = $('#preForm').elements[`pre-${q.id}`]?.value;
    if (v) answers[q.id] = v;
  }
  send({ t: 'pre-pick', answers });
  $('#preOverlay').hidden = true;
  system('Your match picks are saved. You can change them until kickoff.');
});
$('#preSkipBtn').addEventListener('click', () => ($('#preOverlay').hidden = true));
$('#preOpenBtn').addEventListener('click', openPreForm);
$('#preLockBtn').addEventListener('click', () => send({ t: 'pre-lock', on: !pre?.locked }));

// ---------- wiring ----------
document.querySelectorAll('.celeb-btn').forEach((b) =>
  b.addEventListener('click', () => send({ t: 'celebrate', kind: b.dataset.kind }))
);
$('#voiceBtn').addEventListener('click', () => joinCall(false));
$('#camJoinBtn').addEventListener('click', () => joinCall(true));
$('#leaveBtn').addEventListener('click', leaveCall);
$('#muteBtn').addEventListener('click', () => {
  const t = mic?.getAudioTracks()[0];
  if (t) t.enabled = !t.enabled;
  updateCallButtons();
});
$('#camBtn').addEventListener('click', () => {
  const t = mic?.getVideoTracks()[0];
  if (!t) return;
  t.enabled = !t.enabled;
  document.querySelector('.tile[data-id="me"]')?.classList.toggle('no-cam', !t.enabled);
  updateCallButtons();
});

$('#reactions').replaceChildren(
  ...REACTIONS.map((emoji) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'react-btn';
    b.textContent = emoji;
    b.addEventListener('click', () => send({ t: 'react', emoji }));
    return b;
  })
);

$('#chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('#chatInput').value.trim();
  if (!text) return;
  send({ t: 'chat', text });
  $('#chatInput').value = '';
});

// Theater mode fullscreens the whole page (not just the video), so cameras, chat and
// celebrations stay on screen. Phones without the Fullscreen API still get the layout.
function setTheater(on) {
  document.body.classList.toggle('theater', on);
  $('#fullscreenBtn').textContent = on ? 'Exit fullscreen' : 'Fullscreen';
}
$('#fullscreenBtn').addEventListener('click', async () => {
  if (document.body.classList.contains('theater')) {
    setTheater(false);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    return;
  }
  setTheater(true);
  await document.documentElement.requestFullscreen?.().catch(() => {});
  screen.orientation?.lock?.('landscape').catch(() => {});
});
document.addEventListener('fullscreenchange', () => !document.fullscreenElement && setTheater(false));

$('#unmuteBtn').addEventListener('click', () => {
  video.muted = false;
  video.play().catch(() => {});
  $('#unmuteBtn').hidden = true;
});

$('#syncForm').addEventListener('submit', (e) => {
  e.preventDefault();
  send({ t: 'sync', seconds: Number($('#syncInput').value) || 0 });
});
$('#shareBtn').addEventListener('click', startShare);
$('#stopBtn').addEventListener('click', () => stopShare());

if (IS_HOST) {
  $('#hostPanel').hidden = false;
  $('#predHost').hidden = false;
  $('#joinEyebrow').textContent = 'Host';
  $('#joinTitle').textContent = 'Open the party room';
  $('#joinBtn').textContent = 'Open room';
  showStage('You are off air', 'Click “Share screen” and pick the Willow TV tab.');
  $('#hostLink').innerHTML = 'Friends join with your tunnel link. Test as a viewer in incognito: <code>http://localhost:8090/?view</code>';
}

try { $('#nameInput').value = localStorage.getItem('wp-name') || (IS_HOST ? 'Host' : ''); } catch {}

$('#joinForm').addEventListener('submit', (e) => {
  e.preventDefault();
  myName = $('#nameInput').value.trim().slice(0, 24) || 'Guest';
  try { localStorage.setItem('wp-name', myName); } catch {}
  $('#joinOverlay').hidden = true;
  connect();
});
