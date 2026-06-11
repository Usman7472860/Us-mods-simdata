/**
 * US MOD MD V2 — Multi-Session
 * Vercel-Compatible Server
 * By: M Usman Chachar
 *
 * NOTE: Vercel serverless mein sessions memory mein rahti hain.
 * Agar function cold start ho toh sessions reset ho sakti hain.
 * Isliye Railway / Render / Koyeb better hai persistent sessions ke liye.
 * Lekin agar sirf Vercel chahiye toh ye file use karo.
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  proto,
  getContentType,
} = require("@whiskeysockets/baileys");

const pino    = require("pino");
const { Boom } = require("@hapi/boom");
const fs      = require("fs-extra");
const path    = require("path");
const config  = require("./config");

// ── Vercel pe /tmp use karo (single writable directory) ──────────────────────
const SESSIONS_DIR = path.join("/tmp", "wa_sessions");
fs.ensureDirSync(SESSIONS_DIR);

// ── In-memory session registry ───────────────────────────────────────────────
const bots = {};

// ─── Bot Engine ───────────────────────────────────────────────────────────────
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
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 10000,
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
        setTimeout(() => startSession(phone), 12000);
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
      console.log(`[${phone}] ❌ Closed. Reason: ${reason}`);

      if (
        reason === DisconnectReason.badSession ||
        reason === DisconnectReason.loggedOut ||
        reason === 405
      ) {
        bots[phone].status = "banned";
        fs.removeSync(sessionPath);
        console.log(`[${phone}] Session cleared (${reason}). Restart from web.`);
      } else if (
        reason === DisconnectReason.connectionClosed ||
        reason === DisconnectReason.connectionLost  ||
        reason === DisconnectReason.restartRequired ||
        reason === DisconnectReason.timedOut
      ) {
        bots[phone].status = "offline";
        setTimeout(() => startSession(phone), 4000);
      } else {
        bots[phone].status = "offline";
        setTimeout(() => startSession(phone), 6000);
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
      const sender  = isGroup ? (msg.key.participant || msg.key.remoteJid) : msg.key.remoteJid;

      const msgType = getContentType(msg.message);
      const body =
        msg.message?.conversation ||
        msg.message?.[msgType]?.text ||
        msg.message?.[msgType]?.caption ||
        "";

      const isCmd   = body.startsWith(config.prefix);
      const command = isCmd ? body.slice(config.prefix.length).trim().split(/ +/).shift().toLowerCase() : "";
      const args    = body.trim().split(/ +/).slice(1);
      const text    = args.join(" ");
      const isOwner = sender.replace(/[^0-9]/g, "") === config.ownerNumber.replace(/[^0-9]/g, "");
      const reply   = (content) => sock.sendMessage(from, { text: content }, { quoted: msg });

      if (isCmd) {
        try {
          const cmdPath = path.join(__dirname, "commands", `${command}.js`);
          if (fs.existsSync(cmdPath)) {
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

// ── Auto-restore saved sessions on startup ───────────────────────────────────
async function restoreSessions() {
  try {
    const dirs = fs.readdirSync(SESSIONS_DIR).filter(d =>
      fs.statSync(path.join(SESSIONS_DIR, d)).isDirectory()
    );
    for (const phone of dirs) {
      console.log(`[startup] Restoring session: ${phone}`);
      await startSession(phone).catch(e => console.error(`[startup] ${phone} failed:`, e.message));
    }
  } catch (e) {
    console.log("[startup] No sessions to restore");
  }
}

// ─── HTML UI ─────────────────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>US MOD MD V2 — Sessions</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0a0a0a;--surface:#111;--card:#161616;--border:#222;
  --accent:#00e5a0;--accent2:#00b37a;--red:#ff4f4f;--yellow:#f5c518;
  --text:#f0f0f0;--muted:#555;--font:'Courier New',monospace
}
body{background:var(--bg);color:var(--text);font-family:var(--font);min-height:100vh;padding:20px}
.header{display:flex;align-items:center;gap:12px;margin-bottom:28px;border-bottom:1px solid var(--border);padding-bottom:16px}
.logo{font-size:10px;letter-spacing:3px;color:var(--accent);text-transform:uppercase}
.header h1{font-size:18px;font-weight:700}
.header .sub{font-size:11px;color:var(--muted);margin-top:2px}
.warn-box{background:rgba(245,197,24,.08);border:1px solid var(--yellow);border-radius:8px;padding:12px 16px;margin-bottom:20px;font-size:12px;color:var(--yellow);line-height:1.6}
.add-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:20px;margin-bottom:24px}
.add-card h2{font-size:12px;letter-spacing:2px;color:var(--accent);text-transform:uppercase;margin-bottom:14px}
.row{display:flex;gap:10px;flex-wrap:wrap}
input[type=tel]{
  flex:1;min-width:180px;background:var(--bg);border:1px solid var(--border);
  border-radius:7px;padding:10px 13px;color:var(--text);font-family:var(--font);
  font-size:15px;outline:none;transition:border-color .2s
}
input[type=tel]:focus{border-color:var(--accent)}
.btn{
  padding:10px 20px;border:none;border-radius:7px;font-family:var(--font);
  font-size:13px;font-weight:700;cursor:pointer;transition:opacity .2s;white-space:nowrap
}
.btn:hover{opacity:.85}
.btn:disabled{opacity:.35;cursor:not-allowed}
.btn-green{background:var(--accent);color:#000}
.btn-red{background:var(--red);color:#fff}
.btn-yellow{background:var(--yellow);color:#000}
.btn-sm{padding:6px 12px;font-size:11px;letter-spacing:.5px}
#sessions-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px}
.session-card{
  background:var(--card);border:1px solid var(--border);border-radius:10px;
  padding:16px;transition:border-color .3s
}
.session-card.online{border-color:var(--accent)}
.session-card.banned{border-color:var(--red)}
.session-card.waiting_pair{border-color:var(--yellow)}
.sc-top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px}
.sc-phone{font-size:16px;font-weight:700;letter-spacing:1px}
.sc-status{font-size:10px;letter-spacing:1.5px;text-transform:uppercase;padding:3px 8px;border-radius:4px}
.status-online{background:rgba(0,229,160,.15);color:var(--accent)}
.status-offline{background:rgba(85,85,85,.2);color:var(--muted)}
.status-connecting{background:rgba(245,197,24,.1);color:var(--yellow)}
.status-waiting_pair{background:rgba(245,197,24,.15);color:var(--yellow)}
.status-banned{background:rgba(255,79,79,.15);color:var(--red)}
.sc-code{
  background:var(--bg);border:1px solid var(--yellow);border-radius:7px;
  padding:12px;text-align:center;margin-bottom:12px;display:none
}
.sc-code .code-label{font-size:9px;letter-spacing:2px;color:var(--yellow);margin-bottom:6px}
.sc-code .code-val{font-size:26px;font-weight:900;letter-spacing:5px;color:var(--yellow)}
.sc-code .code-hint{font-size:10px;color:var(--muted);margin-top:6px}
.sc-actions{display:flex;gap:8px;flex-wrap:wrap}
.sc-meta{font-size:10px;color:var(--muted);margin-top:10px}
#toast{
  position:fixed;bottom:20px;right:20px;background:var(--surface);border:1px solid var(--border);
  border-radius:8px;padding:12px 18px;font-size:13px;opacity:0;transition:opacity .3s;
  pointer-events:none;z-index:99
}
#toast.show{opacity:1}
.empty{text-align:center;padding:50px 20px;color:var(--muted);font-size:13px}
.spinner{display:inline-block;width:12px;height:12px;border:2px solid currentColor;
  border-top-color:transparent;border-radius:50%;animation:spin .7s linear infinite;vertical-align:middle;margin-right:5px}
@keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body>

<div class="header">
  <div>
    <div class="logo">US MOD MD V2</div>
    <h1>Multi-Session Manager</h1>
    <div class="sub">Owner: M Usman Chachar &nbsp;|&nbsp; Prefix: .</div>
  </div>
</div>

<div class="warn-box">
  ⚠️ <b>Vercel Note:</b> Sessions /tmp mein save hoti hain. Agar function cold restart ho toh sessions reset ho sakti hain.
  Permanent sessions ke liye Railway ya Render use karein.
</div>

<div class="add-card">
  <h2>+ Naya Session Add Karo</h2>
  <div class="row">
    <input type="tel" id="new-phone" placeholder="923001234567 (country code ke saath)" />
    <button class="btn btn-green" id="add-btn" onclick="addSession()">Connect</button>
  </div>
  <div id="add-msg" style="margin-top:10px;font-size:12px;color:var(--muted)"></div>
</div>

<div id="sessions-grid"><div class="empty">Koi session nahi hai. Upar number daalo.</div></div>
<div id="toast"></div>

<script>
function toast(msg, color) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.color = color || '#f0f0f0';
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

async function addSession() {
  const phone = document.getElementById('new-phone').value.trim().replace(/[^0-9]/g,'');
  const btn   = document.getElementById('add-btn');
  if (!phone || phone.length < 10) { toast('Sahi number daalo', '#ff4f4f'); return; }
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Connecting...';
  try {
    const r = await fetch('/api/session/add', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ phone })
    });
    const d = await r.json();
    if (d.ok) { toast('Session start ho raha hai...', '#00e5a0'); document.getElementById('new-phone').value=''; }
    else       { toast(d.error || 'Error', '#ff4f4f'); }
  } catch(e) { toast('Server error', '#ff4f4f'); }
  btn.disabled = false;
  btn.innerHTML = 'Connect';
}

async function deleteSession(phone) {
  if (!confirm(phone + ' ka session delete karo?')) return;
  await fetch('/api/session/delete', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ phone })
  });
  toast('Session delete ho gaya', '#f5c518');
}

async function restartSession(phone) {
  await fetch('/api/session/restart', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ phone })
  });
  toast(phone + ' restart ho raha hai...', '#f5c518');
}

function renderSessions(data) {
  const grid = document.getElementById('sessions-grid');
  const list = Object.values(data);
  if (!list.length) {
    grid.innerHTML = '<div class="empty">Koi session nahi hai. Upar number daalo.</div>';
    return;
  }
  grid.innerHTML = list.map(s => {
    const statusLabel = {
      online:'Online', offline:'Offline', connecting:'Connecting...',
      waiting_pair:'Code Aaya!', banned:'Banned/Rejected'
    }[s.status] || s.status;

    const codeBlock = s.status === 'waiting_pair' && s.code ? \`
      <div class="sc-code" style="display:block">
        <div class="code-label">Pairing Code</div>
        <div class="code-val">\${s.code}</div>
        <div class="code-hint">WhatsApp → Linked Devices → Link with Phone Number</div>
      </div>
    \` : '';

    const connectedAt = s.connectedAt
      ? '<div class="sc-meta">Connected: ' + new Date(s.connectedAt).toLocaleString() + '</div>'
      : '';

    return \`
    <div class="session-card \${s.status}" id="card-\${s.phone}">
      <div class="sc-top">
        <div class="sc-phone">+\${s.phone}</div>
        <span class="sc-status status-\${s.status}">\${statusLabel}</span>
      </div>
      \${codeBlock}
      <div class="sc-actions">
        <button class="btn btn-yellow btn-sm" onclick="restartSession('\${s.phone}')">↺ Restart</button>
        <button class="btn btn-red btn-sm" onclick="deleteSession('\${s.phone}')">✕ Delete</button>
      </div>
      \${connectedAt}
    </div>\`;
  }).join('');
}

async function poll() {
  try {
    const r = await fetch('/api/sessions');
    const d = await r.json();
    renderSessions(d);
  } catch(_) {}
}

poll();
setInterval(poll, 3000);

document.getElementById('new-phone').addEventListener('keydown', e => {
  if (e.key === 'Enter') addSession();
});
</script>
</body>
</html>`;

// ─── Request Handler (Vercel exports this) ────────────────────────────────────
let initialized = false;

async function init() {
  if (initialized) return;
  initialized = true;
  await restoreSessions();
}

// ── Main handler ─────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  await init();

  const url = new URL(req.url, `http://${req.headers.host}`);

  // ── UI ──────────────────────────────────────────────────────────────────
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(HTML);
    return;
  }

  // ── GET /api/sessions ───────────────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/api/sessions") {
    const out = {};
    for (const [phone, b] of Object.entries(bots)) {
      out[phone] = {
        phone:       b.phone,
        status:      b.status,
        code:        b.code || null,
        connectedAt: b.connectedAt || null,
      };
    }
    res.setHeader("Content-Type", "application/json");
    res.status(200).json(out);
    return;
  }

  // ── POST routes ─────────────────────────────────────────────────────────
  if (req.method === "POST") {
    const payload = req.body || {};
    const phone   = (payload.phone || "").replace(/[^0-9]/g, "");

    const json = (data, code = 200) => res.status(code).json(data);

    if (url.pathname === "/api/session/add") {
      if (!phone || phone.length < 10) { json({ ok: false, error: "Invalid phone" }, 400); return; }
      startSession(phone)
        .then(() => console.log(`[web] Session started: ${phone}`))
        .catch(e => {
          console.error(`[web] Session error ${phone}:`, e.message);
          if (bots[phone]) bots[phone].status = "offline";
        });
      json({ ok: true });
      return;
    }

    if (url.pathname === "/api/session/delete") {
      if (bots[phone]?.sock) { try { bots[phone].sock.end(); } catch (_) {} }
      delete bots[phone];
      fs.removeSync(path.join(SESSIONS_DIR, phone));
      json({ ok: true });
      return;
    }

    if (url.pathname === "/api/session/restart") {
      startSession(phone)
        .then(() => console.log(`[web] Restarted: ${phone}`))
        .catch(e => console.error(`[web] Restart error ${phone}:`, e.message));
      json({ ok: true });
      return;
    }
  }

  res.status(404).send("Not found");
};
