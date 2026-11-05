// Kritzel-Duell server: serves the game and relays messages between the two players of a room.
// No dependencies, just Node.js 18+. Start with: node server.js
const http = require("http"), fs = require("fs"), path = require("path");
const PORT = process.env.PORT || 3000;
const INDEX = path.join(__dirname, "index.html");
const rooms = new Map(); // code -> {host, guest, clients: Map(pid -> res), state, last}
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const newCode = () => { let c; do { c = ""; for (let i = 0; i < 4; i++) c += LETTERS[Math.floor(Math.random() * LETTERS.length)]; } while (rooms.has(c)); return c; };
const okId = s => typeof s === "string" && /^[A-Za-z0-9_-]{4,40}$/.test(s);
const okCode = s => typeof s === "string" && /^[A-Z]{4}$/.test(s);

function json(res, status, obj) { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(obj)); }
function push(res, obj) { try { res.write("data: " + JSON.stringify(obj) + "\n\n"); } catch (e) {} }
function other(room, pid) { for (const [id, res] of room.clients) if (id !== pid) return res; return null; }
function readBody(req, cb) {
  let size = 0, chunks = [];
  req.on("data", c => { size += c.length; if (size > 1e6) { req.destroy(); return; } chunks.push(c); });
  req.on("end", () => { try { cb(JSON.parse(Buffer.concat(chunks).toString() || "null")); } catch (e) { cb(undefined); } });
}

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const q = url.searchParams;

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    fs.readFile(INDEX, (err, data) => {
      if (err) { res.writeHead(500); res.end("index.html fehlt"); return; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" }); res.end(data);
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/health") { res.writeHead(200); res.end("ok"); return; }

  if (req.method === "POST" && url.pathname === "/api/create") {
    readBody(req, b => {
      if (!b || !okId(b.pid)) return json(res, 400, { error: "bad_request" });
      let code = okCode(b.code) ? b.code : null;
      if (code && rooms.has(code)) {
        const r = rooms.get(code);
        if (r.host !== b.pid) code = null; // taken by someone else
        else return json(res, 200, { code });
      }
      code = code || newCode();
      rooms.set(code, { host: b.pid, guest: null, clients: new Map(), state: null, last: Date.now() });
      json(res, 200, { code });
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/room") {
    const r = rooms.get(String(q.get("room") || "").toUpperCase());
    return json(res, 200, { exists: !!r, open: !!r && (!r.guest || !r.clients.has(r.guest)) });
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    const code = String(q.get("room") || "").toUpperCase(), pid = q.get("pid");
    const room = rooms.get(code);
    if (!room || !okId(pid)) return json(res, 404, { error: "no_room" });
    let role;
    if (pid === room.host) role = "host";
    else if (!room.guest || room.guest === pid || !room.clients.has(room.guest)) { room.guest = pid; role = "guest"; }
    else return json(res, 409, { error: "full" });

    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
    res.write("retry: 2000\n\n");
    const old = room.clients.get(pid); if (old) try { old.end(); } catch (e) {}
    room.clients.set(pid, res); room.last = Date.now();
    const peer = other(room, pid);
    push(res, { t: "joined", role, peerOnline: !!peer });
    if (role === "guest" && room.state) push(res, room.state);
    if (peer) push(peer, { t: "peer", online: true });
    req.on("close", () => {
      if (room.clients.get(pid) === res) {
        room.clients.delete(pid);
        const p = other(room, pid); if (p) push(p, { t: "peer", online: false });
      }
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/send") {
    const room = rooms.get(String(q.get("room") || "").toUpperCase()), pid = q.get("pid");
    if (!room || (pid !== room.host && pid !== room.guest)) return json(res, 404, { error: "no_room" });
    readBody(req, msgs => {
      if (!Array.isArray(msgs)) return json(res, 400, { error: "bad_request" });
      room.last = Date.now();
      const peer = other(room, pid);
      for (const m of msgs) {
        if (!m || typeof m !== "object") continue;
        if (pid === room.host && m.t === "state") room.state = m;
        if (peer) push(peer, m);
      }
      res.writeHead(204); res.end();
    });
    return;
  }

  res.writeHead(404); res.end("Nicht gefunden");
}).listen(PORT, () => console.log("Kritzel-Duell läuft auf http://localhost:" + PORT));

// keep connections alive through hosting proxies, and forget rooms idle for 12 hours
setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms) {
    for (const res of r.clients.values()) try { res.write(": ping\n\n"); } catch (e) {}
    if (!r.clients.size && now - r.last > 12 * 3600e3) rooms.delete(code);
  }
}, 20000);
