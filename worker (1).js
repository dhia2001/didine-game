// Didine Fighter online server (Cloudflare Worker + Durable Object)
// 1v1 rooms: /room/CODE      2v2 rooms (4 players): /room/CODE?m=4
// Tournament lobby (4-10 players): /room/CODE?t=N  (creator)  /room/CODE?j=1 (joiners)
// Each tournament match is played in a normal 1v1 room named by the server.
const RELAY = new Set(["c", "i", "s", "rm", "e", "cfg"]);
const AL = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const rnd = (n) => { let s = ""; for (let i = 0; i < n; i++) s += AL[(Math.random() * AL.length) | 0]; return s; };
const clean = (s) => String(s == null ? "" : s).replace(/[<>&"'\u0000-\u001f]/g, "").trim().slice(0, 12);
const shuf = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/room\/([A-Za-z0-9]{3,8})$/);
    if (!m) return new Response("Didine Fighter server OK");
    const id = env.ROOM.idFromName(m[1].toUpperCase());
    return env.ROOM.get(id).fetch(request);
  },
};

export class Room {
  constructor(state, env) {
    this.state = state;
    this.cap = 2;
    this.slots = new Map(); // slot number -> WebSocket
    this.tm = false;        // tournament lobby mode
    this.started = false;
    this.pl = new Map();    // slot -> {n,c,l}
    this.rounds = [];
    this.ri = 0;
    this.tok = "";
    this.champ = null;
    this.timers = new Map();
  }

  broadcast(obj, except) {
    const s = JSON.stringify(obj);
    for (const [k, w] of this.slots) {
      if (k !== except) {
        try { w.send(s); } catch (e) {}
      }
    }
  }
  send(slot, obj) { const w = this.slots.get(slot); if (w) { try { w.send(JSON.stringify(obj)); } catch (e) {} } }

  /* ---------------- tournament ---------------- */
  host() { let h = 0; for (const k of this.slots.keys()) if (!h || k < h) h = k; return h; }
  plObj() { const o = {}; for (const [k, v] of this.pl) o[k] = v; return o; }
  lobby() { this.broadcast({ t: "lobby", pl: this.plObj(), cap: this.cap, host: this.host() }); }
  bracket() { this.broadcast({ t: "br", rounds: this.rounds.map((r) => r.map((m) => ({ a: m.a, b: m.b, w: m.w, rm: m.rm }))), ri: this.ri, pl: this.plObj() }); }
  startTour() {
    const ids = shuf([...this.pl.keys()]);
    const n = ids.length;
    let size = 2; while (size < n) size *= 2;
    const byes = size - n, pairs = [];
    for (let i = 0; i < byes; i++) pairs.push([ids.pop(), null]);
    for (let i = 0; i < ids.length; i += 2) pairs.push([ids[i], ids[i + 1]]);
    shuf(pairs);
    this.started = true;
    this.tok = rnd(3);
    this.rounds = [pairs.map((p, i) => ({ a: p[0], b: p[1], w: p[1] == null ? p[0] : null, rep: {}, rm: "", try: 0 }))];
    this.ri = 0;
    this.runRound();
  }
  mkRm(m, i) { return "T" + this.tok + this.ri + i + (m.try ? "XYZ"[m.try - 1] : ""); }
  runRound() {
    const r = this.rounds[this.ri];
    r.forEach((m, i) => { if (m.w == null) this.startMatch(m, i); });
    this.bracket();
    this.checkRound();
  }
  startMatch(m, i) {
    if (!this.slots.has(m.a) && !this.slots.has(m.b)) { m.w = Math.random() < .5 ? m.a : m.b; return; }
    if (!this.slots.has(m.a)) { m.w = m.b; return; }
    if (!this.slots.has(m.b)) { m.w = m.a; return; }
    m.rep = {};
    m.rm = this.mkRm(m, i);
    this.send(m.a, { t: "m", rm: m.rm, o: m.b });
    this.send(m.b, { t: "m", rm: m.rm, o: m.a });
    clearTimeout(this.timers.get(m.rm));
    // Safety net: a match that never reports is decided at random after 8 minutes.
    this.timers.set(m.rm, setTimeout(() => this.resolve(m, Math.random() < .5 ? m.a : m.b), 8 * 60 * 1000));
  }
  resolve(m, w) {
    if (m.w != null) return;
    m.w = w;
    clearTimeout(this.timers.get(m.rm)); this.timers.delete(m.rm);
    this.bracket();
    this.checkRound();
  }
  checkRound() {
    const r = this.rounds[this.ri];
    if (r.some((m) => m.w == null)) return;
    if (r.length === 1) { this.champ = r[0].w; this.bracket(); this.broadcast({ t: "champ", w: this.champ }); return; }
    const nx = [];
    for (let i = 0; i < r.length; i += 2) nx.push({ a: r[i].w, b: r[i + 1].w, w: null, rep: {}, rm: "", try: 0 });
    this.rounds.push(nx);
    this.ri++;
    this.runRound();
  }
  report(slot, m) {
    const r = this.rounds[this.ri];
    if (!this.started || !r) return;
    const i = r.findIndex((x) => x.rm === m.rm && x.w == null);
    if (i < 0) return;
    const mt = r[i];
    if (slot !== mt.a && slot !== mt.b) return;
    const other = slot === mt.a ? mt.b : mt.a;
    mt.rep[slot] = { w: m.w ? 1 : 0, ff: m.ff ? 1 : 0 };
    const me = mt.rep[slot], ot = mt.rep[other];
    if (me.w === 0) return this.resolve(mt, other);            // a concession is always trusted
    if (ot) {
      if (ot.w === 0) return this.resolve(mt, slot);
      if (me.ff && !ot.ff) return this.resolve(mt, other);
      if (ot.ff && !me.ff) return this.resolve(mt, slot);
      // both claim victory: replay (max 3 times), then random
      if (mt.try >= 3) return this.resolve(mt, Math.random() < .5 ? mt.a : mt.b);
      clearTimeout(this.timers.get(mt.rm)); this.timers.delete(mt.rm);
      mt.try++; this.startMatch(mt, i); this.bracket(); return;
    }
    // only one report so far: accept it after 20 seconds if the other side stays silent
    clearTimeout(this.timers.get(mt.rm));
    this.timers.set(mt.rm, setTimeout(() => this.resolve(mt, slot), 20000));
  }
  tourGone(slot) {
    this.pl.delete(slot);
    if (!this.started) { this.lobby(); return; }
    const r = this.rounds[this.ri];
    if (r) r.forEach((m) => {
      if (m.w == null && (m.a === slot || m.b === slot)) {
        const o = m.a === slot ? m.b : m.a;
        if (o != null && this.slots.has(o)) this.resolve(m, o);
        else if (o == null || !this.slots.has(o)) this.resolve(m, o == null ? slot : (Math.random() < .5 ? m.a : m.b));
      }
    });
  }
  tmsg(slot, server, m) {
    if (m.t === "p") { try { server.send(JSON.stringify({ t: "q", ts: m.ts })); } catch (e) {} return; }
    if (m.t === "join") {
      if (this.started) return;
      this.pl.set(slot, { n: clean(m.n) || "لاعب", c: Number.isInteger(m.c) && m.c >= 0 && m.c < 64 ? m.c : 0, l: Math.max(1, Math.min(10, m.l | 0 || 1)) });
      this.lobby();
    } else if (m.t === "go") {
      if (this.started || slot !== this.host() || this.pl.size < 4) return;
      this.startTour();
    } else if (m.t === "res") {
      if (typeof m.rm === "string" && m.rm.length <= 8) this.report(slot, m);
    }
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const q = new URL(request.url).searchParams;
    if (this.slots.size === 0) {
      // The first player in an empty room decides the room type and size.
      this.tm = false; this.started = false; this.pl = new Map(); this.rounds = []; this.champ = null;
      const t = parseInt(q.get("t"), 10);
      if (t >= 4 && t <= 10) { this.tm = true; this.cap = t; }
      else if (q.get("j") === "1") return new Response("No tournament", { status: 404 });
      else this.cap = q.get("m") === "4" ? 4 : 2;
    } else if (q.get("j") === "1" && !this.tm) {
      return new Response("Not a tournament", { status: 404 });
    }
    if (this.tm && this.started) return new Response("Tournament already started", { status: 403 });
    let slot = 0;
    for (let i = 1; i <= this.cap; i++) {
      if (!this.slots.has(i)) { slot = i; break; }
    }
    if (!slot) return new Response("Room full", { status: 403 });

    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    server.accept();
    this.slots.set(slot, server);

    // Announce after the 101 response has been returned, so the client is ready.
    setTimeout(() => {
      try { server.send(JSON.stringify({ t: "hello", slot, cap: this.cap, tm: this.tm ? 1 : 0 })); } catch (e) {}
      if (this.tm) return;
      this.broadcast({ t: "n", n: this.slots.size, cap: this.cap });
      if (this.slots.size === this.cap) this.broadcast({ t: "start" });
    }, 0);

    // Anti-abuse: limit each socket to 60 messages per second and ignore floods.
    let winStart = Date.now(), winCount = 0;
    server.addEventListener("message", (ev) => {
      const now = Date.now();
      if (now - winStart > 1000) { winStart = now; winCount = 0; }
      if (++winCount > 60) return;
      if (typeof ev.data !== "string" || ev.data.length > 2000) return;
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (!m || typeof m !== "object") return;
      if (this.tm) { this.tmsg(slot, server, m); return; }
      if (m.t === "p") {
        try { server.send(JSON.stringify({ t: "q", ts: m.ts })); } catch (e) {}
        return;
      }
      if (!RELAY.has(m.t)) return;
      // Basic sanity: character index and numeric fields must be sane.
      if (m.c !== undefined && !(Number.isInteger(m.c) && m.c >= 0 && m.c < 64)) return;
      if (m.hp !== undefined && !(typeof m.hp === "number" && m.hp >= 0 && m.hp <= 100)) return;
      m.f = slot; // sender slot, trusted (set by the server)
      this.broadcast(m, slot);
    });

    const gone = () => {
      if (this.slots.get(slot) !== server) return;
      this.slots.delete(slot);
      if (this.tm) { this.tourGone(slot); return; }
      this.broadcast({ t: "left", f: slot });
      this.broadcast({ t: "n", n: this.slots.size, cap: this.cap });
    };
    server.addEventListener("close", gone);
    server.addEventListener("error", gone);

    return new Response(null, { status: 101, webSocket: client });
  }
}
