// PULSE // LAN — servidor de rede local (Node + ws)
// Corre: npm install && npm start   (depois abre o IP indicado no terminal noutros PCs da LAN)

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const CLIENT_FILE = path.join(__dirname, 'pulse-arena-mvp.html');
const MATCH_SAFETY_MS = 1000 * 60 * 5; // failsafe: termina ronda pendurada ao fim de 5 min

// ---------- servidor HTTP: serve o cliente ----------
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/' || url === '/index.html') {
    fs.readFile(CLIENT_FILE, (e, data) => {
      if (e) { res.writeHead(500); res.end('Cliente nao encontrado (pulse-arena-mvp.html ao lado do server.js).'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  } else { res.writeHead(404); res.end('404'); }
});

const wss = new WebSocketServer({ server });

// ---------- estado ----------
const rooms = new Map();   // id -> room
const clients = new Set(); // client objects
let nextRoom = 1;
const rid = () => 'r' + (nextRoom++);
const uid = () => 'u' + Math.random().toString(36).slice(2, 8);

function send(ws, msg) { try { ws.send(JSON.stringify(msg)); } catch (e) {} }
function broadcast(room, msg) { for (const p of room.players.values()) send(p.ws, msg); }

function roomInfo(room) {
  return { id: room.id, name: room.name, locked: !!room.password, count: room.players.size, max: 8, inGame: room.state !== 'lobby', championship: room.championship };
}
function roomState(room) {
  return {
    id: room.id, name: room.name, hostId: room.hostId, championship: room.championship, state: room.state, locked: !!room.password,
    map: room.map ? { title: room.map.title, bpm: room.map.bpm, notes: (room.map.notes || []).length, hasAudio: !!room.map.audio } : null,
    players: [...room.players.values()].map(p => ({ id: p.id, name: p.name, ready: p.ready, eliminated: p.eliminated, host: p.id === room.hostId }))
  };
}
function listRoomsMsg() {
  return { type: 'rooms', rooms: [...rooms.values()].filter(r => r.state === 'lobby').map(roomInfo) };
}
function broadcastRoom(room) { broadcast(room, { type: 'roomUpdate', room: roomState(room) }); }
function broadcastLobbyList() { for (const c of clients) if (!c.room) send(c.ws, listRoomsMsg()); }

// ---------- ligação ----------
wss.on('connection', (ws) => {
  const client = { id: uid(), ws, name: 'Jogador', room: null };
  clients.add(client);
  send(ws, { type: 'welcome', id: client.id });
  send(ws, listRoomsMsg());

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    try { handle(client, m); } catch (e) { console.error('handler', e); }
  });
  ws.on('close', () => { onMatchLeave(client); leaveRoom(client); clients.delete(client); });
  ws.on('error', () => {});
});

function handle(c, m) {
  switch (m.type) {
    case 'hello': c.name = String(m.name || 'Jogador').slice(0, 16); break;
    case 'listRooms': send(c.ws, listRoomsMsg()); break;
    case 'ping': send(c.ws, { type: 'pong', t: m.t, serverTime: Date.now() }); break;
    case 'createRoom': {
      if (c.room) leaveRoom(c);
      const room = { id: rid(), name: String(m.roomName || 'Sala').slice(0, 24), password: m.password || null, championship: !!m.championship, hostId: c.id, players: new Map(), state: 'lobby', map: null, round: 0 };
      rooms.set(room.id, room);
      joinRoomObj(c, room);
      break;
    }
    case 'joinRoom': {
      const room = rooms.get(m.roomId);
      if (!room) return send(c.ws, { type: 'error', message: 'Sala nao existe' });
      if (room.state !== 'lobby') return send(c.ws, { type: 'error', message: 'Jogo a decorrer' });
      if (room.players.size >= 8) return send(c.ws, { type: 'error', message: 'Sala cheia' });
      if (room.password && room.password !== m.password) return send(c.ws, { type: 'error', message: 'Password errada' });
      if (c.room) leaveRoom(c);
      joinRoomObj(c, room);
      break;
    }
    case 'leaveRoom': leaveRoom(c); send(c.ws, listRoomsMsg()); break;
    case 'ready': { const p = c.room && c.room.players.get(c.id); if (p) { p.ready = !!m.ready; broadcastRoom(c.room); } break; }
    case 'setMap': { if (c.room && c.room.hostId === c.id && c.room.state === 'lobby') { c.room.map = m.map; broadcastRoom(c.room); } break; }
    case 'start': startMatch(c); break;
    case 'score': relayScore(c, m); break;
    case 'finished': playerFinished(c, m); break;
  }
}

function joinRoomObj(c, room) {
  c.room = room;
  room.players.set(c.id, { id: c.id, name: c.name, ws: c.ws, ready: false, eliminated: false, score: 0, combo: 0, acc: 100, dead: false, finished: false, maxCombo: 0 });
  send(c.ws, { type: 'joined', you: c.id, room: roomState(room) });
  broadcastRoom(room);
  broadcastLobbyList();
}
function leaveRoom(c) {
  const room = c.room; if (!room) return;
  room.players.delete(c.id); c.room = null;
  if (room.players.size === 0) { rooms.delete(room.id); }
  else { if (room.hostId === c.id) room.hostId = room.players.keys().next().value; broadcastRoom(room); }
  broadcastLobbyList();
}

function startMatch(c) {
  const room = c.room; if (!room || room.hostId !== c.id) return;
  if (!room.map) return send(c.ws, { type: 'error', message: 'Escolhe um mapa primeiro' });
  let active = [...room.players.values()].filter(p => !p.eliminated);
  // novo campeonato: se so resta 1 ativo (campeao anterior), repoe eliminacoes
  if (active.length < 2 && room.players.size >= 2) {
    for (const p of room.players.values()) p.eliminated = false;
    active = [...room.players.values()];
  }
  if (active.length < 2) return send(c.ws, { type: 'error', message: 'Sao precisos 2+ jogadores' });

  room.state = 'playing'; room.round++;
  for (const p of room.players.values()) { p.score = 0; p.combo = 0; p.acc = 100; p.dead = false; p.finished = false; p.maxCombo = 0; }
  const startAt = Date.now() + 3000; // todos arrancam a este instante (sincronizado por relogio do servidor)
  broadcast(room, { type: 'matchStart', startAt, round: room.round, map: room.map, players: active.map(p => ({ id: p.id, name: p.name })) });
  clearTimeout(room._safety);
  room._safety = setTimeout(() => { if (room.state === 'playing') endMatch(room); }, MATCH_SAFETY_MS);
  broadcastLobbyList();
}

function relayScore(c, m) {
  const room = c.room; if (!room || room.state !== 'playing') return;
  const p = room.players.get(c.id); if (!p) return;
  p.score = m.score | 0; p.combo = m.combo | 0; p.acc = +m.acc || 0; p.dead = !!m.dead;
  if (!room._lbPending) { room._lbPending = true; setTimeout(() => { room._lbPending = false; broadcast(room, leaderboardMsg(room)); }, 150); }
}
function leaderboardMsg(room) {
  const entries = [...room.players.values()].filter(p => !p.eliminated)
    .map(p => ({ id: p.id, name: p.name, score: p.score, combo: p.combo, acc: p.acc, dead: p.dead, finished: p.finished }))
    .sort((a, b) => b.score - a.score);
  return { type: 'leaderboard', entries };
}
function playerFinished(c, m) {
  const room = c.room; if (!room || room.state !== 'playing') return;
  const p = room.players.get(c.id); if (!p) return;
  p.finished = true; p.score = m.score | 0; p.acc = +m.acc || 0; p.maxCombo = m.maxCombo | 0;
  const active = [...room.players.values()].filter(x => !x.eliminated);
  if (active.length && active.every(x => x.finished)) endMatch(room);
}
function endMatch(room) {
  clearTimeout(room._safety);
  room.state = 'lobby';
  const active = [...room.players.values()].filter(p => !p.eliminated);
  const ranking = active.map(p => ({ id: p.id, name: p.name, score: p.score, acc: p.acc || 0 })).sort((a, b) => b.score - a.score);
  let eliminated = null, champion = null;
  if (room.championship && active.length > 1) {
    const worst = ranking[ranking.length - 1];
    const pl = room.players.get(worst.id);
    if (pl) { pl.eliminated = true; eliminated = worst.id; }
    const remain = [...room.players.values()].filter(p => !p.eliminated);
    if (remain.length === 1) champion = remain[0].id;
  }
  for (const p of room.players.values()) p.ready = false;
  broadcast(room, { type: 'matchEnd', ranking, eliminated, champion, championship: room.championship });
  broadcastRoom(room);
  broadcastLobbyList();
}
function onMatchLeave(c) {
  const room = c.room; if (!room || room.state !== 'playing') return;
  const p = room.players.get(c.id); if (p) { p.finished = true; p.dead = true; }
  const active = [...room.players.values()].filter(x => !x.eliminated);
  if (active.length && active.every(x => x.finished)) endMatch(room);
}

// ---------- arranque ----------
server.listen(PORT, () => {
  console.log('\nPULSE // LAN  —  servidor a correr');
  console.log('  Local:  http://localhost:' + PORT);
  const ifs = os.networkInterfaces();
  for (const name in ifs) for (const i of ifs[name]) if (i.family === 'IPv4' && !i.internal)
    console.log('  LAN:    http://' + i.address + ':' + PORT + '   (abre isto nos outros PCs)');
  console.log('');
});
