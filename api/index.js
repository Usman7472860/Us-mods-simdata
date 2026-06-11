/**
 * US MOD MD V2 — Vercel Fix
 * api/index.js — proper serverless entry point
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  proto,
  getContentType,
} = require("@whiskeysockets/baileys");

const pino     = require("pino");
const { Boom } = require("@hapi/boom");
const fs       = require("fs-extra");
const path     = require("path");

// Config — relative to repo root (included via vercel.json includeFiles)
const config = require("../config");

// /tmp is the only writable dir on Vercel
const SESSIONS_DIR = "/tmp/wa_sessions";
fs.ensureDirSync(SESSIONS_DIR);

// Global session store — survives warm invocations
if (!global._bots) global._bots = {};
const bots = global._bots;

// ── Start / reconnect a WhatsApp session ─────────────────────────────────────
async function startSession(phone) {
  phone = phone.replace(/[^0-9]/g, "");
  if (!phone || phone.length < 10) throw new Error("Invalid phone number");

  if (bots[phone]?.sock) {
    try { bots[phone].sock.end(); } catch (_) {}
  }

  const sessionPath = path.join(SESSIONS_DIR, phone);
  fs.ensureDirSync(sessionPath);

  bots[phone] = { status: "connecting", phone, code: null, connectedAt: null, sock: null };

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

  const sock = makeWASocket({
    version: [2, 3000, 1015901307],
    logger: pino({ level: "silent" }),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
    },
    browser: ["Ubuntu", "Chrome", "20.0.04"],
    printQRInTerminal: false,
    syncFullHistory: false,
    connectTimeoutMs: 60_000,
    keepAliveIntervalMs: 10_000,
    getMessage: async () => proto.Message.fromObject({}),
  });

  bots[phone].sock = sock;
  sock.ev.on("creds.update", saveCreds);

  let pairingDone = false;

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "open" && !sock.authState.creds.registered && !pairingDone) {
      pairingDone = true;
      bots[phone].status = "waiting_pair";
      try {
        await new Promise(r => setTimeout(r, 1500));
        const raw  = await sock.requestPairingCode(phone);
        const code = raw.match(/.{1,4}/g)?.join("-") || raw;
        bots[phone].code = code;
        console.log(`[${phone}] Pairing code: ${code}`);
      } catch (err) {
        console.error(`[${phone}] Pairing error:`, err.message);
        bots[phone].status = "offline";
        bots[phone].code   = null;
        pairingDone = false;
        setTimeout(() => startSession(phone).catch(console.error), 12_000);
      }
      return;
    }

    if (connection === "open" && sock.authState.creds.registered) {
      bots[phone].status      = "online";
      bots[phone].code        = null;
      bots[phone].connectedAt = new Date().toISOString();
      console.log(`[${phone}] ✅ Online`);
    }

    if (connection === "close") {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      if (
        reason === DisconnectReason.badSession ||
        reason === DisconnectReason.loggedOut  ||
        reason === 405
      ) {
        bots[phone].status = "banned";
        fs.removeSync(sessionPath);
      } else {
        bots[phone].status = "offline";
        setTimeout(() => startSession(phone).catch(console.error), 5_000);
      }
    }
  });

  // ── Message handler ──────────────────────────────────────────────────────
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (!msg.message) continue;
      if (msg.key.fromMe && !config.selfReply) continue;

      const from    = msg.key.remoteJid;
      const isGroup = from.endsWith("@g.us");
      const sender  = isGroup ? (msg.key.participant || from) : from;
      const msgType = getContentType(msg.message);
      const body    =
        msg.message?.conversation ||
        msg.message?.[msgType]?.text ||
        msg.message?.[msgType]?.caption || "";

      const isCmd   = body.startsWith(config.prefix);
      const command = isCmd ? body.slice(config.prefix.length).trim().split(/ +/).shift().toLowerCase() : "";
      const args    = body.trim().split(/ +/).slice(1);
      const text    = args.join(" ");
      const isOwner = sender.replace(/\D/g, "") === config.ownerNumber.replace(/\D/g, "");
      const reply   = (content) => sock.sendMessage(from, { text: content }, { quoted: msg });

      if (isCmd) {
        try {
          // path.resolve so it works from /api/index.js
          const cmdPath = path.resolve(__dirname, "..", "commands", `${command}.js`);
          if (fs.existsSync(cmdPath)) {
            delete require.cache[require.resolve(cmdPath)]; // hot reload
            const mod = require(cmdPath);
            await mod({ sock, msg, from, sender, args, text, isOwner, reply, isGroup, config });
          } else {
            await reply(`❌ Command *${config.prefix}${command}* nahi mila!`);
          }
        } catch (err) {
          console.error(`[${phone}] Command error [${command}]:`, err);
          await reply(`⚠️ Error: ${err.message}`);
        }
      }
    }
  });

  return sock;
}

// ── Restore sessions saved in /tmp (warm restarts) ───────────────────────────
async function restoreSessions() {
  try {
    const dirs = fs.readdirSync(SESSIONS_DIR).filter(d =>
      fs.statSync(path.join(SESSIONS_DIR, d)).isDirectory()
    );
    for (const phone of dirs) {
      if (!bots[phone] || bots[phone].status === "offline") {
        console.log(`[startup] Restoring: ${phone}`);
        await startSession(phone).catch(e =>
          console.error(`[startup] ${phone} failed:`, e.message)
        );
      }
    }
  } catch (_) {}
}

// ─── HTML ─────────────────────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>US MOD MD V2</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0a0a0a;--surface:#111;--card:#161616;--border:#222;--accent:#00e5a0;--red:#ff4f4f;--yellow:#f5c518;--text:#f0f0f0;--muted:#555;--font:'Courier New',monospace}
body{background:var(--bg);color:var(--text);font-family:var(--font);min-height:100vh;padding:20px}
.header{margin-bottom:28px;border-bottom:1px solid var(--border);padding-bottom:16px}
.logo{font-size:10px;letter-spacing:3px;color:var(--accent);text-transform:uppercase}
h1{font-size:18px;font-weight:700;margin-top:4px}
.sub{font-size:11px;color:var(--muted);margin-top:2px}
.warn{background:rgba(245,197,24,.08);border:1px solid var(--yellow);border-radius:8px;padding:12px 16px;margin-bottom:20px;font-size:12px;color:var(--yellow);line-height:1.7}
.add-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:20px;margin-bottom:24px}
.add-card h2{font-size:12px;letter-spacing:2px;color:var(--accent);text-transform:uppercase;margin-bottom:14px}
.row{display:flex;gap:10px;flex-wrap:wrap}
input[type=tel]{flex:1;min-width:180px;background:var(--bg);border:1px solid var(--border);border-radius:7px;padding:10px 13px;color:var(--text);font-family:var(--font);font-size:15px;outline:none;transition:border-color .2s}
input[type=tel]:focus{border-color:var(--accent)}
.btn{padding:10px 20px;border:none;border-radius:7px;font-family:var(--font);font-size:13px;font-weight:700;cursor:pointer;transition:opacity .2s;white-space:nowrap}
.btn:hover{opacity:.85}.btn:disabled{opacity:.35;cursor:not-allowed}
.btn-green{background:var(--accent);color:#000}.btn-red{background:var(--red);color:#fff}.btn-yellow{background:var(--yellow);color:#000}
.btn-sm{padding:6px 12px;font-size:11px}
#grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px}
.card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:16px;transition:border-color .3s}
.card.online{border-color:var(--accent)}.card.banned{border-color:var(--red)}.card.waiting_pair{border-color:var(--yellow)}
.top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px}
.phone{font-size:16px;font-weight:700;letter-spacing:1px}
.badge{font-size:10px;letter-spacing:1.5px;text-transform:uppercase;padding:3px 8px;border-radius:4px}
.online .badge{background:rgba(0,229,160,.15);color:var(--accent)}
.offline .badge,.connecting .badge{background:rgba(85,85,85,.2);color:var(--muted)}
.waiting_pair .badge{background:rgba(245,197,24,.15);color:var(--yellow)}
.banned .badge{background:rgba(255,79,79,.15);color:var(--red)}
.codebox{background:var(--bg);border:1px solid var(--yellow);border-radius:7px;padding:12px;text-align:center;margin-bottom:12px;display:none}
.code-lbl{font-size:9px;letter-spacing:2px;color:var(--yellow);margin-bottom:6px}
.code-val{font-size:26px;font-weight:900;letter-spacing:5px;color:var(--yellow)}
.code-hint{font-size:10px;color:var(--muted);margin-top:6px}
.actions{display:flex;gap:8px;flex-wrap:wrap}
.meta{font-size:10px;color:var(--muted);margin-top:10px}
#toast{position:fixed;bottom:20px;right:20px;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px 18px;font-size:13px;opacity:0;transition:opacity .3s;pointer-events:none;z-index:99}
#toast.show{opacity:1}
.empty{text-align:center;padding:50px;color:var(--muted);font-size:13px}
.spin{display:inline-block;width:12px;height:12px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:sp .7s linear infinite;vertical-align:middle;margin-right:5px}
@keyframes sp{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div class="header">
  <div class="logo">US MOD MD V2</div>
  <h1>Multi-Session Manager</h1>
  <div class="sub">Owner: M Usman Chachar &nbsp;|&nbsp; Prefix: .</div>
</div>

<div class="warn">
  ⚠️ <b>Vercel /tmp Note:</b> Sessions cold restart ke baad reset ho sakti hain.
  Permanent sessions ke liye <b>Railway</b> ya <b>Render</b> better hai.
</div>

<div class="add-card">
  <h2>+ Naya Session</h2>
  <div class="row">
    <input type="tel" id="ph" placeholder="923001234567 (country code ke saath)"/>
    <button class="btn btn-green" id="abtn" onclick="add()">Connect</button>
  </div>
</div>

<div id="grid"><div class="empty">Koi session nahi. Upar number daalo.</div></div>
<div id="toast"></div>

<script>
function toast(m,c){const t=document.getElementById('toast');t.textContent=m;t.style.color=c||'#f0f0f0';t.classList.add('show');setTimeout(()=>t.classList.remove('show'),3000)}

async function add(){
  const ph=document.getElementById('ph').value.trim().replace(/\D/g,'');
  const btn=document.getElementById('abtn');
  if(!ph||ph.length<10){toast('Sahi number daalo','#ff4f4f');return}
  btn.disabled=true;btn.innerHTML='<span class="spin"></span>Connecting...';
  try{
    const r=await fetch('/api/session/add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:ph})});
    const d=await r.json();
    if(d.ok){toast('Session start ho raha hai...','#00e5a0');document.getElementById('ph').value='';}
    else toast(d.error||'Error','#ff4f4f');
  }catch(e){toast('Server error','#ff4f4f')}
  btn.disabled=false;btn.innerHTML='Connect';
}

async function del(ph){
  if(!confirm(ph+' delete karo?'))return;
  await fetch('/api/session/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:ph})});
  toast('Deleted','#f5c518');
}
async function rst(ph){
  await fetch('/api/session/restart',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:ph})});
  toast(ph+' restart ho raha...','#f5c518');
}

function render(data){
  const grid=document.getElementById('grid');
  const list=Object.values(data);
  if(!list.length){grid.innerHTML='<div class="empty">Koi session nahi. Upar number daalo.</div>';return;}
  const labels={online:'Online',offline:'Offline',connecting:'Connecting...',waiting_pair:'Code Aaya!',banned:'Banned'};
  grid.innerHTML=list.map(s=>{
    const cb=s.status==='waiting_pair'&&s.code
      ?'<div class="codebox" style="display:block"><div class="code-lbl">Pairing Code</div><div class="code-val">'+s.code+'</div><div class="code-hint">WhatsApp → Linked Devices → Link with Phone Number</div></div>'
      :'';
    const ca=s.connectedAt?'<div class="meta">Connected: '+new Date(s.connectedAt).toLocaleString()+'</div>':'';
    return '<div class="card '+s.status+'"><div class="top"><div class="phone">+'+s.phone+'</div><span class="badge">'+(labels[s.status]||s.status)+'</span></div>'+cb+'<div class="actions"><button class="btn btn-yellow btn-sm" onclick="rst(\''+s.phone+'\')">↺ Restart</button><button class="btn btn-red btn-sm" onclick="del(\''+s.phone+'\')">✕ Delete</button></div>'+ca+'</div>';
  }).join('');
}

async function poll(){try{const r=await fetch('/api/sessions');render(await r.json())}catch(_){}}
poll();setInterval(poll,3000);
document.getElementById('ph').addEventListener('keydown',e=>{if(e.key==='Enter')add()});
</script>
</body>
</html>`;

// ── One-time init guard ───────────────────────────────────────────────────────
let booted = false;

// ─── Vercel handler export ────────────────────────────────────────────────────
module.exports = async (req, res) => {
  // Boot once per warm instance
  if (!booted) {
    booted = true;
    restoreSessions().catch(console.error);
  }

  const { pathname } = new URL(req.url, `http://${req.headers.host}`);

  // ── UI ────────────────────────────────────────────────────────────────────
  if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(HTML);
  }

  // ── GET /api/sessions ─────────────────────────────────────────────────────
  if (req.method === "GET" && pathname === "/api/sessions") {
    const out = {};
    for (const [ph, b] of Object.entries(bots)) {
      out[ph] = { phone: b.phone, status: b.status, code: b.code || null, connectedAt: b.connectedAt || null };
    }
    return res.status(200).json(out);
  }

  // ── POST ──────────────────────────────────────────────────────────────────
  if (req.method === "POST") {
    const body  = req.body || {};
    const phone = (body.phone || "").replace(/\D/g, "");

    if (pathname === "/api/session/add") {
      if (!phone || phone.length < 10) return res.status(400).json({ ok: false, error: "Invalid phone" });
      startSession(phone).catch(e => {
        console.error("[add]", e.message);
        if (bots[phone]) bots[phone].status = "offline";
      });
      return res.status(200).json({ ok: true });
    }

    if (pathname === "/api/session/delete") {
      if (bots[phone]?.sock) { try { bots[phone].sock.end(); } catch (_) {} }
      delete bots[phone];
      fs.removeSync(path.join(SESSIONS_DIR, phone));
      return res.status(200).json({ ok: true });
    }

    if (pathname === "/api/session/restart") {
      startSession(phone).catch(console.error);
      return res.status(200).json({ ok: true });
    }
  }

  return res.status(404).send("Not found");
};
