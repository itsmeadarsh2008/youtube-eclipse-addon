// eclipse-ytmusic — single-file Cloudflare Worker
// Landing page + Eclipse-compatible API + Upstash Redis visitor-data cache
//
// Env vars (set via: npx wrangler secret put REDIS_URL / REDIS_TOKEN):
//   REDIS_URL   — Upstash Redis REST URL  (https://xxx.upstash.io)
//   REDIS_TOKEN — Upstash Redis REST token

import { Redis } from '@upstash/redis/cloudflare';

// ─── Constants ────────────────────────────────────────────────────────────────
const YTM_BASE     = 'https://music.youtube.com';
const YTM_API_KEY  = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30';
const DOWNLOAD_API = 'https://capi.y2jar.cc/scr/';
const VD_KEY       = 'ytm:visitorData';
const VD_TTL_S     = 20 * 60;

const WEB_REMIX_CTX = {
  clientName: 'WEB_REMIX',
  clientVersion: '1.20260304.03.00',
  hl: 'en',
  gl: 'US',
};

const IOS_CLIENT_BASE = {
  clientName: 'IOS',
  clientVersion: '20.10.01',
  deviceMake: 'Apple',
  deviceModel: 'iPhone16,2',
  osName: 'iPhone',
  osVersion: '18.3.2.22D82',
  hl: 'en',
};

// ─── Embedded HTML ────────────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>YouTube Music · Eclipse Addon</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300..700&family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root,[data-theme="light"]{--bg:#f5f4f0;--surface:#faf9f6;--surface-2:#ffffff;--border:#ddd9d3;--text:#1a1917;--muted:#7a7874;--red:#c7372b;--red-h:#a82b20;--red-glow:rgba(199,55,43,.18);--shadow-sm:0 1px 3px rgba(0,0,0,.08);--r:12px;--rsm:8px;--rfull:9999px;--trans:180ms cubic-bezier(.16,1,.3,1);--font-d:'Space Grotesk',sans-serif;--font-b:'Inter',sans-serif}
[data-theme="dark"]{--bg:#0f0f0e;--surface:#161614;--surface-2:#1d1c1a;--border:#2a2926;--text:#e8e6e3;--muted:#7a7874;--red:#ff4e42;--red-h:#ff6a5f;--red-glow:rgba(255,78,66,.22);--shadow-sm:0 1px 3px rgba(0,0,0,.3)}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{-webkit-font-smoothing:antialiased;scroll-behavior:smooth}
body{min-height:100dvh;background:var(--bg);color:var(--text);font-family:var(--font-b);font-size:16px;line-height:1.6;display:flex;flex-direction:column}
button,input{font:inherit;color:inherit}button{cursor:pointer;border:none;background:none}
:focus-visible{outline:2px solid var(--red);outline-offset:3px;border-radius:4px}
a{color:var(--red);text-decoration:none}
.wrap{max-width:860px;margin-inline:auto;padding-inline:clamp(16px,5vw,40px)}
header{position:sticky;top:0;z-index:100;background:color-mix(in oklab,var(--bg) 85%,transparent);backdrop-filter:blur(16px);border-bottom:1px solid var(--border)}
.hdr{display:flex;align-items:center;justify-content:space-between;padding-block:14px}
.logo{display:flex;align-items:center;gap:10px;font-family:var(--font-d);font-size:18px;font-weight:700;color:var(--text)}
.logo-sub{color:var(--muted);font-weight:400}
.tbtn{width:36px;height:36px;border-radius:var(--rfull);display:flex;align-items:center;justify-content:center;color:var(--muted);transition:background var(--trans),color var(--trans)}
.tbtn:hover{background:var(--surface-2);color:var(--text)}
.hero{padding-block:clamp(48px,8vw,96px) clamp(32px,5vw,56px);text-align:center}
.badge{display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:500;color:var(--muted);background:var(--surface);border:1px solid var(--border);padding:4px 12px;border-radius:var(--rfull);margin-bottom:20px}
.dot{width:7px;height:7px;border-radius:50%;background:var(--red);box-shadow:0 0 0 3px var(--red-glow);animation:pulse 2.2s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
h1{font-family:var(--font-d);font-size:clamp(2rem,5vw,3.5rem);font-weight:700;letter-spacing:-.03em;line-height:1.1;margin-bottom:16px}
h1 em{font-style:normal;color:var(--red)}
.sub{max-width:52ch;margin-inline:auto;font-size:clamp(15px,2vw,17px);color:var(--muted)}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:clamp(20px,3vw,32px);box-shadow:var(--shadow-sm)}
section{padding-bottom:clamp(32px,5vw,56px)}
h2{font-family:var(--font-d);font-size:clamp(18px,2.5vw,22px);font-weight:700;letter-spacing:-.02em;margin-bottom:16px}
.lbl{font-family:var(--font-d);font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:14px}
.hint{font-size:14px;color:var(--muted);margin-bottom:18px}.hint strong{color:var(--text)}
.row{display:flex;gap:10px;flex-wrap:wrap}
.ipt{flex:1;min-width:0;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--rsm);padding:10px 14px;font-size:13px;font-family:ui-monospace,monospace;color:var(--text);transition:border-color var(--trans),box-shadow var(--trans)}
.ipt:focus{outline:none;border-color:var(--red);box-shadow:0 0 0 3px var(--red-glow)}
.btn{padding:10px 20px;border-radius:var(--rsm);font-size:14px;font-weight:600;display:inline-flex;align-items:center;gap:7px;white-space:nowrap;transition:background var(--trans),transform var(--trans),box-shadow var(--trans)}
.btn-p{background:var(--red);color:#fff}
.btn-p:hover{background:var(--red-h);box-shadow:0 4px 14px var(--red-glow);transform:translateY(-1px)}
.btn-p:active{transform:translateY(0)}
.res{margin-top:16px;display:none;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--rsm);overflow:hidden}
.res.show{display:block}
.rrow{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;gap:10px}
.rrow+.rrow{border-top:1px solid var(--border)}
.rlbl{font-size:12px;color:var(--muted);font-weight:500;min-width:90px;flex-shrink:0}
.rval{flex:1;font-size:13px;font-family:ui-monospace,monospace;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cpybtn{flex-shrink:0;padding:5px 12px;font-size:12px;font-weight:600;background:var(--surface);border:1px solid var(--border);border-radius:6px;color:var(--muted);transition:all var(--trans)}
.cpybtn:hover,.cpybtn.ok{background:var(--red);color:#fff;border-color:var(--red)}
.steps{counter-reset:s;list-style:none;display:flex;flex-direction:column;gap:14px}
.steps li{display:flex;align-items:flex-start;gap:14px;counter-increment:s}
.steps li::before{content:counter(s);flex-shrink:0;width:28px;height:28px;background:var(--red);color:#fff;font-size:13px;font-weight:700;font-family:var(--font-d);border-radius:50%;display:flex;align-items:center;justify-content:center;margin-top:2px}
.steps p{font-size:15px}
code{background:var(--surface-2);border:1px solid var(--border);border-radius:4px;padding:1px 6px;font-size:13px;font-family:ui-monospace,monospace}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;padding:8px 12px;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--border)}
td{padding:10px 12px;border-bottom:1px solid color-mix(in oklab,var(--border) 50%,transparent);vertical-align:top}
tr:last-child td{border-bottom:none}
.met{font-family:ui-monospace,monospace;font-size:11px;font-weight:700;padding:2px 7px;border-radius:4px;background:color-mix(in oklab,var(--red) 14%,var(--surface-2));color:var(--red)}
.ep{font-family:ui-monospace,monospace;font-size:13px}
footer{margin-top:auto;border-top:1px solid var(--border);padding-block:20px;text-align:center;font-size:13px;color:var(--muted)}
@media(max-width:600px){.row{flex-direction:column}.rrow{flex-wrap:wrap}.rval{flex-basis:100%;order:1}.cpybtn{order:2}}
</style>
</head>
<body>
<header><div class="wrap"><div class="hdr">
  <div class="logo">
    <svg width="30" height="30" viewBox="0 0 30 30" fill="none">
      <rect width="30" height="30" rx="8" fill="#FF0000"/>
      <circle cx="15" cy="15" r="7" fill="white" opacity=".15"/>
      <circle cx="15" cy="15" r="5" fill="white"/>
      <circle cx="15" cy="15" r="2" fill="#FF0000"/>
    </svg>
    YT Music <span class="logo-sub">for Eclipse</span>
  </div>
  <button class="tbtn" data-theme-toggle aria-label="Toggle theme">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
  </button>
</div></div></header>
<main><div class="wrap">
  <section class="hero">
    <div class="badge"><span class="dot"></span> Cloudflare Workers</div>
    <h1>YouTube Music<br><em>Eclipse Addon</em></h1>
    <p class="sub">Stream and download from YouTube Music inside Eclipse. HLS-first with mp4 fallback. Each Generate press creates a unique install URL.</p>
  </section>
  <section>
    <div class="card">
      <div class="lbl">Your Addon URL</div>
      <p class="hint">Press <strong>Generate</strong> for a unique manifest URL. Each press gives a new token — paste it into Eclipse to install.</p>
      <div class="row">
        <input class="ipt" id="manifestUrl" placeholder="Click Generate…" readonly>
        <button class="btn btn-p" id="genBtn" onclick="doGenerate()">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg>
          Generate
        </button>
      </div>
      <div class="res" id="resBlock">
        <div class="rrow"><span class="rlbl">Manifest URL</span><span class="rval" id="rv-manifest"></span><button class="cpybtn" onclick="cp('rv-manifest',this)">Copy</button></div>
        <div class="rrow"><span class="rlbl">Base URL</span><span class="rval" id="rv-base"></span><button class="cpybtn" onclick="cp('rv-base',this)">Copy</button></div>
        <div class="rrow"><span class="rlbl">Token</span><span class="rval" id="rv-token"></span><button class="cpybtn" onclick="cp('rv-token',this)">Copy</button></div>
      </div>
    </div>
  </section>
  <section>
    <h2>Install in Eclipse</h2>
    <div class="card">
      <ol class="steps">
        <li><p>Press <strong>Generate</strong> above and copy the Manifest URL.</p></li>
        <li><p>Open Eclipse → <code>Settings</code> → <code>Connections</code> → <code>Add Connection</code> → <code>Addon</code>.</p></li>
        <li><p>Paste the URL — Eclipse fetches the manifest. Tap <strong>Install</strong>.</p></li>
        <li><p>Search any track and select the <strong>YouTube Music</strong> source.</p></li>
      </ol>
    </div>
  </section>
  <section>
    <h2>API Endpoints</h2>
    <div class="card" style="padding:0;overflow:hidden">
      <table>
        <thead><tr><th>Method</th><th>Path</th><th>Description</th></tr></thead>
        <tbody>
          <tr><td><span class="met">GET</span></td><td class="ep">/u/:token/manifest.json</td><td>Eclipse addon manifest</td></tr>
          <tr><td><span class="met">GET</span></td><td class="ep">/u/:token/search?q=…</td><td>Search tracks, albums, artists, playlists</td></tr>
          <tr><td><span class="met">GET</span></td><td class="ep">/u/:token/stream/:videoId</td><td>HLS stream URL → mp4 fallback</td></tr>
          <tr><td><span class="met">GET</span></td><td class="ep">/u/:token/album/:browseId</td><td>Album details + tracks</td></tr>
          <tr><td><span class="met">GET</span></td><td class="ep">/u/:token/artist/:browseId</td><td>Artist info + top tracks + albums</td></tr>
          <tr><td><span class="met">GET</span></td><td class="ep">/u/:token/download/:videoId</td><td>y2jar download URL</td></tr>
          <tr><td><span class="met">GET</span></td><td class="ep">/generate-token</td><td>Fresh unique token</td></tr>
        </tbody>
      </table>
    </div>
  </section>
</div></main>
<footer><div class="wrap">eclipse-ytmusic · by nvmindl · Cloudflare Workers</div></footer>
<script>
(function(){
  const btn=document.querySelector('[data-theme-toggle]'),r=document.documentElement;
  let d='dark';r.setAttribute('data-theme',d);
  if(btn)btn.addEventListener('click',()=>{
    d=d==='dark'?'light':'dark';r.setAttribute('data-theme',d);
    btn.innerHTML=d==='dark'
      ?'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>'
      :'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>';
  });
})();
function setResult(tok,base,manifest){
  document.getElementById('manifestUrl').value=manifest;
  document.getElementById('rv-manifest').textContent=manifest;
  document.getElementById('rv-base').textContent=base;
  document.getElementById('rv-token').textContent=tok;
  document.getElementById('resBlock').classList.add('show');
}
function doGenerate(){
  const btn=document.getElementById('genBtn');
  btn.disabled=true;
  fetch('/generate-token')
    .then(r=>r.json())
    .then(d=>setResult(d.token,d.addonBase,d.manifestUrl))
    .catch(()=>{
      const a=new Uint8Array(16);crypto.getRandomValues(a);
      const tok=Array.from(a,b=>b.toString(16).padStart(2,'0')).join('');
      const o=location.origin;
      setResult(tok,o+'/u/'+tok,o+'/u/'+tok+'/manifest.json');
    })
    .finally(()=>{ btn.disabled=false; });
}
async function cp(id,btn){
  const txt=document.getElementById(id)?.textContent?.trim();
  if(!txt)return;
  try{await navigator.clipboard.writeText(txt);}catch(e){
    const ta=document.createElement('textarea');ta.value=txt;ta.style.cssText='position:fixed;opacity:0';
    document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);
  }
  const o=btn.textContent;btn.textContent='Copied!';btn.classList.add('ok');
  setTimeout(()=>{btn.textContent=o;btn.classList.remove('ok');},1400);
}
</script>
</body>
</html>`;

// ─── CORS / response helpers ──────────────────────────────────────────────────

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
function jsonResp(data, req, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(req?.headers?.get('Origin')) },
  });
}
function errResp(status, msg, req) {
  return jsonResp({ error: msg }, req, status);
}

// ─── YTMusic data helpers ─────────────────────────────────────────────────────

function parseDuration(text) {
  if (!text) return 0;
  const p = text.split(':').map(Number);
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  if (p.length === 2) return p[0] * 60 + p[1];
  return p[0] || 0;
}

function bestThumbnail(thumbnails) {
  if (!thumbnails?.length) return '';
  return thumbnails.reduce((b, t) => ((t.width || 0) > (b.width || 0) ? t : b)).url || '';
}

function parseInfoRuns(runs) {
  if (!runs?.length) return { artist: '', album: '' };
  const parts = [];
  let cur = '';
  for (const run of runs) {
    if (run.text === ' \u2022 ') { if (cur) parts.push(cur.trim()); cur = ''; }
    else cur += run.text;
  }
  if (cur) parts.push(cur.trim());
  // Strip trailing duration token
  while (parts.length > 1 && /^\d{1,2}:\d{2}(:\d{2})?$/.test(parts[parts.length - 1])) parts.pop();
  // Skip leading type labels (Song, Video, EP, Single…)
  const labels = ['Song', 'Video', 'EP', 'Single', 'Podcast'];
  const idx = (parts.length > 1 && labels.includes(parts[0])) ? 1 : 0;
  return { artist: parts[idx] || '', album: parts[idx + 1] || '' };
}

// ─── Upstash Redis — visitorData cache ───────────────────────────────────────
// Falls back to in-memory if REDIS_URL / REDIS_TOKEN not set.

let _memVD = null;
let _memVDAt = 0;
const MEM_TTL_MS = VD_TTL_S * 1000;

function getRedis(env) {
  if (env?.REDIS_URL && env?.REDIS_TOKEN) {
    return new Redis({ url: env.REDIS_URL, token: env.REDIS_TOKEN });
  }
  return null;
}

async function getVisitorData(env) {
  const redis = getRedis(env);
  if (redis) {
    try { const v = await redis.get(VD_KEY); if (v) return v; } catch (_) {}
  } else {
    if (_memVD && Date.now() - _memVDAt < MEM_TTL_MS) return _memVD;
  }
  return refreshVisitorData(env);
}

async function refreshVisitorData(env) {
  try {
    const resp = await fetch(`${YTM_BASE}/youtubei/v1/visitor_id?key=${YTM_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: { client: WEB_REMIX_CTX } }),
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const d = await resp.json();
    const vd = d?.responseContext?.visitorData;
    if (vd) await cacheVisitorData(vd, env);
    return vd || null;
  } catch (e) {
    console.error('[YTMusic] visitorData fetch failed:', e.message);
    return null;
  }
}

async function cacheVisitorData(vd, env) {
  const redis = getRedis(env);
  if (redis) {
    try { await redis.set(VD_KEY, vd, { ex: VD_TTL_S }); } catch (_) {}
  } else {
    _memVD = vd; _memVDAt = Date.now();
  }
}

async function bustVisitorData(env) {
  const redis = getRedis(env);
  if (redis) { try { await redis.del(VD_KEY); } catch (_) {} }
  else { _memVD = null; _memVDAt = 0; }
}

// ─── YTM POST helper ─────────────────────────────────────────────────────────

async function ytmPost(path, body, env) {
  const resp = await fetch(`${YTM_BASE}${path}?key=${YTM_API_KEY}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': YTM_BASE,
      'Referer': YTM_BASE + '/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'X-Goog-Api-Key': YTM_API_KEY,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`YTM HTTP ${resp.status} on ${path}`);
  const data = await resp.json();
  // Opportunistically refresh cached visitorData
  if (data?.responseContext?.visitorData) {
    await cacheVisitorData(data.responseContext.visitorData, env);
  }
  return data;
}

// ─── Search ───────────────────────────────────────────────────────────────────

async function doSearch(query, limit, env) {
  // Run both in parallel:
  //   req1 — songs filter: reliable full track list with durations
  //   req2 — no filter:    albums / artists / community playlists shelves
  const [songsRes, allRes] = await Promise.allSettled([
    ytmPost('/youtubei/v1/search', {
      context: { client: WEB_REMIX_CTX },
      query,
      params: 'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D',
    }, env),
    ytmPost('/youtubei/v1/search', {
      context: { client: WEB_REMIX_CTX },
      query,
    }, env),
  ]);

  const tracks = [];
  const albums = [];
  const artists = [];
  const playlists = [];

  function shelves(data) {
    return data?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]
      ?.tabRenderer?.content?.sectionListRenderer?.contents || [];
  }

  // ── Tracks from songs-filtered response ──────────────────────────────────
  if (songsRes.status === 'fulfilled') {
    for (const section of shelves(songsRes.value)) {
      const shelf = section.musicShelfRenderer;
      if (!shelf) continue;
      for (const item of (shelf.contents || [])) {
        if (tracks.length >= limit) break;
        const r = item.musicResponsiveListItemRenderer;
        if (!r) continue;

        const videoId =
          r.playlistItemData?.videoId ||
          r.overlay?.musicItemThumbnailOverlayRenderer?.content
            ?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId;
        if (!videoId) continue;

        const title = r.flexColumns?.[0]
          ?.musicResponsiveListItemFlexColumnRenderer?.text?.runs
          ?.map(t => t.text).join('') || '';

        const col1 = r.flexColumns?.[1]
          ?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];

        const info = parseInfoRuns(col1);
        const thumbs = r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];

        // Duration: fixedColumns first, then scan col1 runs backwards for M:SS pattern
        let durText = r.fixedColumns?.[0]
          ?.musicResponsiveListItemFixedColumnRenderer?.text?.runs?.[0]?.text || '';
        if (!durText) {
          for (let i = col1.length - 1; i >= 0; i--) {
            if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(col1[i]?.text || '')) {
              durText = col1[i].text;
              break;
            }
          }
        }

        tracks.push({
          id: videoId,
          title,
          artist: info.artist,
          album: info.album,
          duration: parseDuration(durText),
          artworkURL: bestThumbnail(thumbs),
          format: 'aac',
          type: 'track',
        });
      }
    }
  }

  // ── Albums / Artists / Playlists from unfiltered response ────────────────
  if (allRes.status === 'fulfilled') {
    for (const section of shelves(allRes.value)) {
      const shelf = section.musicShelfRenderer;
      if (!shelf) continue;

      const shelfTitle = (shelf.title?.runs?.[0]?.text || '').toLowerCase();

      for (const item of (shelf.contents || [])) {
        const r = item.musicResponsiveListItemRenderer;
        if (!r) continue;

        const title = r.flexColumns?.[0]
          ?.musicResponsiveListItemFlexColumnRenderer?.text?.runs
          ?.map(t => t.text).join('') || '';
        const col1 = r.flexColumns?.[1]
          ?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
        const thumbs = r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
        const artworkURL = bestThumbnail(thumbs);

        // browseId lives on the title run's navigationEndpoint, or the row-level endpoint
        const titleNavEp = r.flexColumns?.[0]
          ?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]
          ?.navigationEndpoint;
        const browseId =
          titleNavEp?.browseEndpoint?.browseId ||
          r.navigationEndpoint?.browseEndpoint?.browseId;

        // Artist name: first run in col1 that has a browseEndpoint
        const artistRun = col1.find(run => run.navigationEndpoint?.browseEndpoint);
        const artistName = artistRun?.text || parseInfoRuns(col1).artist;

        if (shelfTitle.includes('album') || shelfTitle.includes('single') || shelfTitle.includes(' ep')) {
          if (browseId && !albums.find(a => a.id === browseId)) {
            albums.push({ id: browseId, title, artist: artistName, artworkURL, type: 'album' });
          }
        } else if (shelfTitle.includes('artist')) {
          if (browseId && !artists.find(a => a.id === browseId)) {
            artists.push({ id: browseId, name: title, artworkURL, type: 'artist' });
          }
        } else if (shelfTitle.includes('playlist') || shelfTitle.includes('community')) {
          // Playlists may use browseId OR a watchEndpoint playlistId
          const plId =
            browseId ||
            r.overlay?.musicItemThumbnailOverlayRenderer?.content
              ?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.playlistId;
          if (plId && !playlists.find(p => p.id === plId)) {
            playlists.push({ id: plId, title, artist: artistName, artworkURL, type: 'playlist' });
          }
        }
      }
    }
  }

  return { tracks, albums, artists, playlists, total: tracks.length + albums.length + artists.length + playlists.length };
}

// ─── Player ───────────────────────────────────────────────────────────────────

async function fetchPlayerData(videoId, env) {
  const visitorData = await getVisitorData(env);
  const clientCtx = Object.assign({}, IOS_CLIENT_BASE);
  if (visitorData) clientCtx.visitorData = visitorData;

  const resp = await fetch(`${YTM_BASE}/youtubei/v1/player?prettyPrint=false`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'com.google.ios.youtube/20.10.01 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X)',
    },
    body: JSON.stringify({
      context: { client: clientCtx },
      videoId,
      contentCheckOk: true,
      racyCheckOk: true,
    }),
  });
  if (!resp.ok) throw new Error('Player HTTP ' + resp.status);
  const data = await resp.json();
  const status = data?.playabilityStatus?.status;
  if (status !== 'OK') {
    await bustVisitorData(env);
    throw new Error('Playback blocked: ' + (data?.playabilityStatus?.reason || status || 'unknown'));
  }
  return data.streamingData;
}

function pickMp4Url(sd, preferLow) {
  const fmts = (sd.adaptiveFormats || []).filter(f => f.mimeType?.startsWith('audio/mp4') && f.url);
  if (!fmts.length) return null;
  fmts.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  return preferLow ? fmts[fmts.length - 1].url : fmts[0].url;
}

// ─── Album ────────────────────────────────────────────────────────────────────

async function fetchAlbum(browseId, env) {
  const data = await ytmPost('/youtubei/v1/browse', {
    context: { client: WEB_REMIX_CTX }, browseId,
  }, env);

  const header = data?.header?.musicImmersiveHeaderRenderer ||
    data?.header?.musicDetailHeaderRenderer || {};
  const albumTitle = header?.title?.runs?.[0]?.text || '';
  let albumArtist = '';
  for (const run of (header?.subtitle?.runs || [])) {
    if (run.navigationEndpoint?.browseEndpoint) { albumArtist = run.text; break; }
  }
  const albumCover = bestThumbnail(
    header?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || []);

  const contents = data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]
    ?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]
    ?.musicShelfRenderer?.contents || [];

  const tracks = contents
    .filter(c => c.musicResponsiveListItemRenderer?.playlistItemData?.videoId)
    .map(c => {
      const r = c.musicResponsiveListItemRenderer;
      const col1 = r.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
      let durText = r.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text?.runs?.[0]?.text || '';
      if (!durText) {
        for (let i = col1.length - 1; i >= 0; i--) {
          if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(col1[i]?.text || '')) { durText = col1[i].text; break; }
        }
      }
      return {
        id: r.playlistItemData.videoId,
        title: r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text || '',
        artist: albumArtist,
        album: albumTitle,
        duration: parseDuration(durText),
        artworkURL: albumCover,
        format: 'aac',
        type: 'track',
      };
    });

  return { id: browseId, title: albumTitle, artist: albumArtist, artworkURL: albumCover, type: 'album', tracks };
}

// ─── Artist ───────────────────────────────────────────────────────────────────

async function fetchArtist(browseId, env) {
  const data = await ytmPost('/youtubei/v1/browse', {
    context: { client: WEB_REMIX_CTX }, browseId,
  }, env);

  const header = data?.header?.musicImmersiveHeaderRenderer || {};
  const artistName = header?.title?.runs?.[0]?.text || '';
  const artistImg = bestThumbnail(
    header?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails ||
    header?.foregroundThumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || []);

  const sections = data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]
    ?.tabRenderer?.content?.sectionListRenderer?.contents || [];

  const tracks = [];
  const albums = [];

  for (const section of sections) {
    const shelf = section.musicShelfRenderer;
    const carousel = section.musicCarouselShelfRenderer;

    if (shelf) {
      for (const item of (shelf.contents || [])) {
        const r = item.musicResponsiveListItemRenderer;
        if (!r) continue;
        const videoId =
          r.playlistItemData?.videoId ||
          r.overlay?.musicItemThumbnailOverlayRenderer?.content
            ?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId;
        if (!videoId) continue;
        const col1 = r.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
        let durText = r.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text?.runs?.[0]?.text || '';
        if (!durText) {
          for (let i = col1.length - 1; i >= 0; i--) {
            if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(col1[i]?.text || '')) { durText = col1[i].text; break; }
          }
        }
        tracks.push({
          id: videoId,
          title: r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.map(t => t.text).join('') || '',
          artist: artistName,
          album: '',
          duration: parseDuration(durText),
          artworkURL: bestThumbnail(r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || []),
          format: 'aac',
          type: 'track',
        });
      }
    }

    if (carousel) {
      for (const item of (carousel.contents || [])) {
        const c = item.musicTwoRowItemRenderer;
        if (!c) continue;
        const be = c.navigationEndpoint?.browseEndpoint;
        if (!be?.browseId?.startsWith('MPREb_')) continue;
        albums.push({
          id: be.browseId,
          title: c.title?.runs?.[0]?.text || '',
          artist: artistName,
          artworkURL: bestThumbnail(c.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails || []),
          type: 'album',
        });
      }
    }
  }

  return { id: browseId, name: artistName, artworkURL: artistImg, tracks, albums, type: 'artist' };
}

// ─── Manifest builder ─────────────────────────────────────────────────────────

function buildManifest(addonBase) {
  return {
    id: 'com.nvmindl.eclipse.ytmusic',
    name: 'YouTube Music',
    version: '1.0.0',
    description: 'Stream and download from YouTube Music. HLS preferred with automatic mp4 fallback.',
    icon: 'https://www.gstatic.com/youtube/media/ytm/images/applauncher/music_icon_144x144.png',
    author: 'nvmindl',
    resources: ['search', 'stream', 'album', 'artist'],
    types: ['track', 'album', 'artist', 'playlist'],
    contentType: 'music',
    noPrefetch: true,
    noStreamCache: true,
    baseUrl: addonBase,
    endpoints: {
      search:   addonBase + '/search',
      stream:   addonBase + '/stream/{id}',
      album:    addonBase + '/album/{id}',
      artist:   addonBase + '/artist/{id}',
      download: addonBase + '/download/{id}',
    },
  };
}

// ─── Router ───────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS')
      return new Response(null, { headers: cors(request.headers.get('Origin')) });

    const { pathname } = url;

    // ── Landing page ──────────────────────────────────────────────────────────
    if (pathname === '/' || pathname === '')
      return new Response(HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });

    // ── Token generator ───────────────────────────────────────────────────────
    if (pathname === '/generate-token') {
      const arr = new Uint8Array(16);
      crypto.getRandomValues(arr);
      const token = Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
      const addonBase = `${url.origin}/u/${token}`;
      return jsonResp({ token, addonBase, manifestUrl: `${addonBase}/manifest.json` }, request);
    }

    // ── All addon routes are under /u/:token/ ──────────────────────────────────
    const tokenMatch = pathname.match(/^\/u\/([0-9a-f]{32})(\/.*)?$/);
    if (!tokenMatch) return errResp(404, 'Not found', request);

    const token = tokenMatch[1];
    const sub   = (tokenMatch[2] || '/').split('?')[0];
    const addonBase = `${url.origin}/u/${token}`;

    // Manifest
    if (sub === '/manifest.json')
      return jsonResp(buildManifest(addonBase), request);

    // Search
    if (sub === '/search') {
      const q = url.searchParams.get('q') || url.searchParams.get('query') || url.searchParams.get('s') || '';
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), 50);
      if (!q) return jsonResp({ tracks: [], albums: [], artists: [], playlists: [] }, request);
      try { return jsonResp(await doSearch(q, limit, env), request); }
      catch (e) { return errResp(502, e.message, request); }
    }

    // Stream  — Eclipse expects: { url, format, quality, expiresAt }
    if (sub.startsWith('/stream/')) {
      const videoId = sub.slice(8);
      if (!videoId) return errResp(400, 'Missing videoId', request);
      const forceMP4 = url.searchParams.get('forceDirectMp4') === '1';
      try {
        const sd = await fetchPlayerData(videoId, env);
        if (!sd) return errResp(502, 'No streaming data', request);

        // HLS preferred
        if (!forceMP4 && sd.hlsManifestUrl) {
          return jsonResp({
            url: sd.hlsManifestUrl,
            format: 'hls',
            quality: 'high',
            expiresAt: Math.floor(Date.now() / 1000) + 21600,
          }, request);
        }

        // mp4 fallback
        const preferLow = url.searchParams.get('quality') === 'low';
        const mp4 = pickMp4Url(sd, preferLow);
        if (mp4) {
          return jsonResp({
            url: mp4,
            format: 'aac',
            quality: preferLow ? '128kbps' : '256kbps',
            expiresAt: Math.floor(Date.now() / 1000) + 21600,
          }, request);
        }
        return errResp(404, 'No playable audio for ' + videoId, request);
      } catch (e) { return errResp(502, e.message, request); }
    }

    // Album
    if (sub.startsWith('/album/')) {
      const browseId = sub.slice(7);
      if (!browseId) return errResp(400, 'Missing browseId', request);
      try { return jsonResp(await fetchAlbum(browseId, env), request); }
      catch (e) { return errResp(502, e.message, request); }
    }

    // Artist
    if (sub.startsWith('/artist/')) {
      const browseId = sub.slice(8);
      if (!browseId) return errResp(400, 'Missing browseId', request);
      try { return jsonResp(await fetchArtist(browseId, env), request); }
      catch (e) { return errResp(502, e.message, request); }
    }

    // Download
    if (sub.startsWith('/download/')) {
      const videoId = sub.slice(10);
      if (!videoId) return errResp(400, 'Missing videoId', request);
      try {
        const resp = await fetch(DOWNLOAD_API + videoId + '?s=5');
        if (!resp.ok) throw new Error('Download API HTTP ' + resp.status);
        const data = await resp.json();
        if (!data.downloadUrl) throw new Error('No downloadUrl in response');
        return jsonResp({
          url: data.downloadUrl,
          format: 'mp3',
          quality: '320kbps',
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        }, request);
      } catch (e) { return errResp(502, e.message, request); }
    }

    return errResp(404, 'Not found', request);
  },
};
