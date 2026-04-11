'use strict';

const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');
const axios   = require('axios');
const Redis   = require('ioredis');

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

// ─── Stream resolver strategy ─────────────────────────────────────────────────
// 1. Cobalt (api.cobalt.tools) — Cloudflare Worker, never IP-blocked by YouTube
// 2. Curated Piped instances — raced in parallel
// 403 instances are added to CLOUD_BLOCKED and permanently skipped this deployment

const PIPED_POOL = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi-libre.kavin.rocks',
  'https://pipedapi.moomoo.me',
  'https://pipedapi.tokhmi.xyz',
  'https://pipedapi.rivo.lol',
  'https://piped-api.cfe.re',
  'https://piped.syncpundit.io/api',
  'https://pipedapi.r4fo.com',
  'https://piped.smnz.de/api',
  'https://pipedapi.colinslegacy.com',
  'https://piped.ext.untel.eu/api',
  'https://api.piped.yt'
];

// Runtime set — once an instance returns 403 it's never retried
const CLOUD_BLOCKED = new Set();

async function resolveViaCobalt(videoId) {
  const r = await axios.post('https://api.cobalt.tools/', {
    url:          'https://www.youtube.com/watch?v=' + videoId,
    downloadMode: 'audio',
    audioFormat:  'best'
  }, {
    headers: {
      'Accept':       'application/json',
      'Content-Type': 'application/json'
    },
    timeout: 10000
  });
  const d = r.data || {};
  if (d.status === 'error') {
    throw new Error('cobalt: ' + (d.error && d.error.code ? d.error.code : JSON.stringify(d)));
  }
  if (!d.url) throw new Error('cobalt: empty url');
  console.log('[stream] cobalt OK status=' + d.status + ' for ' + videoId);
  // tunnel URLs proxy through cobalt CDN (~12h), redirect URLs are direct CDN (~6h)
  return {
    url:       d.url,
    format:    'aac',
    quality:   'unknown',
    expiresAt: Math.floor(Date.now() / 1000) + (d.status === 'tunnel' ? 43200 : 21600)
  };
}

async function resolveViaPiped(base, videoId) {
  if (CLOUD_BLOCKED.has(base)) throw new Error('cloud-blocked');
  const r = await axios.get(base + '/streams/' + videoId, {
    timeout: 4000,
    headers: { 'Accept': 'application/json' }
  });
  const streams = r.data && r.data.audioStreams;
  if (!Array.isArray(streams) || !streams.length) throw new Error('no audioStreams');
  const m4a  = streams.filter(s => (s.mimeType || '').includes('mp4'));
  const pool = m4a.length ? m4a : streams;
  const best = pool.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
  if (!best || !best.url) throw new Error('no url');
  const fmt       = (best.mimeType || '').includes('mp4') ? 'aac' : 'opus';
  const expMatch  = best.url.match(/[?&]expire=(\d+)/);
  const expiresAt = expMatch ? parseInt(expMatch[1], 10) : Math.floor(Date.now() / 1000) + 21600;
  console.log('[stream] piped OK via ' + base + ' for ' + videoId);
  return { url: best.url, format: fmt, quality: best.quality || 'unknown', expiresAt };
}

async function resolveFromAny(videoId) {
  const available = PIPED_POOL.filter(b => !CLOUD_BLOCKED.has(b));

  const cobaltP = resolveViaCobalt(videoId);

  const pipedPs = available.map(base =>
    resolveViaPiped(base, videoId).catch(e => {
      if (e.response && e.response.status === 403) {
        CLOUD_BLOCKED.add(base);
        console.warn('[piped] cloud-blocked: ' + base);
      }
      throw e;
    })
  );

  try {
    return await Promise.any([cobaltP, ...pipedPs]);
  } catch (err) {
    const msgs = (err.errors || [err]).slice(0, 6).map(e => e.message).join(' | ');
    throw new Error('All resolvers failed — ' + msgs);
  }
}

// ─── YTMusic singleton ────────────────────────────────────────────────────────
let ytmusic    = null;
let ytmReady   = false;
let ytmIniting = false;

async function ensureYTMusic() {
  if (ytmReady && ytmusic) return true;
  if (ytmIniting) {
    for (let i = 0; i < 16; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (ytmReady) return true;
    }
    return false;
  }
  ytmIniting = true;
  try {
    let YTM = require('ytmusic-api');
    if (YTM && typeof YTM !== 'function' && YTM.default) YTM = YTM.default;
    ytmusic = new YTM();
    await ytmusic.initialize();
    ytmReady   = true;
    ytmIniting = false;
    console.log('[ytm] ready');
    return true;
  } catch (e) {
    ytmIniting = false;
    console.error('[ytm] init failed: ' + e.message);
    setTimeout(ensureYTMusic, 15000);
    return false;
  }
}
ensureYTMusic();
setInterval(() => { if (!ytmReady) ensureYTMusic(); }, 30000);

// ─── Redis ────────────────────────────────────────────────────────────────────
let redis = null;
if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 3, enableReadyCheck: false });
  redis.on('connect', () => console.log('[redis] connected'));
  redis.on('error',   e  => console.error('[redis] ' + e.message));
}
async function rGet(k)        { if (!redis) return null; try { return await redis.get(k); } catch { return null; } }
async function rSet(k, v, t)  { if (!redis) return; try { t ? await redis.set(k, v, 'EX', t) : await redis.set(k, v); } catch {} }

// ─── Token store ──────────────────────────────────────────────────────────────
const TOKEN_CACHE       = new Map();
const IP_CREATES        = new Map();
const MAX_TOKENS_PER_IP = 10;
const RATE_MAX          = 60;
const RATE_WINDOW_MS    = 60_000;

function genToken() { return crypto.randomBytes(14).toString('hex'); }
function ipBucket(ip) {
  const now = Date.now();
  let b = IP_CREATES.get(ip);
  if (!b || now > b.resetAt) { b = { count: 0, resetAt: now + 86_400_000 }; IP_CREATES.set(ip, b); }
  return b;
}
async function saveToken(t, e) { await rSet('ytm:tok:' + t, JSON.stringify({ createdAt: e.createdAt, lastUsed: e.lastUsed, reqCount: e.reqCount })); }
async function loadToken(t)    { const d = await rGet('ytm:tok:' + t); return d ? JSON.parse(d) : null; }
async function getEntry(t) {
  if (TOKEN_CACHE.has(t)) return TOKEN_CACHE.get(t);
  const s = await loadToken(t);
  if (!s) return null;
  const e = { createdAt: s.createdAt, lastUsed: s.lastUsed, reqCount: s.reqCount, rateWin: [] };
  TOKEN_CACHE.set(t, e);
  return e;
}
function rateOk(e) {
  const now = Date.now();
  e.rateWin = (e.rateWin || []).filter(t => now - t < RATE_WINDOW_MS);
  if (e.rateWin.length >= RATE_MAX) return false;
  e.rateWin.push(now); e.lastUsed = now; e.reqCount = (e.reqCount || 0) + 1;
  return true;
}
async function authMw(req, res, next) {
  const e = await getEntry(req.params.token);
  if (!e) return res.status(404).json({ error: 'Invalid token.' });
  if (!rateOk(e)) return res.status(429).json({ error: 'Rate limit exceeded.' });
  req.tokenEntry = e;
  if (e.reqCount % 20 === 0) saveToken(req.params.token, e);
  next();
}
function getBase(req) { return (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.get('host'); }

// ─── Helpers ──────────────────────────────────────────────────────────────────
function thumb(t) { if (!t || !t.length) return null; return [...t].sort((a, b) => (b.width || 0) - (a.width || 0))[0].url || null; }
function dur(s)   { return s ? Math.floor(s) : null; }
function clean(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

// ─── Stream cache ─────────────────────────────────────────────────────────────
const STREAM_MEM = new Map();
async function resolveStream(videoId) {
  const mc = STREAM_MEM.get(videoId);
  if (mc && mc.expiresAt > Date.now() / 1000 + 600) return mc;
  const rc = await rGet('ytm:stream:' + videoId);
  if (rc) { const p = JSON.parse(rc); if (p.expiresAt > Date.now() / 1000 + 600) { STREAM_MEM.set(videoId, p); return p; } }
  const result = await resolveFromAny(videoId);
  STREAM_MEM.set(videoId, result);
  await rSet('ytm:stream:' + videoId, JSON.stringify(result), Math.max(60, result.expiresAt - Math.floor(Date.now() / 1000) - 600));
  return result;
}

// ─── Config page ──────────────────────────────────────────────────────────────
function configPage(base) {
  let h = '';
  h += '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">';
  h += '<meta name="viewport" content="width=device-width,initial-scale=1">';
  h += '<title>YouTube Music for Eclipse</title>';
  h += '<style>*{box-sizing:border-box;margin:0;padding:0}';
  h += 'body{background:#0f0f0f;color:#e8e8e8;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:48px 20px 64px}';
  h += '.logo{margin-bottom:20px}';
  h += '.card{background:#161616;border:1px solid #232323;border-radius:18px;padding:36px;max-width:540px;width:100%;box-shadow:0 24px 64px rgba(0,0,0,.5);margin-bottom:20px}';
  h += 'h1{font-size:22px;font-weight:700;margin-bottom:6px;color:#fff}h2{font-size:16px;font-weight:700;margin-bottom:14px;color:#fff}';
  h += 'p.sub{font-size:14px;color:#777;margin-bottom:20px;line-height:1.6}';
  h += '.tip{background:#1a0a0a;border:1px solid #3a1010;border-radius:10px;padding:12px 14px;margin-bottom:20px;font-size:12px;color:#cc4444;line-height:1.7}.tip b{color:#ff6666}';
  h += '.pills{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:24px}';
  h += '.pill{border-radius:20px;font-size:11px;font-weight:600;padding:4px 10px;background:#1f0a0a;color:#e03333;border:1px solid #3a1515}';
  h += '.pill.b{background:#001a2e;color:#4a9eff;border-color:#003a6e}.pill.g{background:#0d1a0d;color:#5a9e5a;border-color:#1a3a1a}';
  h += '.lbl{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#555;margin-bottom:8px;margin-top:16px}';
  h += 'input{width:100%;background:#0f0f0f;border:1px solid #222;border-radius:10px;color:#e8e8e8;font-size:14px;padding:12px 14px;margin-bottom:6px;outline:none;transition:border-color .15s}';
  h += 'input:focus{border-color:#ff0000}input::placeholder{color:#333}';
  h += '.hint{font-size:12px;color:#484848;margin-bottom:12px;line-height:1.7}.hint code{background:#1a1a1a;padding:1px 5px;border-radius:4px;color:#888}';
  h += 'button{cursor:pointer;border:none;border-radius:10px;font-size:15px;font-weight:700;padding:13px;width:100%;margin-top:6px;margin-bottom:12px;transition:background .15s}';
  h += '.br{background:#cc0000;color:#fff}.br:hover{background:#aa0000}.br:disabled{background:#252525;color:#444;cursor:not-allowed}';
  h += '.bg{background:#1a4a20;color:#e8e8e8;border:1px solid #2a6a30}.bg:hover{background:#245c2a}.bg:disabled{background:#252525;color:#444;cursor:not-allowed}';
  h += '.bd{background:#1a1a1a;color:#aaa;border:1px solid #222;font-size:13px;padding:10px}.bd:hover{background:#222;color:#fff}';
  h += '.box{display:none;background:#0f0f0f;border:1px solid #1e1e1e;border-radius:12px;padding:18px;margin-bottom:14px}';
  h += '.blbl{font-size:10px;color:#555;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px}';
  h += '.burl{font-size:12px;color:#ff4444;word-break:break-all;font-family:"SF Mono",monospace;margin-bottom:14px;line-height:1.5}';
  h += 'hr{border:none;border-top:1px solid #1a1a1a;margin:24px 0}';
  h += '.steps{display:flex;flex-direction:column;gap:12px}.step{display:flex;gap:12px;align-items:flex-start}';
  h += '.sn{background:#1a1a1a;border:1px solid #252525;border-radius:50%;width:26px;height:26px;min-width:26px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#666}';
  h += '.st{font-size:13px;color:#666;line-height:1.6}.st b{color:#aaa}';
  h += '.warn{background:#140a0a;border:1px solid #2e1010;border-radius:10px;padding:14px;margin-top:20px;font-size:12px;color:#8a4444;line-height:1.7}';
  h += '.badge{display:inline-block;background:#001a2e;color:#4a9eff;border:1px solid #003a6e;border-radius:20px;font-size:11px;font-weight:600;padding:3px 10px;margin-bottom:14px}';
  h += '.status{font-size:13px;color:#666;margin:8px 0;min-height:18px}.status.ok{color:#5a9e5a}.status.err{color:#c0392b}';
  h += '.preview{background:#0f0f0f;border:1px solid #1a1a1a;border-radius:10px;padding:12px;max-height:200px;overflow-y:auto;margin-bottom:12px;display:none}';
  h += '.tr{display:flex;gap:10px;align-items:center;padding:5px 0;border-bottom:1px solid #181818;font-size:13px}.tr:last-child{border-bottom:none}';
  h += '.tn{color:#444;font-size:11px;min-width:22px;text-align:right}.ti{flex:1;min-width:0}.tt{color:#e8e8e8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ta{color:#666;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}';
  h += 'footer{margin-top:32px;font-size:12px;color:#333;text-align:center;line-height:1.8}</style></head><body>';
  h += '<svg class="logo" width="52" height="52" viewBox="0 0 52 52" fill="none"><circle cx="26" cy="26" r="26" fill="#ff0000"/><circle cx="26" cy="26" r="10" fill="none" stroke="#fff" stroke-width="2.5"/><polygon points="23,22 23,30 31,26" fill="#fff"/></svg>';
  h += '<div class="card"><h1>YouTube Music for Eclipse</h1>';
  h += '<div class="tip"><b>Save your URL.</b> Copy it to Notes or a bookmark. If the server restarts, paste it below to restore access.</div>';
  h += '<p class="sub">Full YouTube Music search — tracks, albums, artists, and playlists. Streams are resolved via Cobalt (Cloudflare Worker) with Piped as fallback — both raced in parallel.</p>';
  h += '<div class="pills"><span class="pill">Tracks</span><span class="pill">Albums</span><span class="pill">Artists</span><span class="pill">Playlists</span><span class="pill b">Cobalt + Piped parallel</span><span class="pill g">CSV export</span></div>';
  h += '<div class="lbl">Generate a new URL</div>';
  h += '<button class="br" id="genBtn" onclick="generate()">Generate My Addon URL</button>';
  h += '<div class="box" id="genBox"><div class="blbl">Your addon URL — paste into Eclipse</div><div class="burl" id="genUrl"></div><button class="bd" id="copyGenBtn" onclick="copyGen()">Copy URL</button></div>';
  h += '<hr><div class="lbl">Refresh existing URL</div>';
  h += '<input type="text" id="existingUrl" placeholder="Paste your existing addon URL here">';
  h += '<div class="hint">Same URL, same playlists — nothing breaks.</div>';
  h += '<button class="bg" id="refBtn" onclick="doRefresh()">Refresh Existing URL</button>';
  h += '<div class="box" id="refBox"><div class="blbl">Refreshed — same URL still works in Eclipse</div><div class="burl" id="refUrl"></div><button class="bd" id="copyRefBtn" onclick="copyRef()">Copy URL</button></div>';
  h += '<hr><div class="steps">';
  h += '<div class="step"><div class="sn">1</div><div class="st">Generate and copy your URL above</div></div>';
  h += '<div class="step"><div class="sn">2</div><div class="st">Open <b>Eclipse</b> → Settings → Connections → Add Connection → Addon</div></div>';
  h += '<div class="step"><div class="sn">3</div><div class="st">Paste your URL and tap Install</div></div>';
  h += '<div class="step"><div class="sn">4</div><div class="st">Use <b>Playlist Importer</b> below to export a YouTube Music playlist as CSV</div></div>';
  h += '</div>';
  h += '<div class="warn">Cobalt is a Cloudflare Worker that resolves YouTube audio without IP restrictions. Piped instances that block cloud IPs are automatically skipped. 403 instances are never retried for the lifetime of the deployment.</div></div>';
  h += '<div class="card"><span class="badge">Playlist Importer</span>';
  h += '<h2>Export YouTube Music Playlist → CSV</h2>';
  h += '<p class="sub">Downloads a CSV you can import in Eclipse via Library → Import CSV.</p>';
  h += '<div class="lbl">Your Addon URL</div>';
  h += '<input type="text" id="impToken" placeholder="Paste your addon URL (auto-fills after generating)">';
  h += '<div class="lbl">YouTube Music Playlist URL</div>';
  h += '<input type="text" id="impUrl" placeholder="music.youtube.com/playlist?list=... or music.youtube.com/browse/VL...">';
  h += '<div class="hint">Paste any public YouTube Music playlist URL. Both <code>?list=</code> and <code>browse/VL</code> formats work.</div>';
  h += '<div class="status" id="impStatus"></div>';
  h += '<div class="preview" id="impPreview"></div>';
  h += '<button class="bg" id="impBtn" onclick="doImport()">Fetch &amp; Download CSV</button></div>';
  h += '<footer>Eclipse YouTube Music Addon v1.4.0 • <a href="' + base + '/health" target="_blank" style="color:#333;text-decoration:none">' + base + '</a></footer>';
  h += '<script>';
  h += 'var _gu="",_ru="";';
  h += 'function generate(){var btn=document.getElementById("genBtn");btn.disabled=true;btn.textContent="Generating...";fetch("/generate",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"}).then(r=>r.json()).then(function(d){if(d.error){alert(d.error);btn.disabled=false;btn.textContent="Generate My Addon URL";return;}_gu=d.manifestUrl;document.getElementById("genUrl").textContent=_gu;document.getElementById("genBox").style.display="block";document.getElementById("impToken").value=_gu;btn.disabled=false;btn.textContent="Regenerate URL";}).catch(function(e){alert("Error: "+e.message);btn.disabled=false;btn.textContent="Generate My Addon URL";});}';
  h += 'function copyGen(){if(!_gu)return;navigator.clipboard.writeText(_gu).then(function(){var b=document.getElementById("copyGenBtn");b.textContent="Copied!";setTimeout(function(){b.textContent="Copy URL";},1500);});}';
  h += 'function doRefresh(){var btn=document.getElementById("refBtn"),eu=document.getElementById("existingUrl").value.trim();if(!eu){alert("Paste your existing addon URL first.");return;}btn.disabled=true;btn.textContent="Refreshing...";fetch("/refresh",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({existingUrl:eu})}).then(r=>r.json()).then(function(d){if(d.error){alert(d.error);btn.disabled=false;btn.textContent="Refresh Existing URL";return;}_ru=d.manifestUrl;document.getElementById("refUrl").textContent=_ru;document.getElementById("refBox").style.display="block";document.getElementById("impToken").value=_ru;btn.disabled=false;btn.textContent="Refresh Again";}).catch(function(e){alert("Error: "+e.message);btn.disabled=false;btn.textContent="Refresh Existing URL";});}';
  h += 'function copyRef(){if(!_ru)return;navigator.clipboard.writeText(_ru).then(function(){var b=document.getElementById("copyRefBtn");b.textContent="Copied!";setTimeout(function(){b.textContent="Copy URL";},1500);});}';
  h += 'function getTok(s){var m=s.match(/\\/u\\/([a-f0-9]{28})\\//);return m?m[1]:null;}';
  h += 'function hesc(s){return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}';
  h += 'function doImport(){var btn=document.getElementById("impBtn"),raw=document.getElementById("impToken").value.trim(),purl=document.getElementById("impUrl").value.trim(),st=document.getElementById("impStatus"),pv=document.getElementById("impPreview");if(!raw){st.className="status err";st.textContent="Paste your addon URL first.";return;}if(!purl){st.className="status err";st.textContent="Paste a YouTube Music playlist URL.";return;}var tok=getTok(raw);if(!tok){st.className="status err";st.textContent="Could not find your token in the URL.";return;}btn.disabled=true;btn.textContent="Fetching...";st.className="status";st.textContent="Fetching tracks...";pv.style.display="none";fetch("/u/"+tok+"/import?url="+encodeURIComponent(purl)).then(function(r){if(!r.ok){return r.json().then(function(e){throw new Error(e.error||("Server error "+r.status));});}return r.json();}).then(function(data){var tracks=data.tracks||[];if(!tracks.length)throw new Error("No tracks found.");var rows=tracks.slice(0,50).map(function(t,i){return\'<div class="tr"><span class="tn">\'+(i+1)+\'</span><div class="ti"><div class="tt">\'+hesc(t.title)+\'</div><div class="ta">\'+hesc(t.artist||"")+\'</div></div></div>\';});if(tracks.length>50)rows.push(\'<div class="tr" style="text-align:center;color:#555"><span class="tn"></span><div class="ti"><div class="tt">\'+hesc((tracks.length-50)+\' more...\')+\'</div></div></div>\');pv.innerHTML=rows.join("");pv.style.display="block";st.className="status ok";st.textContent="Found "+tracks.length+" tracks in \\""+hesc(data.title||"playlist")+"\\". Downloading CSV...";var lines=["Title,Artist,Album,Duration"];tracks.forEach(function(t){function ce(s){var x=String(s||"");if(x.indexOf(\',\')!==-1||x.indexOf(\'"\')!==-1){x=\'"\'+x.replace(/"/g,\'""\')+\'"\';}return x;}lines.push(ce(t.title)+","+ce(t.artist)+","+ce(data.title)+","+ce(t.duration||""));});var blob=new Blob([lines.join("\\n")],{type:"text/csv"});var a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=(data.title||"playlist").replace(/[^a-zA-Z0-9 \\-_\\.]/g,"").trim()+".csv";document.body.appendChild(a);a.click();document.body.removeChild(a);btn.disabled=false;btn.textContent="Fetch & Download CSV";}).catch(function(e){st.className="status err";st.textContent=e.message;btn.disabled=false;btn.textContent="Fetch & Download CSV";});}';
  h += '</script></body></html>';
  return h;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(configPage(getBase(req)));
});

app.post('/generate', async (req, res) => {
  const ip     = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  const bucket = ipBucket(ip);
  if (bucket.count >= MAX_TOKENS_PER_IP) return res.status(429).json({ error: 'Too many tokens today from this IP.' });
  const token = genToken();
  const entry = { createdAt: Date.now(), lastUsed: Date.now(), reqCount: 0, rateWin: [] };
  TOKEN_CACHE.set(token, entry);
  await saveToken(token, entry);
  bucket.count++;
  res.json({ token, manifestUrl: getBase(req) + '/u/' + token + '/manifest.json' });
});

app.post('/refresh', async (req, res) => {
  const raw = (req.body && req.body.existingUrl) ? String(req.body.existingUrl).trim() : '';
  let token = raw;
  const m = raw.match(/\/u\/([a-f0-9]{28})\//);
  if (m) token = m[1];
  if (!token || !/^[a-f0-9]{28}$/.test(token)) return res.status(400).json({ error: 'Paste your full addon URL.' });
  const entry = await getEntry(token);
  if (!entry) return res.status(404).json({ error: 'URL not found. Generate a new one.' });
  res.json({ token, manifestUrl: getBase(req) + '/u/' + token + '/manifest.json', refreshed: true });
});

app.get('/health', (req, res) => {
  res.json({
    status:        'ok',
    version:       '1.4.0',
    ytmusicReady:  ytmReady,
    streamBackend: 'cobalt + piped (Promise.any)',
    pipedPool:     PIPED_POOL.length,
    cloudBlocked:  [...CLOUD_BLOCKED],
    redis:         !!(redis && redis.status === 'ready'),
    tokens:        TOKEN_CACHE.size,
    timestamp:     new Date().toISOString()
  });
});

app.get('/u/:token/manifest.json', authMw, (req, res) => {
  res.json({
    id:          'com.eclipse.ytmusic.' + req.params.token.slice(0, 8),
    name:        'YouTube Music',
    version:     '1.4.0',
    description: 'Full YouTube Music search and streaming — tracks, albums, artists, and playlists.',
    icon:        'https://music.youtube.com/img/favicon_144.png',
    resources:   ['search', 'stream', 'catalog'],
    types:       ['track', 'album', 'artist', 'playlist']
  });
});

app.get('/u/:token/search', authMw, async (req, res) => {
  const q = clean(req.query.q);
  if (!q) return res.json({ tracks: [], albums: [], artists: [], playlists: [] });
  const ready = await ensureYTMusic();
  if (!ready) return res.status(503).json({ error: 'Not ready', tracks: [], albums: [], artists: [], playlists: [] });
  try {
    const [songs, albums, artists, playlists] = await Promise.all([
      ytmusic.searchSongs(q).catch(() => []),
      ytmusic.searchAlbums(q).catch(() => []),
      ytmusic.searchArtists(q).catch(() => []),
      ytmusic.searchPlaylists(q).catch(() => [])
    ]);
    res.json({
      tracks:    (songs     || []).slice(0, 20).map(s => ({ id: s.videoId, title: s.name || 'Unknown', artist: (s.artist && s.artist.name) || 'Unknown', album: (s.album && s.album.name) || null, duration: dur(s.duration), artworkURL: thumb(s.thumbnails), format: 'aac' })),
      albums:    (albums    || []).slice(0, 10).map(a => ({ id: a.albumId, title: a.name || 'Unknown', artist: (a.artist && a.artist.name) || 'Unknown', artworkURL: thumb(a.thumbnails), trackCount: a.trackCount || null, year: a.year ? String(a.year) : null })),
      artists:   (artists   || []).slice(0,  5).map(a => ({ id: a.artistId, name: a.name || 'Unknown', artworkURL: thumb(a.thumbnails), genres: [] })),
      playlists: (playlists || []).slice(0, 10).map(p => ({ id: p.playlistId, title: p.name || 'Unknown', creator: (p.artist && p.artist.name) || null, artworkURL: thumb(p.thumbnails), trackCount: p.trackCount || null }))
    });
  } catch (e) {
    console.error('[search] ' + e.message);
    res.status(500).json({ error: e.message, tracks: [], albums: [], artists: [], playlists: [] });
  }
});

app.get('/u/:token/stream/:id', authMw, async (req, res) => {
  const vid = req.params.id;
  if (!/^[a-zA-Z0-9_-]{11}$/.test(vid)) return res.status(400).json({ error: 'Invalid video ID.' });
  try {
    res.json(await resolveStream(vid));
  } catch (e) {
    console.error('[stream] ' + vid + ': ' + e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/u/:token/album/:id', authMw, async (req, res) => {
  if (!await ensureYTMusic()) return res.status(503).json({ error: 'Not ready.' });
  try {
    const a = await ytmusic.getAlbum(req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found.' });
    res.json({ id: a.albumId, title: a.name || 'Unknown', artist: (a.artist && a.artist.name) || 'Unknown', artworkURL: thumb(a.thumbnails), year: a.year ? String(a.year) : null, description: a.description || null, trackCount: (a.songs || []).length || null,
      tracks: (a.songs || []).map(s => ({ id: s.videoId, title: s.name || 'Unknown', artist: (s.artist && s.artist.name) || (a.artist && a.artist.name) || 'Unknown', duration: dur(s.duration), artworkURL: thumb(s.thumbnails) || thumb(a.thumbnails), format: 'aac' })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/u/:token/artist/:id', authMw, async (req, res) => {
  if (!await ensureYTMusic()) return res.status(503).json({ error: 'Not ready.' });
  try {
    const a = await ytmusic.getArtist(req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found.' });
    res.json({ id: a.artistId, name: a.name || 'Unknown', artworkURL: thumb(a.thumbnails), bio: a.description || null, genres: [],
      topTracks: (a.topSongs  || []).slice(0, 10).map(s  => ({ id: s.videoId,  title: s.name  || 'Unknown', artist: (s.artist  && s.artist.name)  || a.name || 'Unknown', duration: dur(s.duration),  artworkURL: thumb(s.thumbnails),  format: 'aac' })),
      albums:    (a.topAlbums || []).slice(0, 10).map(al => ({ id: al.albumId, title: al.name || 'Unknown', artist: a.name || 'Unknown', artworkURL: thumb(al.thumbnails), trackCount: null, year: al.year ? String(al.year) : null })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/u/:token/playlist/:id', authMw, async (req, res) => {
  if (!await ensureYTMusic()) return res.status(503).json({ error: 'Not ready.' });
  try {
    const p = await ytmusic.getPlaylist(req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found.' });
    res.json({ id: p.playlistId, title: p.name || 'Unknown', description: p.description || null, artworkURL: thumb(p.thumbnails), creator: (p.artist && p.artist.name) || null,
      tracks: (p.songs || []).map(s => ({ id: s.videoId, title: s.name || 'Unknown', artist: (s.artist && s.artist.name) || 'Unknown', duration: dur(s.duration), artworkURL: thumb(s.thumbnails), format: 'aac' })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/u/:token/import', authMw, async (req, res) => {
  const rawUrl = String(req.query.url || '').trim();
  if (!rawUrl) return res.status(400).json({ error: 'Missing ?url= parameter.' });
  if (!await ensureYTMusic()) return res.status(503).json({ error: 'Not ready.' });
  let playlistId = null;
  const vm = rawUrl.match(/browse\/VL([a-zA-Z0-9_-]+)/);
  const lm = rawUrl.match(/[?&]list=([a-zA-Z0-9_-]+)/);
  if (vm) playlistId = vm[1]; else if (lm) playlistId = lm[1];
  if (!playlistId) return res.status(400).json({ error: 'Could not extract playlist ID.' });
  try {
    const p = await ytmusic.getPlaylist(playlistId);
    if (!p) throw new Error('Playlist not found.');
    res.json({ id: p.playlistId, title: p.name || 'YouTube Music Playlist',
      tracks: (p.songs || []).map(s => ({ id: s.videoId, title: s.name || 'Unknown', artist: (s.artist && s.artist.name) || 'Unknown', duration: dur(s.duration) })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log('[server] v1.4.0 port ' + PORT));
module.exports = app;
