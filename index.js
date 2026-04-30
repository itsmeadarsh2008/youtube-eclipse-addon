// ─── YouTube Music — Eclipse Addon (Cloudflare Workers) ─────────────────────
// author: ricky  |  version: 1.1.0
// Fixes: duration, artist/album parsing, Videos tab, Upstash Redis cache

const LOG_PREFIX = '[YTMusic]';
const YTM_BASE   = 'https://music.youtube.com';
const YTM_API_KEY = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30';
const VISITOR_TTL_SEC = 1200; // 20 min

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

// YTM search param bytes for each tab
const SEARCH_PARAMS = {
  songs:   'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D',
  videos:  'EgWKAQIQAWoKEAkQChAFEAMQBA%3D%3D',
  albums:  'EgWKAQIYAWoKEAkQChAFEAMQBA%3D%3D',
};

const SEARCH_HEADERS = {
  'Content-Type': 'application/json',
  'Origin': YTM_BASE,
  'Referer': `${YTM_BASE}/`,
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

// ─── Upstash Redis — direct REST fetch, no npm package needed ────────────────

async function upstashCmd(env, ...args) {
  const url   = env?.UPSTASH_REDIS_REST_URL;
  const token = env?.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const res  = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const json = await res.json();
    return json.result ?? null;
  } catch { return null; }
}

// ─── visitorData cache (Upstash Redis, TTL 20 min) ───────────────────────────

async function getVisitorData(env) {
  const cached = await upstashCmd(env, 'GET', 'ytm:visitor');
  if (cached && typeof cached === 'string' && cached.length > 4) return cached;
  return fetchFreshVisitorData(env);
}

async function fetchFreshVisitorData(env) {
  try {
    const resp = await fetch(`${YTM_BASE}/youtubei/v1/visitor_id?key=${YTM_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: { client: WEB_REMIX_CONTEXT } }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const d  = await resp.json();
    const vd = d?.responseContext?.visitorData || null;
    if (vd) {
      upstashCmd(env, 'SET', 'ytm:visitor', vd, 'EX', VISITOR_TTL_SEC);
    }
    return vd;
  } catch (e) {
    console.log(LOG_PREFIX, 'visitorData fetch failed:', e.message);
    return null;
  }
}

// Opportunistically refresh visitorData from any YTM response
function tryRefreshVisitor(data, env) {
  const vd = data?.responseContext?.visitorData;
  if (vd) upstashCmd(env, 'SET', 'ytm:visitor', vd, 'EX', VISITOR_TTL_SEC);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseDuration(text) {
  if (!text) return 0;
  const parts = String(text).trim().split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

// Scan any runs array for a duration-shaped string "m:ss" or "h:mm:ss"
function extractDurationFromRuns(runs) {
  if (!Array.isArray(runs)) return '';
  for (let i = runs.length - 1; i >= 0; i--) {
    const t = (runs[i]?.text || '').trim();
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(t)) return t;
  }
  return '';
}

function bestThumbnail(thumbnails) {
  if (!thumbnails?.length) return '';
  return thumbnails.reduce((b, t) => ((t.width || 0) > (b.width || 0) ? t : b)).url;
}

// Bullet separator in YTM runs — handle all variants: • · " • " etc.
function isBulletRun(text) {
  return /^\s*[•·]\s*$/.test(text || '');
}

// Parse the second flex-column runs into { artist, album }
// YTM format: [type •] artist • album [• duration]
function parseInfoRuns(runs) {
  if (!runs?.length) return { artist: '', album: '' };

  const parts = [];
  let cur = '';
  for (const run of runs) {
    const t = run.text || '';
    if (isBulletRun(t)) {
      if (cur.trim()) parts.push(cur.trim());
      cur = '';
    } else {
      cur += t;
    }
  }
  if (cur.trim()) parts.push(cur.trim());

  // Drop trailing duration strings  ("3:45", "1:02:33")
  while (parts.length > 1 && /^\d{1,2}:\d{2}(:\d{2})?$/.test(parts[parts.length - 1])) {
    parts.pop();
  }

  // Drop leading type labels
  const typeLabels = ['Song', 'Video', 'EP', 'Single', 'Podcast', 'Album', 'Playlist'];
  let idx = 0;
  if (parts.length > 1 && typeLabels.includes(parts[0])) idx = 1;

  return { artist: parts[idx] || '', album: parts[idx + 1] || '' };
}

function buildIosContext(visitorData) {
  const ctx = { ...IOS_CLIENT_BASE };
  if (visitorData) ctx.visitorData = visitorData;
  return ctx;
}

// ─── Parse individual item renderers ─────────────────────────────────────────

function parseTrackRenderer(r) {
  if (!r) return null;

  const videoId =
    r.playlistItemData?.videoId ||
    r.overlay?.musicItemThumbnailOverlayRenderer?.content
      ?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId;
  if (!videoId) return null;

  const titleRuns = r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
  const title     = titleRuns.map(t => t.text).join('').trim();

  const infoRuns  = r.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
  const info      = parseInfoRuns(infoRuns);

  // Duration: fixedColumns is the canonical source for the songs tab;
  // fall back to scanning infoRuns (works for general/video shelf items)
  const durationText =
    r.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text?.runs?.[0]?.text ||
    extractDurationFromRuns(infoRuns) ||
    extractDurationFromRuns(r.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text?.runs);

  const thumbs = r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];

  return {
    id: videoId,
    title,
    artist: info.artist,
    album:  info.album,
    duration: parseDuration(durationText),
    artworkURL: bestThumbnail(thumbs),
    format: 'aac',
  };
}

// Albums can come back as musicTwoRowItemRenderer OR musicResponsiveListItemRenderer
function parseAlbumItem(item) {
  // --- musicTwoRowItemRenderer (most common in album shelf) ---
  const r2 = item?.musicTwoRowItemRenderer;
  if (r2) {
    const id =
      r2.navigationEndpoint?.browseEndpoint?.browseId ||
      r2.overlay?.musicItemThumbnailOverlayRenderer?.content
        ?.musicPlayButtonRenderer?.playNavigationEndpoint?.browseEndpoint?.browseId;
    if (!id) return null;

    const title   = r2.title?.runs?.[0]?.text || '';
    const subRuns = r2.subtitle?.runs || [];
    // subtitle is like: "Album • 2024 • Artist Name" — grab non-bullet, non-year, non-type
    const skipWords = new Set(['Album', 'EP', 'Single', 'Compilation', 'Podcast']);
    const artistParts = subRuns
      .filter(r => !isBulletRun(r.text) && !/^\d{4}$/.test(r.text.trim()) && !skipWords.has(r.text.trim()))
      .map(r => r.text.trim())
      .filter(Boolean);
    const artist = artistParts.join(' ').trim();
    const thumbs = r2.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
    return { id, title, artist, artworkURL: bestThumbnail(thumbs) };
  }

  // --- musicResponsiveListItemRenderer fallback ---
  const r = item?.musicResponsiveListItemRenderer;
  if (r) {
    const id = r.navigationEndpoint?.browseEndpoint?.browseId;
    if (!id) return null;
    const title    = r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text || '';
    const infoRuns = r.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
    const info     = parseInfoRuns(infoRuns);
    const thumbs   = r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
    return { id, title, artist: info.artist, artworkURL: bestThumbnail(thumbs) };
  }

  return null;
}

function parseArtistItem(item) {
  const r = item?.musicResponsiveListItemRenderer;
  if (!r) return null;
  const id   = r.navigationEndpoint?.browseEndpoint?.browseId;
  if (!id) return null;
  const name = r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text || '';
  const thumbs = r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
  return { id, name, artworkURL: bestThumbnail(thumbs) };
}

function parsePlaylistItem(item) {
  const r = item?.musicResponsiveListItemRenderer || item?.musicTwoRowItemRenderer;
  if (!r) return null;

  // browse ID for playlists starts with VL or PL
  const id =
    r.navigationEndpoint?.browseEndpoint?.browseId ||
    r.overlay?.musicItemThumbnailOverlayRenderer?.content
      ?.musicPlayButtonRenderer?.playNavigationEndpoint?.browseEndpoint?.browseId;
  if (!id) return null;

  const title  = (r.title?.runs || r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [])
    .map(t => t.text).join('').trim();
  const thumbs =
    (r.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails) ||
    (r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails) || [];
  return { id, title, artworkURL: bestThumbnail(thumbs) };
}

// ─── YTM search fetch helper ──────────────────────────────────────────────────

async function ytmSearch(query, params, env) {
  const body = { context: { client: WEB_REMIX_CONTEXT }, query };
  if (params) body.params = params;

  const resp = await fetch(`${YTM_BASE}/youtubei/v1/search?key=${YTM_API_KEY}`, {
    method: 'POST',
    headers: SEARCH_HEADERS,
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`YTM search HTTP ${resp.status}`);
  const data = await resp.json();
  tryRefreshVisitor(data, env);
  return data;
}

function getShelves(data) {
  return (
    data?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]
      ?.tabRenderer?.content?.sectionListRenderer?.contents || []
  )
    .map(s => s.musicShelfRenderer)
    .filter(Boolean);
}

// ─── Main search handler ───────────────────────────────────────────────────────
// Two parallel fetches:
//   1. Songs tab  → focused song results with reliable fixedColumn durations
//   2. Videos tab → video results  (title + channel, no album)
// Plus one more for Albums:
//   3. Albums tab → album cards

async function handleSearch(query, env) {
  if (!query) return { tracks: [], albums: [], artists: [], playlists: [] };

  // Fire all three tab fetches in parallel
  const [songsResult, videosResult, albumsResult] = await Promise.allSettled([
    ytmSearch(query, SEARCH_PARAMS.songs,  env),
    ytmSearch(query, SEARCH_PARAMS.videos, env),
    ytmSearch(query, SEARCH_PARAMS.albums, env),
  ]);

  const tracks   = [];
  const albums   = [];
  const seenIds  = new Set();

  // ── Songs ──
  if (songsResult.status === 'fulfilled') {
    const shelves = getShelves(songsResult.value);
    for (const shelf of shelves) {
      for (const item of shelf.contents || []) {
        const t = parseTrackRenderer(item.musicResponsiveListItemRenderer);
        if (t && !seenIds.has(t.id)) { seenIds.add(t.id); tracks.push(t); }
        if (tracks.length >= 20) break;
      }
    }
  }

  // ── Videos ──
  if (videosResult.status === 'fulfilled') {
    const shelves = getShelves(videosResult.value);
    for (const shelf of shelves) {
      for (const item of shelf.contents || []) {
        const t = parseTrackRenderer(item.musicResponsiveListItemRenderer);
        if (t && !seenIds.has(t.id)) { seenIds.add(t.id); tracks.push(t); }
        if (tracks.length >= 40) break;
      }
    }
  }

  // ── Albums ──
  if (albumsResult.status === 'fulfilled') {
    const shelves = getShelves(albumsResult.value);
    for (const shelf of shelves) {
      for (const item of shelf.contents || []) {
        const a = parseAlbumItem(item);
        if (a) albums.push(a);
        if (albums.length >= 10) break;
      }
    }
  }

  return { tracks, albums, artists: [], playlists: [] };
}

// ─── Stream resolution ─────────────────────────────────────────────────────────

async function fetchPlayerData(trackId, env) {
  const visitorData = await getVisitorData(env);

  const resp = await fetch(`${YTM_BASE}/youtubei/v1/player?prettyPrint=false`, {
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

  if (!resp.ok) throw new Error(`${LOG_PREFIX} Player HTTP ${resp.status}`);
  const data   = await resp.json();
  const status = data?.playabilityStatus?.status;

  if (status !== 'OK') {
    // Bust the cached visitorData so the next call retries fresh
    upstashCmd(env, 'DEL', 'ytm:visitor');
    throw new Error(
      `${LOG_PREFIX} Blocked: ${data?.playabilityStatus?.reason || status || 'unknown'}`
    );
  }

  return data.streamingData;
}

function pickBestMp4(sd) {
  const fmts = (sd.adaptiveFormats || []).filter(f => f.mimeType?.startsWith('audio/mp4') && f.url);
  if (!fmts.length) return null;
  fmts.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  return fmts[0].url;
}

async function handleStream(trackId, env) {
  const sd = await fetchPlayerData(trackId, env);
  if (!sd) throw new Error(`${LOG_PREFIX} No streaming data`);

  if (sd.hlsManifestUrl) {
    return { url: sd.hlsManifestUrl, format: 'aac', quality: 'high' };
  }

  const mp4Url = pickBestMp4(sd);
  if (mp4Url) {
    return { url: mp4Url, format: 'aac', quality: 'high' };
  }

  throw new Error(`${LOG_PREFIX} No playable audio found for ${trackId}`);
}

// ─── Album details ─────────────────────────────────────────────────────────────

async function handleAlbum(albumId, env) {
  const resp = await fetch(`${YTM_BASE}/youtubei/v1/browse?key=${YTM_API_KEY}`, {
    method: 'POST',
    headers: SEARCH_HEADERS,
    body: JSON.stringify({ context: { client: WEB_REMIX_CONTEXT }, browseId: albumId }),
  });

  if (!resp.ok) throw new Error(`${LOG_PREFIX} Album HTTP ${resp.status}`);
  const data = await resp.json();
  tryRefreshVisitor(data, env);

  const header =
    data?.header?.musicImmersiveHeaderRenderer ||
    data?.header?.musicDetailHeaderRenderer || {};
  const albumTitle = header?.title?.runs?.[0]?.text || '';

  let albumArtist = '';
  for (const run of header?.subtitle?.runs || []) {
    if (run.navigationEndpoint?.browseEndpoint) { albumArtist = run.text; break; }
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
    .map((c, i) => {
      const r = c.musicResponsiveListItemRenderer;
      const infoRuns = r.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
      const durationText =
        r.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text?.runs?.[0]?.text ||
        extractDurationFromRuns(infoRuns);
      return {
        id: r.playlistItemData.videoId,
        title: r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text || '',
        artist: albumArtist,
        album: albumTitle,
        trackNumber: i + 1,
        duration: parseDuration(durationText),
        artworkURL,
        format: 'aac',
      };
    });

  return { id: albumId, title: albumTitle, artist: albumArtist, artworkURL, trackCount: tracks.length, tracks };
}

// ─── Token helpers ─────────────────────────────────────────────────────────────

function generateToken() {
  const arr = new Uint8Array(14);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

function isValidToken(t) {
  return typeof t === 'string' && /^[a-f0-9]{28}$/.test(t);
}

function parseTokenPath(pathname) {
  const m = pathname.match(/^\/u\/([a-f0-9]{28})(\/.*)?$/);
  if (!m) return null;
  return { token: m[1], rest: m[2] || '/' };
}

function lastSegment(rest) {
  return rest.split('/').filter(Boolean).pop() || '';
}

// ─── Eclipse manifest ──────────────────────────────────────────────────────────

function buildManifest() {
  return {
    id: 'com.ricky.youtube-music',
    name: 'YouTube Music',
    version: '1.1.0',
    description: 'Stream from YouTube Music — Songs, Videos, Albums. HLS preferred with MP4 fallback.',
    icon: 'https://www.gstatic.com/youtube/media/ytm/images/applauncher/music_icon_144x144.png',
    resources: ['search', 'stream', 'catalog'],
    types: ['track', 'album'],
    contentType: 'music',
  };
}

// ─── Route handler (shared between base and token routes) ─────────────────────

async function handleRoute(rest, url, env) {
  const q = url.searchParams.get('q') || url.searchParams.get('query') || '';

  if (rest === '/manifest.json' || rest === '/manifest') {
    return jsonRes(buildManifest());
  }

  if (rest === '/search') {
    return jsonRes(await handleSearch(q, env));
  }

  if (rest.startsWith('/stream/')) {
    const id = lastSegment(rest);
    if (!id) return jsonRes({ error: 'Missing track ID' }, 400);
    return jsonRes(await handleStream(id, env));
  }

  if (rest.startsWith('/album/')) {
    const id = lastSegment(rest);
    if (!id) return jsonRes({ error: 'Missing album ID' }, 400);
    return jsonRes(await handleAlbum(id, env));
  }

  return null;
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
  return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

// ─── Landing page ──────────────────────────────────────────────────────────────

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
.pill.gr{background:#0a1a0a;color:#4eba4e;border-color:#1a3a1a}
input{width:100%;background:#0a0a0a;border:1px solid #1e1e1e;border-radius:10px;color:#e0e0e0;font-size:14px;padding:12px 14px;margin-bottom:6px;outline:none;transition:border-color .15s}
input:focus{border-color:#fff}
input::placeholder{color:#2e2e2e}
.hint{font-size:12px;color:#3a3a3a;margin-bottom:12px;line-height:1.7}
button{cursor:pointer;border:none;border-radius:10px;font-size:15px;font-weight:700;padding:13px;width:100%;margin-top:6px;margin-bottom:6px;transition:background .15s}
.bw{background:#fff;color:#000}.bw:hover{background:#e0e0e0}.bw:disabled{background:#1e1e1e;color:#333;cursor:not-allowed}
.bg{background:#141414;color:#e0e0e0;border:1px solid #2a2a2a}.bg:hover{background:#1e1e1e}.bg:disabled{background:#0f0f0f;color:#333;cursor:not-allowed}
.bd{background:#0f0f0f;color:#777;border:1px solid #1a1a1a;font-size:13px;padding:10px}.bd:hover{background:#1a1a1a;color:#fff}
.box{display:none;background:#0a0a0a;border:1px solid #1a1a1a;border-radius:12px;padding:18px;margin-bottom:10px}
.blbl{font-size:10px;color:#444;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px}
.burl{font-size:12px;color:#fff;word-break:break-all;font-family:'SF Mono','Fira Code',monospace;margin-bottom:14px;line-height:1.5}
hr{border:none;border-top:1px solid #161616;margin:24px 0}
.steps{display:flex;flex-direction:column;gap:12px}
.step{display:flex;gap:12px;align-items:flex-start}
.sn{background:#161616;border:1px solid #222;border-radius:50%;width:26px;height:26px;min-width:26px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#555}
.st{font-size:13px;color:#555;line-height:1.6}.st b{color:#999}
.warn{background:#0d0d0d;border:1px solid #1e1e1e;border-radius:10px;padding:14px;margin-top:20px;font-size:12px;color:#555;line-height:1.7}
footer{margin-top:32px;font-size:12px;color:#2a2a2a;text-align:center;line-height:1.8}
</style>
</head>
<body>
<div class="card">
  <svg width="52" height="52" viewBox="0 0 52 52" fill="none" style="margin-bottom:22px" aria-label="YouTube Music">
    <circle cx="26" cy="26" r="26" fill="#ff0000"/>
    <rect x="11" y="20" width="4" height="12" rx="2" fill="white"/>
    <rect x="18" y="14" width="4" height="24" rx="2" fill="white"/>
    <rect x="25" y="18" width="4" height="16" rx="2" fill="white"/>
    <rect x="32" y="11" width="4" height="30" rx="2" fill="white"/>
    <rect x="39" y="17" width="4" height="18" rx="2" fill="white"/>
  </svg>

  <h1>YouTube Music for Eclipse</h1>
  <p class="sub">Stream from the full YouTube Music catalog. Songs, Videos, and Albums — no account required.</p>
  <div class="tip"><b>Save your URL.</b> Paste it below any time to copy it again without reinstalling in Eclipse.</div>

  <div class="pills">
    <span class="pill">Songs &middot; Videos &middot; Albums</span>
    <span class="pill hi">HLS Playback</span>
    <span class="pill hi">MP4 Fallback</span>
    <span class="pill gr">Upstash Redis</span>
    <span class="pill bl">No Account</span>
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
  <div class="hint">Keeps the same token &mdash; nothing to reinstall in Eclipse.</div>
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
    <div class="step"><div class="sn">4</div><div class="st">Search returns <b>Songs + Videos</b> from YouTube Music automatically</div></div>
  </div>

  <div class="warn">Stream priority: <b>HLS manifest &rarr; Direct MP4 audio</b>. YouTube stream URLs expire &mdash; never cached. VisitorData cached 20 min via Upstash Redis.</div>
</div>

<footer>YouTube Music for Eclipse v1.1.0 &bull; by ricky &bull; Cloudflare Workers</footer>

<script>
var gu=null,ru=null;
function generate(){
  var btn=document.getElementById('genBtn');
  btn.disabled=true;btn.textContent='Generating...';
  fetch('/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})
    .then(function(r){return r.json();})
    .then(function(d){
      if(d.error){alert(d.error);btn.disabled=false;btn.textContent='Generate My Addon URL';return;}
      gu=d.manifestUrl;
      document.getElementById('genUrl').textContent=gu;
      document.getElementById('genBox').style.display='block';
      btn.disabled=false;btn.textContent='Generate New URL';
    })
    .catch(function(e){alert('Error: '+e.message);btn.disabled=false;btn.textContent='Generate My Addon URL';});
}
function copyGen(){if(!gu)return;copyText(gu,document.getElementById('copyGenBtn'));}
function doRefresh(){
  var eu=document.getElementById('existingUrl').value.trim();
  if(!eu){alert('Paste your existing addon URL first.');return;}
  var btn=document.getElementById('refBtn');
  btn.disabled=true;btn.textContent='Refreshing...';
  fetch('/refresh',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({existingUrl:eu})})
    .then(function(r){return r.json();})
    .then(function(d){
      if(d.error){alert(d.error);btn.disabled=false;btn.textContent='Refresh Existing URL';return;}
      ru=d.manifestUrl;
      document.getElementById('refUrl').textContent=ru;
      document.getElementById('refBox').style.display='block';
      btn.disabled=false;btn.textContent='Refresh Again';
    })
    .catch(function(e){alert('Error: '+e.message);btn.disabled=false;btn.textContent='Refresh Existing URL';});
}
function copyRef(){if(!ru)return;copyText(ru,document.getElementById('copyRefBtn'));}
function copyText(text,btn){
  var orig=btn.textContent;
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(function(){btn.textContent='Copied!';setTimeout(function(){btn.textContent=orig;},1500);});
  } else {
    var ta=document.createElement('textarea');ta.value=text;ta.style.cssText='position:fixed;opacity:0';
    document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);
    btn.textContent='Copied!';setTimeout(function(){btn.textContent=orig;},1500);
  }
}
</script>
</body>
</html>`;
}

// ─── Worker entry ──────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url      = new URL(request.url);
    const { pathname } = url;

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
      // Landing page
      if (pathname === '/') return htmlRes(buildPage());

      // Generate a fresh unique URL — every press returns a new token
      if (pathname === '/generate' && request.method === 'POST') {
        const token = generateToken();
        return jsonRes({ token, manifestUrl: `${url.origin}/u/${token}/manifest.json` });
      }

      // Refresh — extract token from an existing URL and echo it back
      if (pathname === '/refresh' && request.method === 'POST') {
        let body = {};
        try { body = await request.json(); } catch {}
        const raw = String(body.existingUrl || '').trim();
        const m   = raw.match(/\/u\/([a-f0-9]{28})/);
        if (!m) return jsonRes({ error: 'Paste your full addon URL — must contain /u/{token}/' }, 400);
        const token = m[1];
        return jsonRes({ token, manifestUrl: `${url.origin}/u/${token}/manifest.json`, refreshed: true });
      }

      // Health
      if (pathname === '/health') {
        return jsonRes({ status: 'ok', version: '1.1.0', ts: new Date().toISOString() });
      }

      // Token-scoped routes: /u/:token/{rest}
      // Eclipse strips /manifest.json → base = /u/:token
      // → calls /u/:token/search, /u/:token/stream/:id, /u/:token/album/:id
      const tp = parseTokenPath(pathname);
      if (tp) {
        if (!isValidToken(tp.token)) return jsonRes({ error: 'Invalid token.' }, 400);
        const result = await handleRoute(tp.rest, url, env);
        if (result) return result;
        return jsonRes({ error: 'Not found' }, 404);
      }

      // Tokenless base routes (also works for direct testing)
      const baseResult = await handleRoute(pathname, url, env);
      if (baseResult) return baseResult;

      return jsonRes({ error: 'Not found' }, 404);

    } catch (err) {
      console.error(LOG_PREFIX, err);
      return jsonRes({ error: err.message || 'Internal error' }, 500);
    }
  },
};
