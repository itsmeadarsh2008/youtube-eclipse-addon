// ─── YouTube Music — Eclipse Addon ────────────────────────────────────────────
// Cloudflare Workers edition
// author: ricky
// version: 1.0.0

const LOG_PREFIX = '[YTMusic]';
const YTM_BASE = 'https://music.youtube.com';
const YTM_API_KEY = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30';
const VISITOR_DATA_TTL_MS = 20 * 60 * 1000;

const WEB_REMIX_CONTEXT = {
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

const QUALITY = { LOW: 'LOW', HIGH: 'HIGH', LOSSLESS: 'LOSSLESS' };
const DOWNLOAD_API_BASE = 'https://capi.y2jar.cc/scr/';

// ─── Token generation ─────────────────────────────────────────────────────────

function generateToken() {
  const arr = new Uint8Array(14);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

function isValidToken(t) {
  return typeof t === 'string' && /^[a-f0-9]{28}$/.test(t);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseDuration(text) {
  if (!text) return 0;
  const parts = text.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

function bestThumbnail(thumbnails) {
  if (!thumbnails || !thumbnails.length) return '';
  return thumbnails.reduce((b, t) => ((t.width || 0) > (b.width || 0) ? t : b)).url;
}

function parseInfoRuns(runs) {
  if (!runs || !runs.length) return { artist: '', album: '' };
  const parts = [];
  let cur = '';
  for (const run of runs) {
    if (run.text === ' \u2022 ') { if (cur) parts.push(cur.trim()); cur = ''; }
    else cur += run.text;
  }
  if (cur) parts.push(cur.trim());
  while (parts.length > 1 && /^\d+:\d{2}(:\d{2})?$/.test(parts[parts.length - 1])) parts.pop();
  const typeLabels = ['Song', 'Video', 'EP', 'Single', 'Podcast'];
  let idx = 0;
  if (parts.length > 1 && typeLabels.includes(parts[0])) idx = 1;
  return { artist: parts[idx] || '', album: parts[idx + 1] || '' };
}

function buildIosContext(visitorData) {
  const ctx = { ...IOS_CLIENT_BASE };
  if (visitorData) ctx.visitorData = visitorData;
  return ctx;
}

// ─── visitorData — KV-backed TTL cache ────────────────────────────────────────

async function fetchFreshVisitorData(env) {
  try {
    const resp = await fetch(`${YTM_BASE}/youtubei/v1/visitor_id?key=${YTM_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: { client: WEB_REMIX_CONTEXT } }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const d = await resp.json();
    const vd = d?.responseContext?.visitorData || null;
    if (vd && env && env.YTM_CACHE) {
      await env.YTM_CACHE.put(
        'visitorData',
        JSON.stringify({ visitorData: vd, fetchedAt: Date.now() }),
        { expirationTtl: Math.floor(VISITOR_DATA_TTL_MS / 1000) }
      );
    }
    return vd;
  } catch (e) {
    console.log(LOG_PREFIX, 'visitorData fetch failed:', e.message);
    return null;
  }
}

async function getVisitorData(env) {
  if (env && env.YTM_CACHE) {
    try {
      const raw = await env.YTM_CACHE.get('visitorData');
      if (raw) {
        const cached = JSON.parse(raw);
        if (cached.visitorData && Date.now() - cached.fetchedAt < VISITOR_DATA_TTL_MS)
          return cached.visitorData;
      }
    } catch {}
  }
  return fetchFreshVisitorData(env || {});
}

// ─── Search ───────────────────────────────────────────────────────────────────
// Eclipse calls: GET /search?q={query}
// Response must use: artworkURL (not albumCover)

async function handleSearch(query, env) {
  if (!query) return { tracks: [], albums: [], artists: [] };

  const response = await fetch(`${YTM_BASE}/youtubei/v1/search?key=${YTM_API_KEY}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: YTM_BASE,
      Referer: `${YTM_BASE}/`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
    body: JSON.stringify({
      context: { client: WEB_REMIX_CONTEXT },
      query,
      params: 'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D',
    }),
  });

  if (!response.ok) throw new Error(`${LOG_PREFIX} Search HTTP ${response.status}`);
  const data = await response.json();

  // Opportunistically cache visitorData
  if (data?.responseContext?.visitorData && env && env.YTM_CACHE) {
    env.YTM_CACHE.put(
      'visitorData',
      JSON.stringify({ visitorData: data.responseContext.visitorData, fetchedAt: Date.now() }),
      { expirationTtl: Math.floor(VISITOR_DATA_TTL_MS / 1000) }
    );
  }

  const tracks = [];
  const sections =
    data?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]
      ?.tabRenderer?.content?.sectionListRenderer?.contents || [];

  for (const section of sections) {
    const shelf = section.musicShelfRenderer;
    if (!shelf) continue;
    for (const item of shelf.contents || []) {
      if (tracks.length >= 20) break;
      const r = item.musicResponsiveListItemRenderer;
      if (!r) continue;
      const videoId =
        r.playlistItemData?.videoId ||
        r.overlay?.musicItemThumbnailOverlayRenderer?.content
          ?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId;
      if (!videoId) continue;

      const title = r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer
        ?.text?.runs?.map(t => t.text).join('') || '';
      const infoRuns = r.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
      const info = parseInfoRuns(infoRuns);
      const durationText = r.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer
        ?.text?.runs?.[0]?.text || '';
      const thumbs = r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];

      tracks.push({
        id: videoId,
        title,
        artist: info.artist,
        album: info.album,
        duration: parseDuration(durationText),
        artworkURL: bestThumbnail(thumbs),   // Eclipse field name
        format: 'aac',
      });
    }
  }

  return { tracks, albums: [], artists: [] };
}

// ─── Stream resolution ────────────────────────────────────────────────────────
// Eclipse calls: GET /stream/{id}
// Response must use: url (not streamUrl)

async function fetchPlayerData(trackId, env) {
  const visitorData = await getVisitorData(env);

  const response = await fetch(`${YTM_BASE}/youtubei/v1/player?prettyPrint=false`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'com.google.ios.youtube/20.10.01 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X)',
    },
    body: JSON.stringify({
      context: { client: buildIosContext(visitorData) },
      videoId: trackId,
      contentCheckOk: true,
      racyCheckOk: true,
    }),
  });

  if (!response.ok) throw new Error(`${LOG_PREFIX} Player HTTP ${response.status}`);
  const data = await response.json();
  const status = data?.playabilityStatus?.status;

  if (status !== 'OK') {
    if (env && env.YTM_CACHE) env.YTM_CACHE.delete('visitorData');
    throw new Error(
      `${LOG_PREFIX} Blocked: ${data?.playabilityStatus?.reason || status || 'unknown'}`
    );
  }

  return data.streamingData;
}

function pickMp4Url(sd) {
  const fmts = (sd.adaptiveFormats || []).filter(f => f.mimeType?.startsWith('audio/mp4') && f.url);
  if (!fmts.length) return null;
  fmts.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  return fmts[0].url;
}

async function handleStream(trackId, env) {
  const sd = await fetchPlayerData(trackId, env);
  if (!sd) throw new Error(`${LOG_PREFIX} No streaming data`);

  // Prefer HLS — AVPlayer handles it natively
  if (sd.hlsManifestUrl) {
    return {
      url: sd.hlsManifestUrl,
      format: 'aac',
      quality: 'high',
    };
  }

  // Fallback: direct mp4 audio
  const mp4Url = pickMp4Url(sd);
  if (mp4Url) {
    return {
      url: mp4Url,
      format: 'aac',
      quality: 'high',
    };
  }

  throw new Error(`${LOG_PREFIX} No playable audio for ${trackId}`);
}

// ─── Album details ────────────────────────────────────────────────────────────
// Eclipse calls: GET /album/{id}

async function handleAlbum(albumId, env) {
  const response = await fetch(`${YTM_BASE}/youtubei/v1/browse?key=${YTM_API_KEY}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: YTM_BASE,
      Referer: `${YTM_BASE}/`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
    body: JSON.stringify({ context: { client: WEB_REMIX_CONTEXT }, browseId: albumId }),
  });

  if (!response.ok) throw new Error(`${LOG_PREFIX} Album HTTP ${response.status}`);
  const data = await response.json();

  if (data?.responseContext?.visitorData && env && env.YTM_CACHE) {
    env.YTM_CACHE.put(
      'visitorData',
      JSON.stringify({ visitorData: data.responseContext.visitorData, fetchedAt: Date.now() }),
      { expirationTtl: Math.floor(VISITOR_DATA_TTL_MS / 1000) }
    );
  }

  const header =
    data?.header?.musicImmersiveHeaderRenderer ||
    data?.header?.musicDetailHeaderRenderer || {};
  const albumTitle = header?.title?.runs?.[0]?.text || '';
  let albumArtist = '';
  if (header?.subtitle?.runs) {
    for (const run of header.subtitle.runs) {
      if (run.navigationEndpoint?.browseEndpoint) { albumArtist = run.text; break; }
    }
  }
  const artworkURL = bestThumbnail(
    header?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || []
  );

  const contents =
    data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]
      ?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]
      ?.musicShelfRenderer?.contents || [];

  const tracks = contents
    .filter(c => c.musicResponsiveListItemRenderer?.playlistItemData?.videoId)
    .map(c => {
      const r = c.musicResponsiveListItemRenderer;
      return {
        id: r.playlistItemData.videoId,
        title: r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer
          ?.text?.runs?.[0]?.text || '',
        artist: albumArtist,
        album: albumTitle,
        duration: parseDuration(
          r.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer
            ?.text?.runs?.[0]?.text || ''
        ),
        artworkURL,            // Eclipse field name
        format: 'aac',
      };
    });

  return {
    id: albumId,
    title: albumTitle,
    artist: albumArtist,
    artworkURL,               // Eclipse field name
    trackCount: tracks.length,
    tracks,
  };
}

// ─── Eclipse manifest ─────────────────────────────────────────────────────────
// Eclipse strips /manifest.json from the URL and uses the rest as base URL.
// So token-based URL /u/:token/manifest.json → base /u/:token → Eclipse calls
// /u/:token/search, /u/:token/stream/:id, /u/:token/album/:id  automatically.

function buildManifest() {
  return {
    id: 'com.ricky.youtube-music',
    name: 'YouTube Music',
    version: '1.0.0',
    description: 'Stream and download from YouTube Music. HLS preferred, MP4 fallback.',
    icon: 'https://www.gstatic.com/youtube/media/ytm/images/applauncher/music_icon_144x144.png',
    resources: ['search', 'stream', 'catalog'],
    types: ['track', 'album'],
    contentType: 'music',
  };
}

// ─── Landing page ─────────────────────────────────────────────────────────────

function buildPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>YouTube Music for Eclipse</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#080808;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:48px 20px 64px}
.card{background:#111;border:1px solid #1e1e1e;border-radius:18px;padding:36px;max-width:540px;width:100%;box-shadow:0 24px 64px rgba(0,0,0,.6);margin-bottom:20px}
h1{font-size:22px;font-weight:700;margin-bottom:6px;color:#fff}
h2{font-size:16px;font-weight:700;margin-bottom:14px;color:#fff}
p.sub{font-size:14px;color:#666;margin-bottom:20px;line-height:1.6}
.tip{background:#0a0a0a;border:1px solid #1e1e1e;border-radius:10px;padding:12px 14px;margin-bottom:20px;font-size:12px;color:#888;line-height:1.7}
.tip b{color:#ccc}
.pills{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:24px}
.pill{border-radius:20px;font-size:11px;font-weight:600;padding:4px 10px;background:#181818;color:#aaa;border:1px solid #2a2a2a}
.pill.hi{background:#1a0d10;color:#ff4d6d;border-color:#3a1520}
.pill.bl{background:#0d1520;color:#4a9eff;border-color:#1a3050}
.lbl{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#444;margin-bottom:8px;margin-top:16px}
input{width:100%;background:#0a0a0a;border:1px solid #1e1e1e;border-radius:10px;color:#e0e0e0;font-size:14px;padding:12px 14px;margin-bottom:6px;outline:none;transition:border-color .15s}
input:focus{border-color:#fff}
input::placeholder{color:#2e2e2e}
.hint{font-size:12px;color:#3a3a3a;margin-bottom:12px;line-height:1.7}
button{cursor:pointer;border:none;border-radius:10px;font-size:15px;font-weight:700;padding:13px;width:100%;margin-top:6px;margin-bottom:6px;transition:background .15s}
.bw{background:#fff;color:#000}
.bw:hover{background:#e0e0e0}
.bw:disabled{background:#1e1e1e;color:#333;cursor:not-allowed}
.bg{background:#141414;color:#e0e0e0;border:1px solid #2a2a2a}
.bg:hover{background:#1e1e1e}
.bg:disabled{background:#0f0f0f;color:#333;cursor:not-allowed}
.bd{background:#0f0f0f;color:#777;border:1px solid #1a1a1a;font-size:13px;padding:10px}
.bd:hover{background:#1a1a1a;color:#fff}
.box{display:none;background:#0a0a0a;border:1px solid #1a1a1a;border-radius:12px;padding:18px;margin-bottom:10px}
.blbl{font-size:10px;color:#444;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px}
.burl{font-size:12px;color:#fff;word-break:break-all;font-family:'SF Mono','Fira Code',monospace;margin-bottom:14px;line-height:1.5}
hr{border:none;border-top:1px solid #161616;margin:24px 0}
.steps{display:flex;flex-direction:column;gap:12px}
.step{display:flex;gap:12px;align-items:flex-start}
.sn{background:#161616;border:1px solid #222;border-radius:50%;width:26px;height:26px;min-width:26px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#555}
.st{font-size:13px;color:#555;line-height:1.6}
.st b{color:#999}
.warn{background:#0d0d0d;border:1px solid #1e1e1e;border-radius:10px;padding:14px;margin-top:20px;font-size:12px;color:#555;line-height:1.7}
footer{margin-top:32px;font-size:12px;color:#2a2a2a;text-align:center;line-height:1.8}
</style>
</head>
<body>

<div class="card">
  <svg width="52" height="52" viewBox="0 0 52 52" fill="none" style="margin-bottom:22px">
    <circle cx="26" cy="26" r="26" fill="#ff0000"/>
    <rect x="11" y="20" width="4" height="12" rx="2" fill="white"/>
    <rect x="18" y="14" width="4" height="24" rx="2" fill="white"/>
    <rect x="25" y="18" width="4" height="16" rx="2" fill="white"/>
    <rect x="32" y="11" width="4" height="30" rx="2" fill="white"/>
    <rect x="39" y="17" width="4" height="18" rx="2" fill="white"/>
  </svg>

  <h1>YouTube Music for Eclipse</h1>
  <p class="sub">Stream from the full YouTube Music catalog &mdash; HLS preferred, MP4 fallback. No account required.</p>

  <div class="tip"><b>Save your URL.</b> Paste it below any time to copy it again without reinstalling.</div>

  <div class="pills">
    <span class="pill">Tracks &middot; Albums</span>
    <span class="pill hi">HLS Playback</span>
    <span class="pill hi">MP4 Fallback</span>
    <span class="pill bl">Catalog Browse</span>
    <span class="pill bl">Default Playback</span>
  </div>

  <button class="bw" id="genBtn" onclick="generate()">Generate My Addon URL</button>

  <div class="box" id="genBox">
    <div class="blbl">Your addon URL &mdash; paste into Eclipse</div>
    <div class="burl" id="genUrl"></div>
    <button class="bd" id="copyGenBtn" onclick="copyGen()">Copy URL</button>
  </div>

  <hr>

  <h2>Refresh existing URL</h2>
  <input type="text" id="existingUrl" placeholder="Paste your existing addon URL here">
  <div class="hint">Keeps the same token active &mdash; nothing to reinstall.</div>
  <button class="bg" id="refBtn" onclick="doRefresh()">Refresh Existing URL</button>

  <div class="box" id="refBox">
    <div class="blbl">Refreshed &mdash; same URL still works in Eclipse</div>
    <div class="burl" id="refUrl"></div>
    <button class="bd" id="copyRefBtn" onclick="copyRef()">Copy URL</button>
  </div>

  <hr>

  <div class="steps">
    <div class="step"><div class="sn">1</div><div class="st">Generate and copy your URL above</div></div>
    <div class="step"><div class="sn">2</div><div class="st">Open <b>Eclipse</b> &rarr; Settings &rarr; Connections &rarr; Add Connection &rarr; Addon</div></div>
    <div class="step"><div class="sn">3</div><div class="st">Paste your URL and tap <b>Install</b></div></div>
    <div class="step"><div class="sn">4</div><div class="st">Search YouTube Music&rsquo;s full catalog &mdash; streams load automatically</div></div>
  </div>

  <div class="warn">Stream priority: <b>HLS manifest</b> &rarr; <b>Direct MP4 audio</b> fallback. YouTube URLs expire &mdash; the worker never caches them.</div>
</div>

<footer>YouTube Music for Eclipse v1.0.0 &bull; by ricky &bull; Cloudflare Workers</footer>

<script>
var genUrl=null,refUrl=null;
function generate(){
  var btn=document.getElementById('genBtn');
  btn.disabled=true;btn.textContent='Generating...';
  fetch('/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})
    .then(function(r){return r.json();})
    .then(function(d){
      if(d.error){alert(d.error);btn.disabled=false;btn.textContent='Generate My Addon URL';return;}
      genUrl=d.manifestUrl;
      document.getElementById('genUrl').textContent=genUrl;
      document.getElementById('genBox').style.display='block';
      btn.disabled=false;btn.textContent='Regenerate URL';
    })
    .catch(function(e){alert('Error: '+e.message);btn.disabled=false;btn.textContent='Generate My Addon URL';});
}
function copyGen(){if(!genUrl)return;copyText(genUrl,document.getElementById('copyGenBtn'));}
function doRefresh(){
  var eu=document.getElementById('existingUrl').value.trim();
  if(!eu){alert('Paste your existing addon URL first.');return;}
  var btn=document.getElementById('refBtn');
  btn.disabled=true;btn.textContent='Refreshing...';
  fetch('/refresh',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({existingUrl:eu})})
    .then(function(r){return r.json();})
    .then(function(d){
      if(d.error){alert(d.error);btn.disabled=false;btn.textContent='Refresh Existing URL';return;}
      refUrl=d.manifestUrl;
      document.getElementById('refUrl').textContent=refUrl;
      document.getElementById('refBox').style.display='block';
      btn.disabled=false;btn.textContent='Refresh Again';
    })
    .catch(function(e){alert('Error: '+e.message);btn.disabled=false;btn.textContent='Refresh Existing URL';});
}
function copyRef(){if(!refUrl)return;copyText(refUrl,document.getElementById('copyRefBtn'));}
function copyText(text,btn){
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(function(){
      var o=btn.textContent;btn.textContent='Copied!';setTimeout(function(){btn.textContent=o;},1500);
    });
  } else {
    var ta=document.createElement('textarea');ta.value=text;ta.style.position='fixed';ta.style.opacity='0';
    document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);
    var o=btn.textContent;btn.textContent='Copied!';setTimeout(function(){btn.textContent=o;},1500);
  }
}
</script>
</body>
</html>`;
}

// ─── Response helpers ──────────────────────────────────────────────────────────

function jsonRes(data, status) {
  return new Response(JSON.stringify(data, null, 2), {
    status: status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'Content-Type',
      'cache-control': 'no-store',
    },
  });
}

function htmlRes(body) {
  return new Response(body, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

// ─── Route matching helpers ────────────────────────────────────────────────────

// Parses /u/:token from a pathname prefix.
// Returns { token, rest } where rest is the path after the token segment.
// e.g. /u/abc.../search  →  { token: 'abc...', rest: '/search' }
//      /u/abc.../stream/videoId  →  { token: 'abc...', rest: '/stream/videoId' }
function parseTokenPath(pathname) {
  const m = pathname.match(/^\/u\/([a-f0-9]{28})(\/.*)?$/);
  if (!m) return null;
  return { token: m[1], rest: m[2] || '/' };
}

// Extract path param from the end: /stream/VIDEO_ID → VIDEO_ID
function lastSegment(rest) {
  const parts = rest.split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
}

// ─── Core route handler ───────────────────────────────────────────────────────
// Handles either base routes or token-scoped routes identically.

async function handleRoute(rest, url, env) {
  const q = url.searchParams.get('q') || url.searchParams.get('query') || '';

  // GET /manifest.json
  if (rest === '/manifest.json' || rest === '/manifest') {
    return jsonRes(buildManifest());
  }

  // GET /search?q={query}   — Eclipse search
  if (rest === '/search') {
    return jsonRes(await handleSearch(q, env));
  }

  // GET /stream/{id}   — Eclipse stream resolution
  if (rest.startsWith('/stream/')) {
    const trackId = lastSegment(rest);
    if (!trackId) return jsonRes({ error: 'Missing track ID' }, 400);
    return jsonRes(await handleStream(trackId, env));
  }

  // GET /album/{id}   — Eclipse album browse
  if (rest.startsWith('/album/')) {
    const albumId = lastSegment(rest);
    if (!albumId) return jsonRes({ error: 'Missing album ID' }, 400);
    return jsonRes(await handleAlbum(albumId, env));
  }

  return null; // not matched
}

// ─── Worker entry ─────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'Content-Type',
        },
      });
    }

    try {
      // ── Landing page
      if (pathname === '/') return htmlRes(buildPage());

      // ── Generate a unique token URL
      // POST /generate → { token, manifestUrl }
      if (pathname === '/generate' && request.method === 'POST') {
        const token = generateToken();
        return jsonRes({
          token,
          manifestUrl: `${url.origin}/u/${token}/manifest.json`,
        });
      }

      // ── Refresh: extract token from an existing URL and echo it back
      // POST /refresh { existingUrl } → { token, manifestUrl }
      if (pathname === '/refresh' && request.method === 'POST') {
        let body = {};
        try { body = await request.json(); } catch {}
        const raw = String(body.existingUrl || '').trim();
        const m = raw.match(/\/u\/([a-f0-9]{28})/);
        if (!m) return jsonRes({ error: 'Paste your full addon URL — must contain /u/{token}/.' }, 400);
        const token = m[1];
        return jsonRes({
          token,
          manifestUrl: `${url.origin}/u/${token}/manifest.json`,
          refreshed: true,
        });
      }

      // ── Health check
      if (pathname === '/health') {
        return jsonRes({ status: 'ok', version: '1.0.0', ts: new Date().toISOString() });
      }

      // ── Token-scoped routes: /u/:token/{rest}
      // Eclipse stores /u/:token/manifest.json, strips /manifest.json,
      // then calls /u/:token/search, /u/:token/stream/:id, /u/:token/album/:id
      const tp = parseTokenPath(pathname);
      if (tp) {
        if (!isValidToken(tp.token)) return jsonRes({ error: 'Invalid token.' }, 400);
        const result = await handleRoute(tp.rest, url, env);
        if (result) return result;
        return jsonRes({ error: 'Not found' }, 404);
      }

      // ── Base (tokenless) routes — also works directly
      const baseResult = await handleRoute(pathname, url, env);
      if (baseResult) return baseResult;

      return jsonRes({ error: 'Not found' }, 404);

    } catch (err) {
      console.error(LOG_PREFIX, err);
      return jsonRes({ error: err.message || 'Internal error' }, 500);
    }
  },
};
