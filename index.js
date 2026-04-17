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

// ─── Stream resolver — youtubei.js ───────────────────────────────────────────
let _yt = null;
let _ytInit = false;

async function getYT() {
  if (_yt) return _yt;
  if (_ytInit) {
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 300));
      if (_yt) return _yt;
    }
    throw new Error('YT init timeout');
  }
  _ytInit = true;
  try {
    const { Innertube } = require('youtubei.js');
    _yt = await Innertube.create({
      cache:                    new Map(),
      generate_session_locally: true,
      fetch:                    (url, opts) => fetch(url, opts)
    });
    console.log('[yt] innertube ready');
    return _yt;
  } catch (e) {
    _ytInit = false;
    throw e;
  }
}

getYT().catch(e => console.error('[yt] boot error: ' + e.message));
setInterval(() => { if (!_yt) getYT().catch(() => {}); }, 30000);

// ─── Redis ────────────────────────────────────────────────────────────────────
let redis = null;
if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 3, enableReadyCheck: false });
  redis.on('connect', () => console.log('[redis] connected'));
  redis.on('error',   e  => console.error('[redis] ' + e.message));
}
async function rGet(k)       { if (!redis) return null; try { return await redis.get(k); } catch { return null; } }
async function rSet(k, v, t) { if (!redis) return; try { t ? await redis.set(k, v, 'EX', t) : await redis.set(k, v); } catch {} }

// ─── Stream cache ─────────────────────────────────────────────────────────────
const STREAM_MEM = new Map();

async function resolveStream(videoId) {
  // Check memory cache first
  const mc = STREAM_MEM.get(videoId);
  if (mc && mc.expiresAt > Date.now() / 1000 + 600) return mc;
  const rc = await rGet('ytm:stream:' + videoId);
  if (rc) {
    const p = JSON.parse(rc);
    if (p.expiresAt > Date.now() / 1000 + 600) { STREAM_MEM.set(videoId, p); return p; }
  }

  // Use home proxy if available (bypasses YouTube datacenter IP block on Vercel)
  const proxyBase = (process.env.YTM_PROXY_URL || process.env.DAB_PROXY_URL || '').replace(/\/$/, '');
  if (proxyBase) {
    try {
      const r = await axios.get(proxyBase + '/ytm-stream/' + videoId, { timeout: 20000 });
      const result = r.data;
      if (result && result.url) {
        STREAM_MEM.set(videoId, result);
        await rSet('ytm:stream:' + videoId, JSON.stringify(result), Math.max(60, (result.expiresAt || 0) - Math.floor(Date.now() / 1000) - 600));
        console.log('[YTM] stream via home proxy OK:', videoId);
        return result;
      }
    } catch (e) {
      console.warn('[YTM] proxy stream failed, trying local:', e.message);
    }
  }

  // Fallback: local resolve (may be blocked by YouTube on datacenter IPs)
  const yt = await getYT();
  let info;
  try { info = await yt.getBasicInfo(videoId, 'ANDROID'); }
  catch (e) { info = await yt.getBasicInfo(videoId, 'IOS'); }
  const ps = info.playability_status;
  if (ps && ps.status === 'LOGIN_REQUIRED') throw new Error('login_required');
  if (ps && ps.status !== 'OK') throw new Error('not_playable: ' + ps.status);
  const formats = (info.streaming_data && info.streaming_data.adaptive_formats || [])
    .filter(f => f.mime_type && f.mime_type.startsWith('audio') && (f.url || f.decipher));
  if (!formats.length) throw new Error('no audio formats');
  const m4a = formats.filter(f => f.mime_type && f.mime_type.includes('mp4a'));
  const pool = m4a.length ? m4a : formats;
  const best = pool.sort((a, b) => (b.average_bitrate || 0) - (a.average_bitrate || 0))[0];
  const url = best.url || await best.decipher(yt.actions.session.player);
  const expMatch = url.match(/[?&]expire=([0-9]+)/);
  const expiresAt = expMatch ? parseInt(expMatch[1]) : Math.floor(Date.now() / 1000 + 21600);
  const result = { url, format: best.mime_type && best.mime_type.includes('mp4a') ? 'aac' : 'opus', quality: best.average_bitrate ? Math.round(best.average_bitrate / 1000) + 'kbps' : 'unknown', expiresAt };
  STREAM_MEM.set(videoId, result);
  await rSet('ytm:stream:' + videoId, JSON.stringify(result), Math.max(60, expiresAt - Math.floor(Date.now() / 1000) - 600));
  return result;
}


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

// ─── Config page ──────────────────────────────────────────────────────────────
function configPage(base) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>YouTube Music · Eclipse Addon</title>
<style>
  :root {
    --red: #ff2020;
    --red-dim: #cc1a1a;
    --red-glow: rgba(255,32,32,0.18);
    --bg: #080808;
    --surface: rgba(255,255,255,0.04);
    --surface-border: rgba(255,255,255,0.08);
    --text: #f0f0f0;
    --muted: #666;
    --subtle: #333;
    --green: #22c55e;
    --blue: #3b82f6;
    --radius: 16px;
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 56px 20px 80px;
    overflow-x: hidden;
  }

  /* animated background blobs */
  body::before, body::after {
    content: '';
    position: fixed;
    border-radius: 50%;
    filter: blur(120px);
    pointer-events: none;
    z-index: 0;
  }
  body::before {
    width: 600px; height: 600px;
    background: radial-gradient(circle, rgba(255,32,32,0.08) 0%, transparent 70%);
    top: -200px; left: -200px;
    animation: drift1 18s ease-in-out infinite alternate;
  }
  body::after {
    width: 500px; height: 500px;
    background: radial-gradient(circle, rgba(180,0,255,0.05) 0%, transparent 70%);
    bottom: -150px; right: -150px;
    animation: drift2 22s ease-in-out infinite alternate;
  }
  @keyframes drift1 { from { transform: translate(0,0); } to { transform: translate(80px,60px); } }
  @keyframes drift2 { from { transform: translate(0,0); } to { transform: translate(-60px,-80px); } }

  /* all real content above blobs */
  .wrap { position: relative; z-index: 1; width: 100%; max-width: 560px; }

  /* ── Header ── */
  .header {
    display: flex;
    flex-direction: column;
    align-items: center;
    margin-bottom: 40px;
    text-align: center;
  }
  .logo-ring {
    position: relative;
    width: 72px; height: 72px;
    margin-bottom: 20px;
  }
  .logo-ring svg { width: 72px; height: 72px; }
  .logo-ring::after {
    content: '';
    position: absolute;
    inset: -6px;
    border-radius: 50%;
    background: conic-gradient(var(--red), #ff6a00, var(--red), transparent 60%);
    animation: spin 4s linear infinite;
    z-index: -1;
    opacity: 0.6;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .header h1 { font-size: 26px; font-weight: 800; letter-spacing: -0.5px; }
  .header h1 span { color: var(--red); }
  .header p { font-size: 14px; color: var(--muted); margin-top: 6px; line-height: 1.6; max-width: 380px; }
  .version-badge {
    display: inline-flex; align-items: center; gap: 6px;
    background: rgba(255,32,32,0.1); border: 1px solid rgba(255,32,32,0.25);
    color: #ff6060; border-radius: 20px; font-size: 11px; font-weight: 700;
    padding: 4px 12px; margin-top: 12px; letter-spacing: 0.05em;
  }
  .version-badge::before { content: '●'; font-size: 8px; animation: pulse 2s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }

  /* ── Cards ── */
  .card {
    background: var(--surface);
    border: 1px solid var(--surface-border);
    border-radius: var(--radius);
    padding: 32px;
    width: 100%;
    margin-bottom: 16px;
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    transition: border-color 0.2s;
  }
  .card:hover { border-color: rgba(255,255,255,0.13); }

  .card-title {
    font-size: 13px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.1em; color: var(--muted); margin-bottom: 20px;
    display: flex; align-items: center; gap: 8px;
  }
  .card-title::after { content: ''; flex: 1; height: 1px; background: var(--surface-border); }

  /* ── Alert banner ── */
  .alert {
    background: rgba(255,32,32,0.06);
    border: 1px solid rgba(255,32,32,0.2);
    border-radius: 10px;
    padding: 12px 16px;
    font-size: 13px; color: #ff7070;
    line-height: 1.7; margin-bottom: 24px;
  }
  .alert b { color: #ff9090; }

  /* ── Feature pills ── */
  .pills { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 28px; }
  .pill {
    border-radius: 20px; font-size: 11px; font-weight: 600;
    padding: 5px 12px; letter-spacing: 0.03em;
  }
  .pill-red { background: rgba(255,32,32,0.1); color: #ff6060; border: 1px solid rgba(255,32,32,0.2); }
  .pill-blue { background: rgba(59,130,246,0.1); color: #60a5fa; border: 1px solid rgba(59,130,246,0.2); }
  .pill-green { background: rgba(34,197,94,0.1); color: #4ade80; border: 1px solid rgba(34,197,94,0.2); }
  .pill-purple { background: rgba(168,85,247,0.1); color: #c084fc; border: 1px solid rgba(168,85,247,0.2); }

  /* ── Labels ── */
  .lbl {
    font-size: 11px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.08em; color: var(--muted); margin-bottom: 8px; margin-top: 20px;
    display: block;
  }

  /* ── Inputs ── */
  input {
    width: 100%; background: rgba(255,255,255,0.03);
    border: 1px solid var(--surface-border);
    border-radius: 10px; color: var(--text);
    font-size: 14px; padding: 12px 16px; margin-bottom: 6px;
    outline: none; transition: border-color 0.2s, box-shadow 0.2s;
    font-family: inherit;
  }
  input:focus {
    border-color: var(--red);
    box-shadow: 0 0 0 3px var(--red-glow);
  }
  input::placeholder { color: var(--subtle); }

  .hint { font-size: 12px; color: #444; margin-bottom: 4px; line-height: 1.7; }
  .hint code { background: rgba(255,255,255,0.06); padding: 1px 6px; border-radius: 4px; color: #777; font-size: 11px; }

  /* ── Buttons ── */
  button {
    cursor: pointer; border: none; border-radius: 10px;
    font-size: 14px; font-weight: 700; padding: 13px 20px;
    width: 100%; margin-top: 8px; margin-bottom: 4px;
    transition: all 0.18s; font-family: inherit; letter-spacing: 0.02em;
    position: relative; overflow: hidden;
  }
  button::after {
    content: ''; position: absolute; inset: 0;
    background: rgba(255,255,255,0); transition: background 0.15s;
  }
  button:hover::after { background: rgba(255,255,255,0.06); }
  button:active { transform: scale(0.98); }

  .btn-red {
    background: linear-gradient(135deg, #cc0000 0%, #ff2020 100%);
    color: #fff;
    box-shadow: 0 4px 20px rgba(255,32,32,0.25);
  }
  .btn-red:hover { box-shadow: 0 4px 28px rgba(255,32,32,0.4); }
  .btn-red:disabled { background: #1e1e1e; color: #444; box-shadow: none; cursor: not-allowed; }

  .btn-green {
    background: linear-gradient(135deg, #14532d 0%, #16a34a 100%);
    color: #e8e8e8;
    border: 1px solid rgba(34,197,94,0.2);
    box-shadow: 0 4px 20px rgba(34,197,94,0.12);
  }
  .btn-green:hover { box-shadow: 0 4px 28px rgba(34,197,94,0.22); }
  .btn-green:disabled { background: #1e1e1e; color: #444; box-shadow: none; cursor: not-allowed; border-color: transparent; }

  .btn-ghost {
    background: rgba(255,255,255,0.04); color: #888;
    border: 1px solid var(--surface-border);
    font-size: 13px; padding: 10px;
  }
  .btn-ghost:hover { background: rgba(255,255,255,0.08); color: #ccc; }

  /* ── Result box ── */
  .result-box {
    display: none;
    background: rgba(255,32,32,0.05);
    border: 1px solid rgba(255,32,32,0.2);
    border-radius: 12px;
    padding: 18px;
    margin: 12px 0;
    animation: fadeIn 0.25s ease;
  }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }
  .result-label { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 8px; }
  .result-url {
    font-size: 12px; color: #ff6060; word-break: break-all;
    font-family: 'SF Mono', 'Fira Code', monospace; line-height: 1.6; margin-bottom: 14px;
  }

  /* ── Divider ── */
  .divider { border: none; border-top: 1px solid var(--surface-border); margin: 24px 0; }

  /* ── Steps ── */
  .steps { display: flex; flex-direction: column; gap: 14px; }
  .step { display: flex; gap: 14px; align-items: flex-start; }
  .step-num {
    background: rgba(255,32,32,0.1); border: 1px solid rgba(255,32,32,0.2);
    border-radius: 50%; width: 28px; height: 28px; min-width: 28px;
    display: flex; align-items: center; justify-content: center;
    font-size: 12px; font-weight: 800; color: var(--red);
  }
  .step-text { font-size: 13px; color: #888; line-height: 1.65; padding-top: 4px; }
  .step-text b { color: #bbb; }

  /* ── Status ── */
  .status { font-size: 13px; color: var(--muted); margin: 10px 0; min-height: 20px; line-height: 1.5; }
  .status.ok { color: var(--green); }
  .status.err { color: #f87171; }
  .status.loading { color: #60a5fa; }

  /* ── Preview list ── */
  .preview {
    background: rgba(255,255,255,0.02); border: 1px solid var(--surface-border);
    border-radius: 10px; padding: 10px; max-height: 210px; overflow-y: auto;
    margin-bottom: 12px; display: none;
    scrollbar-width: thin; scrollbar-color: #333 transparent;
  }
  .preview::-webkit-scrollbar { width: 4px; }
  .preview::-webkit-scrollbar-thumb { background: #333; border-radius: 2px; }
  .track-row {
    display: flex; gap: 10px; align-items: center;
    padding: 7px 4px; border-bottom: 1px solid rgba(255,255,255,0.04);
    font-size: 13px;
  }
  .track-row:last-child { border-bottom: none; }
  .track-num { color: #333; font-size: 11px; min-width: 24px; text-align: right; }
  .track-info { flex: 1; min-width: 0; }
  .track-title { color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 500; }
  .track-artist { color: var(--muted); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }

  /* ── Section badge ── */
  .section-badge {
    display: inline-flex; align-items: center; gap: 6px;
    background: rgba(59,130,246,0.1); border: 1px solid rgba(59,130,246,0.2);
    color: #60a5fa; border-radius: 20px; font-size: 11px; font-weight: 700;
    padding: 4px 12px; margin-bottom: 16px; letter-spacing: 0.04em;
  }

  /* ── Footer ── */
  footer {
    position: relative; z-index: 1;
    margin-top: 36px; font-size: 12px; color: #2a2a2a;
    text-align: center; line-height: 2;
  }
  footer a { color: #333; text-decoration: none; transition: color 0.15s; }
  footer a:hover { color: var(--muted); }
</style>
</head>
<body>
<div class="wrap">

  <!-- Header -->
  <div class="header">
    <div class="logo-ring">
      <svg viewBox="0 0 72 72" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="36" cy="36" r="36" fill="#ff2020"/>
        <circle cx="36" cy="36" r="13" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="1"/>
        <polygon points="31,28 31,44 46,36" fill="#fff"/>
      </svg>
    </div>
    <h1>YouTube <span>Music</span> for Eclipse</h1>
    <p>Full YouTube Music search — tracks, albums, artists, and playlists. Streams resolved via youtubei.js with PO token support.</p>
    <span class="version-badge">v1.5.0 LIVE</span>
  </div>

  <!-- Generate / Refresh card -->
  <div class="card">
    <div class="card-title">Access URL</div>

    <div class="alert"><b>Save your URL.</b> Copy it to Notes or a bookmark — it's your persistent key. If the server restarts, paste it in the Refresh field below to restore access instantly.</div>

    <div class="pills">
      <span class="pill pill-red">Tracks</span>
      <span class="pill pill-red">Albums</span>
      <span class="pill pill-red">Artists</span>
      <span class="pill pill-red">Playlists</span>
      <span class="pill pill-blue">youtubei.js</span>
      <span class="pill pill-green">PO Token</span>
      <span class="pill pill-purple">Redis Cache</span>
      <span class="pill pill-green">CSV Export</span>
    </div>

    <span class="lbl">Generate a new URL</span>
    <button class="btn-red" id="genBtn" onclick="generate()">Generate My Addon URL</button>
    <div class="result-box" id="genBox">
      <div class="result-label">Your addon URL — paste into Eclipse</div>
      <div class="result-url" id="genUrl"></div>
      <button class="btn-ghost" id="copyGenBtn" onclick="copyGen()">Copy URL</button>
    </div>

    <hr class="divider">

    <span class="lbl">Refresh existing URL</span>
    <input type="text" id="existingUrl" placeholder="Paste your existing addon URL here">
    <div class="hint">Refreshing keeps the same URL — nothing in Eclipse breaks.</div>
    <button class="btn-green" id="refBtn" onclick="doRefresh()">Refresh Existing URL</button>
    <div class="result-box" id="refBox">
      <div class="result-label">Refreshed — same URL still works in Eclipse</div>
      <div class="result-url" id="refUrl"></div>
      <button class="btn-ghost" id="copyRefBtn" onclick="copyRef()">Copy URL</button>
    </div>

    <hr class="divider">

    <div class="steps">
      <div class="step"><div class="step-num">1</div><div class="step-text">Generate and copy your URL above</div></div>
      <div class="step"><div class="step-num">2</div><div class="step-text">Open <b>Eclipse</b> → Settings → Connections → Add Connection → Addon</div></div>
      <div class="step"><div class="step-num">3</div><div class="step-text">Paste your URL and tap <b>Install</b></div></div>
      <div class="step"><div class="step-num">4</div><div class="step-text">Use <b>Playlist Importer</b> below to export a YouTube Music playlist as CSV</div></div>
    </div>
  </div>

  <!-- Playlist importer card -->
  <div class="card">
    <span class="section-badge">⬇ Playlist Importer</span>
    <div class="card-title">Export Playlist → CSV</div>

    <p style="font-size:13px;color:#666;line-height:1.7;margin-bottom:20px;">Downloads a CSV you can import in Eclipse via <b style="color:#888">Library → Import CSV</b>.</p>

    <span class="lbl">Your Addon URL</span>
    <input type="text" id="impToken" placeholder="Paste your addon URL (auto-fills after generating)">

    <span class="lbl">YouTube Music Playlist URL</span>
    <input type="text" id="impUrl" placeholder="music.youtube.com/playlist?list=...">
    <div class="hint">Both <code>?list=</code> and <code>browse/VL...</code> formats work.</div>

    <div class="status" id="impStatus"></div>
    <div class="preview" id="impPreview"></div>
    <button class="btn-green" id="impBtn" onclick="doImport()">Fetch &amp; Download CSV</button>
  </div>

</div>

<footer>
  Eclipse YouTube Music Addon v1.5.0 &nbsp;·&nbsp;
  <a href="${base}/health" target="_blank">${base}/health</a>
</footer>

<script>
var _gu="",_ru="";

function generate(){
  var btn=document.getElementById("genBtn");
  btn.disabled=true; btn.textContent="Generating…";
  fetch("/generate",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"})
    .then(r=>r.json())
    .then(function(d){
      if(d.error){alert(d.error);btn.disabled=false;btn.textContent="Generate My Addon URL";return;}
      _gu=d.manifestUrl;
      document.getElementById("genUrl").textContent=_gu;
      document.getElementById("genBox").style.display="block";
      document.getElementById("impToken").value=_gu;
      btn.disabled=false; btn.textContent="Regenerate URL";
    })
    .catch(function(e){alert("Error: "+e.message);btn.disabled=false;btn.textContent="Generate My Addon URL";});
}

function copyGen(){
  if(!_gu)return;
  navigator.clipboard.writeText(_gu).then(function(){
    var b=document.getElementById("copyGenBtn");
    b.textContent="Copied!"; setTimeout(function(){b.textContent="Copy URL";},1500);
  });
}

function doRefresh(){
  var btn=document.getElementById("refBtn"),eu=document.getElementById("existingUrl").value.trim();
  if(!eu){alert("Paste your existing addon URL first.");return;}
  btn.disabled=true; btn.textContent="Refreshing…";
  fetch("/refresh",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({existingUrl:eu})})
    .then(r=>r.json())
    .then(function(d){
      if(d.error){alert(d.error);btn.disabled=false;btn.textContent="Refresh Existing URL";return;}
      _ru=d.manifestUrl;
      document.getElementById("refUrl").textContent=_ru;
      document.getElementById("refBox").style.display="block";
      document.getElementById("impToken").value=_ru;
      btn.disabled=false; btn.textContent="Refresh Again";
    })
    .catch(function(e){alert("Error: "+e.message);btn.disabled=false;btn.textContent="Refresh Existing URL";});
}

function copyRef(){
  if(!_ru)return;
  navigator.clipboard.writeText(_ru).then(function(){
    var b=document.getElementById("copyRefBtn");
    b.textContent="Copied!"; setTimeout(function(){b.textContent="Copy URL";},1500);
  });
}

function getTok(s){var m=s.match(/\\/u\\/([a-f0-9]{28})\\//);return m?m[1]:null;}
function hesc(s){return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}

function doImport(){
  var btn=document.getElementById("impBtn"),
      raw=document.getElementById("impToken").value.trim(),
      purl=document.getElementById("impUrl").value.trim(),
      st=document.getElementById("impStatus"),
      pv=document.getElementById("impPreview");
  if(!raw){st.className="status err";st.textContent="Paste your addon URL first.";return;}
  if(!purl){st.className="status err";st.textContent="Paste a YouTube Music playlist URL.";return;}
  var tok=getTok(raw);
  if(!tok){st.className="status err";st.textContent="Could not find your token in the URL.";return;}
  btn.disabled=true; btn.textContent="Fetching…";
  st.className="status loading"; st.textContent="Fetching tracks…"; pv.style.display="none";
  fetch("/u/"+tok+"/import?url="+encodeURIComponent(purl))
    .then(function(r){
      if(!r.ok){return r.json().then(function(e){throw new Error(e.error||("Server error "+r.status));});}
      return r.json();
    })
    .then(function(data){
      var tracks=data.tracks||[];
      if(!tracks.length)throw new Error("No tracks found.");
      var rows=tracks.slice(0,50).map(function(t,i){
        return '<div class="track-row"><span class="track-num">'+(i+1)+'</span><div class="track-info"><div class="track-title">'+hesc(t.title)+'</div><div class="track-artist">'+hesc(t.artist||"")+'</div></div></div>';
      });
      if(tracks.length>50)rows.push('<div class="track-row" style="justify-content:center;color:#444"><span class="track-num"></span><div class="track-info"><div class="track-title">'+hesc((tracks.length-50)+' more…')+'</div></div></div>');
      pv.innerHTML=rows.join(""); pv.style.display="block";
      st.className="status ok"; st.textContent="Found "+tracks.length+' tracks in "'+hesc(data.title||"playlist")+'". Downloading CSV…';
      var lines=["Title,Artist,Album,Duration"];
      tracks.forEach(function(t){
        function ce(s){var x=String(s||"");if(x.indexOf(",")!==-1||x.indexOf('"')!==-1){x='"'+x.replace(/"/g,'""')+'"';}return x;}
        lines.push(ce(t.title)+","+ce(t.artist)+","+ce(data.title)+","+ce(t.duration||""));
      });
      var blob=new Blob([lines.join("\\n")],{type:"text/csv"});
      var a=document.createElement("a");
      a.href=URL.createObjectURL(blob);
      a.download=(data.title||"playlist").replace(/[^a-zA-Z0-9 \\-_\\.]/g,"").trim()+".csv";
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      btn.disabled=false; btn.textContent="Fetch & Download CSV";
    })
    .catch(function(e){
      st.className="status err"; st.textContent=e.message;
      btn.disabled=false; btn.textContent="Fetch & Download CSV";
    });
}
</script>
</body>
</html>`;
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
    status:       'ok',
    version:      '1.5.0',
    ytmusicReady: ytmReady,
    ytReady:      !!_yt,
    redis:        !!(redis && redis.status === 'ready'),
    tokens:       TOKEN_CACHE.size,
    streamCache:  STREAM_MEM.size,
    timestamp:    new Date().toISOString()
  });
});

app.get('/u/:token/manifest.json', authMw, (req, res) => {
  res.json({
    id:          'com.eclipse.ytmusic.' + req.params.token.slice(0, 8),
    name:        'YouTube Music',
    version:     '1.5.0',
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
    res.json({
      id: a.albumId, title: a.name || 'Unknown', artist: (a.artist && a.artist.name) || 'Unknown',
      artworkURL: thumb(a.thumbnails), year: a.year ? String(a.year) : null,
      description: a.description || null, trackCount: (a.songs || []).length || null,
      tracks: (a.songs || []).map(s => ({ id: s.videoId, title: s.name || 'Unknown', artist: (s.artist && s.artist.name) || (a.artist && a.artist.name) || 'Unknown', duration: dur(s.duration), artworkURL: thumb(s.thumbnails) || thumb(a.thumbnails), format: 'aac' }))
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/u/:token/artist/:id', authMw, async (req, res) => {
  if (!await ensureYTMusic()) return res.status(503).json({ error: 'Not ready.' });
  try {
    const a = await ytmusic.getArtist(req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found.' });
    res.json({
      id: a.artistId, name: a.name || 'Unknown', artworkURL: thumb(a.thumbnails),
      bio: a.description || null, genres: [],
      topTracks: (a.topSongs  || []).slice(0, 10).map(s  => ({ id: s.videoId,  title: s.name  || 'Unknown', artist: (s.artist  && s.artist.name)  || a.name || 'Unknown', duration: dur(s.duration),  artworkURL: thumb(s.thumbnails),  format: 'aac' })),
      albums:    (a.topAlbums || []).slice(0, 10).map(al => ({ id: al.albumId, title: al.name || 'Unknown', artist: a.name || 'Unknown', artworkURL: thumb(al.thumbnails), trackCount: null, year: al.year ? String(al.year) : null }))
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/u/:token/playlist/:id', authMw, async (req, res) => {
  if (!await ensureYTMusic()) return res.status(503).json({ error: 'Not ready.' });
  try {
    const p = await ytmusic.getPlaylist(req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found.' });
    res.json({
      id: p.playlistId, title: p.name || 'Unknown', description: p.description || null,
      artworkURL: thumb(p.thumbnails), creator: (p.artist && p.artist.name) || null,
      tracks: (p.songs || []).map(s => ({ id: s.videoId, title: s.name || 'Unknown', artist: (s.artist && s.artist.name) || 'Unknown', duration: dur(s.duration), artworkURL: thumb(s.thumbnails), format: 'aac' }))
    });
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
    res.json({
      id: p.playlistId, title: p.name || 'YouTube Music Playlist',
      tracks: (p.songs || []).map(s => ({ id: s.videoId, title: s.name || 'Unknown', artist: (s.artist && s.artist.name) || 'Unknown', duration: dur(s.duration) }))
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log('[server] v1.5.0 port ' + PORT));
module.exports = app;
