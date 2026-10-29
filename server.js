// CDN 26 · Fútbol 5 Arcade — servidor para render.com
// 1) Sirve el juego (index.html, assets/, íconos…)
// 2) Servidor de salas online por WebSocket en /ws: reenvía los mensajes entre el anfitrión y los jugadores.
//    Funciona con wifi y con datos móviles (no necesita conexión directa entre celulares) y aguanta cortes cortos de señal.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 10000;
const ROOT = __dirname;
const GRACE_MS = 20000;            // si alguien pierde la señal, se le guarda el lugar 20 s
const PRIVATE = new Set(['server.js', 'package.json', 'package-lock.json', 'render.yaml', 'node_modules', '.git', 'LEEME.txt']);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.txt': 'text/plain; charset=utf-8'
};

const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { res.writeHead(400); return res.end(); }
  if (p === '/health') { res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); return res.end('ok'); }
  if (p === '/relay.json') {                 // el juego pregunta dónde está el servidor de salas
    const https = String(req.headers['x-forwarded-proto'] || '').includes('https');
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
    return res.end(JSON.stringify({ url: (https ? 'wss://' : 'ws://') + req.headers.host + '/ws' }));
  }
  if (p.endsWith('/')) p += 'index.html';
  const first = p.split('/').filter(Boolean)[0] || '';
  if (PRIVATE.has(first)) { res.writeHead(404); return res.end('404'); }
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('404'); }
    const ext = path.extname(file).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const cache = ext === '.html' || ext === '.js' || ext === '.json' || ext === '.webmanifest' ? 'no-cache' : 'public, max-age=604800';
    const base = { 'content-type': type, 'cache-control': cache, 'accept-ranges': 'bytes' };
    const range = req.headers.range;
    if (range) {                           // música y video por partes (lo necesita el iPhone)
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0, end = m && m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (m && !m[1] && m[2]) { start = Math.max(0, st.size - parseInt(m[2], 10)); end = st.size - 1; }
      if (start >= st.size || end >= st.size || start > end) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { ...base, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...base, 'content-length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
});

// ---------------- Servidor de salas ----------------
const wss = new WebSocketServer({ server, path: '/ws', perMessageDeflate: false, maxPayload: 512 * 1024 });
const peers = new Map();       // id -> { id, tok, ws, buf, timer, contacts }
const send = (ws, o) => { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); } catch (e) {} };
const newId = () => { let id; do { id = 'p' + Math.random().toString(36).slice(2, 10); } while (peers.has(id)); return id; };
function remove(P) {
  if (peers.get(P.id) !== P) return;
  peers.delete(P.id); clearTimeout(P.timer);
  P.contacts.forEach(c => { const Q = peers.get(c); if (Q) { Q.contacts.delete(P.id); send(Q.ws, { op: 'gone', id: P.id }); } });
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  let me = null;
  ws.on('message', (raw) => {
    ws.isAlive = true;
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.op === 'reg') {
      const tok = String(m.tok || '').slice(0, 64);
      let id = typeof m.id === 'string' && /^[\w\-:.]{3,64}$/.test(m.id) ? m.id : null;
      if (id && peers.has(id)) {
        const P = peers.get(id);
        if (P.tok !== tok) return send(ws, { op: 'err', type: 'unavailable-id' });
        clearTimeout(P.timer); P.timer = null;                     // volvió: se le devuelve su lugar y lo que se perdió
        if (P.ws && P.ws !== ws) { try { P.ws.terminate(); } catch (e) {} }
        P.ws = ws; me = P;
        send(ws, { op: 'id', id });
        const b = P.buf; P.buf = []; b.forEach(s => { try { ws.send(s); } catch (e) {} });
        return;
      }
      if (!id) id = newId();
      me = { id, tok, ws, buf: [], timer: null, contacts: new Set() };
      peers.set(id, me);
      return send(ws, { op: 'id', id });
    }
    if (!me || me.ws !== ws) return;
    if (m.op === 'hb') return;
    if (m.op === 'bye') { remove(me); me = null; return; }
    if (m.op === 'conn' || m.op === 'ack' || m.op === 'd' || m.op === 'x') {
      const T = peers.get(String(m.to || ''));
      if (!T) {
        if (m.op === 'conn') send(ws, { op: 'err', type: 'peer-unavailable', cid: m.cid });
        else if (m.op === 'd') send(ws, { op: 'gone', id: m.to });
        return;
      }
      me.contacts.add(T.id); T.contacts.add(me.id);
      const out = { op: m.op, from: me.id, cid: m.cid };
      if (m.op === 'conn') { out.label = m.label; out.rel = m.rel; }
      if (m.op === 'd') out.d = m.d;
      const s = JSON.stringify(out);
      if (T.ws && T.ws.readyState === 1) {
        if (m.f && T.ws.bufferedAmount > 96 * 1024) return;          // señal lenta: se descartan jugadas viejas, no los mensajes importantes
        try { T.ws.send(s); } catch (e) {}
      } else if (!m.f) { T.buf.push(s); if (T.buf.length > 800) T.buf.shift(); }
    }
  });
  ws.on('close', () => {
    if (!me || me.ws !== ws) return;
    const P = me; P.ws = null;
    P.timer = setTimeout(() => remove(P), GRACE_MS);
  });
  ws.on('error', () => {});
});
// Revisa cada 15 s que las conexiones sigan vivas
setInterval(() => { wss.clients.forEach(ws => { if (!ws.isAlive) { try { ws.terminate(); } catch (e) {} return; } ws.isAlive = false; try { ws.ping(); } catch (e) {} }); }, 15000);

server.listen(PORT, () => console.log('CDN 26 listo en el puerto ' + PORT + ' · salas en /ws'));
