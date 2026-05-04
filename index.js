// ─── YouTube Music — Eclipse Addon (Cloudflare Workers) ─────────────────────
// author: ricky | version: 1.5.1
const LOG_PREFIX  = '[YTMusic]';
const YTM_BASE    = 'https://music.youtube.com';
const YT_BASE     = 'https://www.youtube.com';   // non-iOS player calls — avoids music.youtube.com bot wall
const YTM_API_KEY = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30';
const VISITOR_TTL_SEC = 1200;

const WEB_REMIX_CONTEXT = {
  clientName: 'WEB_REMIX', clientVersion: '1.20260304.03.00', hl: 'en', gl: 'US',
};
// Client 1: iOS — returns HLS manifest, best for Eclipse
const IOS_CLIENT_BASE = {
  clientName: 'IOS', clientVersion: '20.10.01',
  deviceMake: 'Apple', deviceModel: 'iPhone16,2',
  osName: 'iPhone', osVersion: '18.3.2.22D82', hl: 'en',
};
// Client 2: ANDROID_TESTSUITE — bypasses bot/sign-in checks, Google internal test client
// This client is never blocked by the "Sign in to confirm" wall
const ANDROID_TESTSUITE_CLIENT = {
  clientName: 'ANDROID_TESTSUITE', clientVersion: '1.9',
  androidSdkVersion: 34,
  osName: 'Android', osVersion: '14', hl: 'en',
};
// Client 3: ANDROID_MUSIC — standard Android YT Music app
const ANDROID_MUSIC_CLIENT = {
  clientName: 'ANDROID_MUSIC', clientVersion: '7.27.52',
  androidSdkVersion: 34,
  osName: 'Android', osVersion: '14', hl: 'en',
};
// Client 4: WEB_EMBEDDED_PLAYER — works for age-restricted content
const WEB_EMBEDDED_CLIENT = {
  clientName: 'WEB_EMBEDDED_PLAYER', clientVersion: '2.20260304.00.00',
  hl: 'en', gl: 'US',
};
// Client 5: MWEB — mobile web, last resort
const MWEB_CLIENT = {
  clientName: 'MWEB', clientVersion: '2.20260304.03.00',
  hl: 'en', gl: 'US',
};

const SEARCH_PARAMS = {
  songs:     'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D',
  videos:    'EgWKAQIQAWoKEAkQChAFEAMQBA%3D%3D',
  albums:    'EgWKAQIYAWoKEAkQChAFEAMQBA%3D%3D',
  artists:   'EgWKAQIgAWoKEAkQChAFEAMQBA%3D%3D',
  playlists: 'EgWKAQIoAWoKEAkQChAFEAMQBA%3D%3D',
};
const SEARCH_HEADERS = {
  'Content-Type': 'application/json',
  'Origin':  YTM_BASE, 'Referer': `${YTM_BASE}/`,
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

async function upstashCmd(env, ...args) {
  const url = env?.UPSTASH_REDIS_REST_URL, token = env?.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    return (await res.json()).result ?? null;
  } catch { return null; }
}

async function getVisitorData(env, userToken) {
  const key = `ytm:visitor:${userToken}`;
  const cached = await upstashCmd(env, 'GET', key);
  if (cached && typeof cached === 'string' && cached.length > 4) return cached;
  return fetchFreshVisitorData(env, userToken);
}
async function fetchFreshVisitorData(env, userToken) {
  const key = `ytm:visitor:${userToken}`;
  try {
    const resp = await fetch(`${YTM_BASE}/youtubei/v1/visitor_id?key=${YTM_API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: { client: WEB_REMIX_CONTEXT } }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const vd = (await resp.json())?.responseContext?.visitorData || null;
    if (vd) upstashCmd(env, 'SET', key, vd, 'EX', VISITOR_TTL_SEC);
    return vd;
  } catch (e) { console.log(LOG_PREFIX, 'visitorData failed:', e.message); return null; }
}
function tryRefreshVisitor(data, env, userToken) {
  const vd = data?.responseContext?.visitorData;
  const key = `ytm:visitor:${userToken}`;
  if (vd) upstashCmd(env, 'SET', key, vd, 'EX', VISITOR_TTL_SEC);
}

function parseDuration(text) {
  if (!text) return 0;
  const parts = String(text).trim().split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}
function isDuration(text) {
  return /^\d{1,2}:\d{2}(:\d{2})?$/.test((text || '').trim());
}
function isBullet(text) {
  return /^\s*[•·]\s*$/.test(text || '');
}
function bestThumbnail(thumbs) {
  if (!thumbs?.length) return '';
  return thumbs.reduce((b, t) => ((t.width || 0) > (b.width || 0) ? t : b)).url;
}
function runsText(runs) {
  return (runs || []).map(r => r.text || '').join('').trim();
}

function parseInfoRuns(runs) {
  if (!runs?.length) return { artist: '', album: '', duration: '' };
  const parts = [];
  let cur = '';
  for (const run of runs) {
    if (isBullet(run.text)) { if (cur.trim()) parts.push(cur.trim()); cur = ''; }
    else cur += (run.text || '');
  }
  if (cur.trim()) parts.push(cur.trim());

  let duration = '';
  if (parts.length && isDuration(parts[parts.length - 1])) {
    duration = parts.pop();
  }

  const typeLabels = new Set(['Song','Video','EP','Single','Podcast','Album','Playlist','Compilation']);
  let idx = 0;
  if (parts.length > 1 && typeLabels.has(parts[0])) idx = 1;
  return { artist: parts[idx] || '', album: parts[idx + 1] || '', duration };
}

function buildIosContext(visitorData) {
  const ctx = { ...IOS_CLIENT_BASE };
  if (visitorData) ctx.visitorData = visitorData;
  return ctx;
}
function buildAndroidTestsuiteContext(visitorData) {
  const ctx = { ...ANDROID_TESTSUITE_CLIENT };
  if (visitorData) ctx.visitorData = visitorData;
  return ctx;
}
function buildAndroidContext(visitorData) {
  const ctx = { ...ANDROID_MUSIC_CLIENT };
  if (visitorData) ctx.visitorData = visitorData;
  return ctx;
}
function buildWebEmbeddedContext(visitorData) {
  const ctx = { ...WEB_EMBEDDED_CLIENT };
  if (visitorData) ctx.visitorData = visitorData;
  return ctx;
}
function buildMwebContext(visitorData) {
  const ctx = { ...MWEB_CLIENT };
  if (visitorData) ctx.visitorData = visitorData;
  return ctx;
}

async function ytmPost(path, body, env, userToken) {
  const resp = await fetch(`${YTM_BASE}${path}`, {
    method: 'POST', headers: SEARCH_HEADERS, body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`${LOG_PREFIX} HTTP ${resp.status} on ${path}`);
  const data = await resp.json();
  tryRefreshVisitor(data, env, userToken);
  return data;
}
async function ytmBrowse(browseId, env, userToken) {
  return ytmPost(`/youtubei/v1/browse?key=${YTM_API_KEY}`,
    { context: { client: WEB_REMIX_CONTEXT }, browseId }, env, userToken);
}
async function ytmSearch(query, params, env, userToken) {
  const body = { context: { client: WEB_REMIX_CONTEXT }, query };
  if (params) body.params = params;
  return ytmPost(`/youtubei/v1/search?key=${YTM_API_KEY}`, body, env, userToken);
}

function getVideoId(r) {
  if (!r) return null;
  return (
    r.playlistItemData?.videoId ||
    r.overlay?.musicItemThumbnailOverlayRenderer?.content
      ?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId ||
    (r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [])
      .find(run => run.navigationEndpoint?.watchEndpoint?.videoId)
      ?.navigationEndpoint?.watchEndpoint?.videoId ||
    null
  );
}

function parseTrackRenderer(r, fallbackArtist, fallbackAlbum, fallbackArtwork) {
  if (!r) return null;
  const videoId = getVideoId(r);
  if (!videoId) return null;

  const title = runsText(r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs);
  const infoRuns = r.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
  const info = parseInfoRuns(infoRuns);

  const fixedRaw = r.fixedColumns?.[0]
    ?.musicResponsiveListItemFixedColumnRenderer?.text?.runs?.[0]?.text || '';
  const durationStr =
    (isDuration(fixedRaw) ? fixedRaw : '') ||
    info.duration ||
    (r.lengthMs
      ? `${Math.floor(r.lengthMs / 60000)}:${String(Math.floor((r.lengthMs % 60000) / 1000)).padStart(2, '0')}`
      : '');

  const thumbs = r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
  return {
    id:         videoId,
    title:      title || 'Unknown',
    artist:     info.artist     || fallbackArtist || '',
    album:      info.album      || fallbackAlbum  || '',
    duration:   parseDuration(durationStr),
    artworkURL: bestThumbnail(thumbs) || fallbackArtwork || '',
    format:     'aac',
  };
}

function parseAlbumItem(item) {
  const r2 = item?.musicTwoRowItemRenderer;
  if (r2) {
    const id =
      r2.navigationEndpoint?.browseEndpoint?.browseId ||
      r2.overlay?.musicItemThumbnailOverlayRenderer?.content
        ?.musicPlayButtonRenderer?.playNavigationEndpoint?.browseEndpoint?.browseId;
    if (!id) return null;
    const title  = r2.title?.runs?.[0]?.text || '';
    const skip   = new Set(['Album','EP','Single','Compilation','Podcast']);
    const artist = (r2.subtitle?.runs || [])
      .filter(r => !isBullet(r.text) && !/^\d{4}$/.test(r.text.trim()) && !skip.has(r.text.trim()))
      .map(r => r.text.trim()).filter(Boolean).join(' ').trim();
    return { id, title, artist,
      artworkURL: bestThumbnail(r2.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails || []) };
  }
  const r = item?.musicResponsiveListItemRenderer;
  if (r) {
    const id =
      r.navigationEndpoint?.browseEndpoint?.browseId ||
      r.overlay?.musicItemThumbnailOverlayRenderer?.content
        ?.musicPlayButtonRenderer?.playNavigationEndpoint?.browseEndpoint?.browseId ||
      (r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [])
        .map(run => run.navigationEndpoint?.browseEndpoint?.browseId).find(Boolean);
    if (!id) return null;
    const title = runsText(r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs);
    const info  = parseInfoRuns(r.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || []);
    return { id, title, artist: info.artist,
      artworkURL: bestThumbnail(r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || []) };
  }
  return null;
}
function parseArtistItem(item) {
  const r = item?.musicResponsiveListItemRenderer;
  if (!r) return null;
  const id = r.navigationEndpoint?.browseEndpoint?.browseId;
  const name = runsText(r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs);
  if (!id || !name) return null;
  return { id, name, artworkURL: bestThumbnail(r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || []) };
}
function parsePlaylistItem(item) {
  const r2 = item?.musicTwoRowItemRenderer;
  if (r2) {
    const id =
      r2.navigationEndpoint?.browseEndpoint?.browseId ||
      r2.overlay?.musicItemThumbnailOverlayRenderer?.content
        ?.musicPlayButtonRenderer?.playNavigationEndpoint?.browseEndpoint?.browseId;
    if (!id) return null;
    const title   = r2.title?.runs?.[0]?.text || '';
    const creator = (r2.subtitle?.runs || []).filter(r => !isBullet(r.text))
      .map(r => r.text.trim()).filter(Boolean)[0] || '';
    return { id, title, creator,
      artworkURL: bestThumbnail(r2.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails || []) };
  }
  const r = item?.musicResponsiveListItemRenderer;
  if (r) {
    const id = r.navigationEndpoint?.browseEndpoint?.browseId;
    if (!id) return null;
    return { id,
      title: runsText(r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs),
      artworkURL: bestThumbnail(r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || []) };
  }
  return null;
}

function getShelves(data) {
  return (
    data?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]
      ?.tabRenderer?.content?.sectionListRenderer?.contents || []
  ).map(s => s.musicShelfRenderer).filter(Boolean);
}

async function handleSearch(query, env, userToken) {
  if (!query) return { tracks: [], albums: [], artists: [], playlists: [] };
  const [songsR, videosR, albumsR, artistsR, plR] = await Promise.allSettled([
    ytmSearch(query, SEARCH_PARAMS.songs,     env, userToken),
    ytmSearch(query, SEARCH_PARAMS.videos,    env, userToken),
    ytmSearch(query, SEARCH_PARAMS.albums,    env, userToken),
    ytmSearch(query, SEARCH_PARAMS.artists,   env, userToken),
    ytmSearch(query, SEARCH_PARAMS.playlists, env, userToken),
  ]);
  const tracks = [], albums = [], artists = [], playlists = [], seenIds = new Set();
  const addTrack = t => { if (t && !seenIds.has(t.id)) { seenIds.add(t.id); tracks.push(t); } };
  if (songsR.status  === 'fulfilled') for (const s of getShelves(songsR.value))
    for (const it of s.contents || []) { addTrack(parseTrackRenderer(it.musicResponsiveListItemRenderer)); if (tracks.length >= 20) break; }
  if (videosR.status === 'fulfilled') for (const s of getShelves(videosR.value))
    for (const it of s.contents || []) { addTrack(parseTrackRenderer(it.musicResponsiveListItemRenderer)); if (tracks.length >= 40) break; }
  if (albumsR.status === 'fulfilled') for (const s of getShelves(albumsR.value))
    for (const it of s.contents || []) { const a = parseAlbumItem(it); if (a && albums.length < 10) albums.push(a); }
  if (artistsR.status=== 'fulfilled') for (const s of getShelves(artistsR.value))
    for (const it of s.contents || []) { const a = parseArtistItem(it); if (a && artists.length < 8) artists.push(a); }
  if (plR.status     === 'fulfilled') for (const s of getShelves(plR.value))
    for (const it of s.contents || []) { const p = parsePlaylistItem(it); if (p && playlists.length < 8) playlists.push(p); }
  return { tracks, albums, artists, playlists };
}

// ─── Multi-client player fetch ────────────────────────────────────────────────
// Chain: iOS (music.youtube.com) → ANDROID_TESTSUITE (www.youtube.com) → ANDROID_MUSIC → WEB_EMBEDDED → MWEB
// KEY FIX v1.5.1: music.youtube.com enforces bot/sign-in checks on Android & Web clients
// but www.youtube.com does NOT. iOS is exempt on music.youtube.com so it stays as-is.
// Switching non-iOS clients to YT_BASE (www.youtube.com) fixes Android/Windows playback.
async function fetchPlayerData(trackId, env, userToken) {
  const visitorData = await getVisitorData(env, userToken);

  const clients = [
    {
      label: 'IOS',
      base: YTM_BASE,  // iOS works fine on music.youtube.com
      ctx: buildIosContext(visitorData),
      ua: 'com.google.ios.youtube/20.10.01 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X)',
    },
    {
      label: 'ANDROID_TESTSUITE',
      base: YT_BASE,   // www.youtube.com — bypasses music.youtube.com bot check on Android/Web
      ctx: buildAndroidTestsuiteContext(visitorData),
      ua: 'com.google.android.youtube/17.31.35 (Linux; U; Android 14) gzip',
    },
    {
      label: 'ANDROID_MUSIC',
      base: YT_BASE,
      ctx: buildAndroidContext(visitorData),
      ua: 'com.google.android.apps.youtube.music/7.27.52 (Linux; U; Android 14) gzip',
    },
    {
      label: 'WEB_EMBEDDED',
      base: YT_BASE,
      ctx: buildWebEmbeddedContext(visitorData),
      ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
    {
      label: 'MWEB',
      base: YT_BASE,
      ctx: buildMwebContext(visitorData),
      ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
    },
  ];

  let lastErr;
  for (const { label, base, ctx, ua } of clients) {
    try {
      const resp = await fetch(`${base}/youtubei/v1/player?prettyPrint=false`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': ua },
        body: JSON.stringify({
          context: { client: ctx },
          videoId: trackId, contentCheckOk: true, racyCheckOk: true,
        }),
      });
      if (!resp.ok) {
        lastErr = new Error(`${LOG_PREFIX} [${label}] Player HTTP ${resp.status}`);
        console.log(LOG_PREFIX, `[${label}] HTTP ${resp.status}, trying next client`);
        continue;
      }
      const data = await resp.json();
      tryRefreshVisitor(data, env, userToken);
      if (data?.playabilityStatus?.status === 'OK') {
        console.log(LOG_PREFIX, `[${label}] player OK for ${trackId}`);
        return data;
      }
      lastErr = new Error(`${LOG_PREFIX} [${label}] Blocked: ${data?.playabilityStatus?.reason || 'unknown'}`);
      console.log(LOG_PREFIX, `[${label}] blocked — ${data?.playabilityStatus?.reason}, trying next client`);
    } catch (e) {
      lastErr = e;
      console.log(LOG_PREFIX, `[${label}] exception: ${e.message}`);
    }
  }

  // All clients failed — nuke cached visitorData so next request gets a fresh one
  const key = `ytm:visitor:${userToken}`;
  upstashCmd(env, 'DEL', key);
  throw new Error(lastErr?.message || `${LOG_PREFIX} All clients failed for ${trackId}`);
}

async function handleStream(trackId, env, userToken) {
  const data = await fetchPlayerData(trackId, env, userToken);
  const sd = data.streamingData;
  if (!sd) throw new Error(`${LOG_PREFIX} No streaming data`);

  // HLS first (iOS client returns this) — most reliable for Eclipse playback
  if (sd.hlsManifestUrl) {
    return {
      url: sd.hlsManifestUrl,
      format: 'hls',
      quality: 'high',
      expiresAt: Math.floor(Date.now() / 1000) + 21600,
    };
  }

  // AAC adaptive fallback (Android / WEB_EMBEDDED / MWEB clients return this)
  const fmts = (sd.adaptiveFormats || [])
    .filter(f => f.mimeType?.startsWith('audio/mp4') && f.url)
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

  if (fmts.length) {
    return {
      url: fmts[0].url,
      format: 'aac',
      quality: 'high',
      expiresAt: Math.floor(Date.now() / 1000) + 21600,
    };
  }

  // Last resort: opus/webm
  const opusFmts = (sd.adaptiveFormats || [])
    .filter(f => f.mimeType?.startsWith('audio/webm') && f.url)
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

  if (opusFmts.length) {
    return {
      url: opusFmts[0].url,
      format: 'opus',
      quality: 'high',
      expiresAt: Math.floor(Date.now() / 1000) + 21600,
    };
  }

  throw new Error(`${LOG_PREFIX} No playable audio for ${trackId}`);
}

async function handleDownload(trackId, env, userToken) {
  const data = await fetchPlayerData(trackId, env, userToken);
  const sd = data.streamingData;
  if (!sd) throw new Error(`${LOG_PREFIX} No streaming data`);

  const fmts = (sd.adaptiveFormats || [])
    .filter(f => f.mimeType?.startsWith('audio/mp4') && f.url)
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

  if (!fmts.length) throw new Error(`${LOG_PREFIX} No downloadable audio format for ${trackId}`);

  return new Response(null, {
    status: 302,
    headers: {
      'Location': fmts[0].url,
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    },
  });
}

function extractSecondaryTracks(data, fallbackArtist, fallbackAlbum, fallbackArtwork) {
  const twoCol = data?.contents?.twoColumnBrowseResultsRenderer;
  if (!twoCol) return [];
  const sections = twoCol?.secondaryContents?.sectionListRenderer?.contents || [];
  const tracks = [];
  for (const s of sections) {
    const shelf = s.musicShelfRenderer || s.musicPlaylistShelfRenderer;
    if (!shelf) continue;
    for (const item of shelf.contents || []) {
      const t = parseTrackRenderer(item.musicResponsiveListItemRenderer, fallbackArtist, fallbackAlbum, fallbackArtwork);
      if (t) tracks.push(t);
    }
  }
  return tracks;
}

function extractResponsiveHeader(data) {
  const twoCol = data?.contents?.twoColumnBrowseResultsRenderer;
  const tabSection = twoCol?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents?.[0];
  const rhr = tabSection?.musicResponsiveHeaderRenderer;
  if (rhr) return rhr;
  return data?.header?.musicImmersiveHeaderRenderer
    || data?.header?.musicDetailHeaderRenderer
    || null;
}

async function handleAlbum(albumId, env, userToken) {
  const data = await ytmBrowse(albumId, env, userToken);
  const hdr  = extractResponsiveHeader(data) || {};

  const albumTitle = runsText(hdr.title?.runs);
  let albumArtist  = '';
  for (const run of hdr.subtitle?.runs || []) {
    if (run.navigationEndpoint?.browseEndpoint) { albumArtist = run.text; break; }
  }
  if (!albumArtist) albumArtist = runsText(hdr.straplineTextOne?.runs);
  if (!albumArtist) {
    const skip = new Set(['Album','EP','Single','Compilation']);
    for (const run of hdr.subtitle?.runs || []) {
      const t = run.text?.trim();
      if (t && !isBullet(t) && !skip.has(t) && !/^\d{4}$/.test(t)) { albumArtist = t; break; }
    }
  }

  const artworkURL = bestThumbnail(
    hdr.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails ||
    hdr.thumbnail?.croppedSquareThumbnailRenderer?.thumbnail?.thumbnails || []
  );

  const tracks = extractSecondaryTracks(data, albumArtist, albumTitle, artworkURL);
  tracks.forEach((t, i) => { t.album = albumTitle; t.trackNumber = i + 1; if (!t.artworkURL) t.artworkURL = artworkURL; });

  return { id: albumId, title: albumTitle, artist: albumArtist, artworkURL, trackCount: tracks.length, tracks };
}

async function handleArtist(artistId, env, userToken) {
  const data = await ytmBrowse(artistId, env, userToken);
  const hdr  = data?.header?.musicImmersiveHeaderRenderer || data?.header?.musicVisualHeaderRenderer || {};
  const name = runsText(hdr.title?.runs) || 'Unknown Artist';
  const artworkURL = bestThumbnail(
    hdr.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails ||
    hdr.foregroundThumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails ||
    hdr.thumbnail?.croppedSquareThumbnailRenderer?.thumbnail?.thumbnails || []
  );

  const sections = data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]
    ?.tabRenderer?.content?.sectionListRenderer?.contents || [];

  const topTracks = [], albums = [];
  for (const section of sections) {
    const shelf    = section.musicShelfRenderer;
    const carousel = section.musicCarouselShelfRenderer;
    if (shelf)    for (const it of shelf.contents || []) {
      const t = parseTrackRenderer(it.musicResponsiveListItemRenderer, name, '', '');
      if (t && topTracks.length < 10) topTracks.push(t);
    }
    if (carousel) for (const it of carousel.contents || []) {
      const a = parseAlbumItem(it);
      if (a && albums.length < 30) albums.push({ ...a, artist: a.artist || name });
    }
  }

  if (topTracks.some(t => t.duration === 0)) {
    try {
      const sr   = await ytmSearch(name, SEARCH_PARAMS.songs, env, userToken);
      const dMap = new Map();
      for (const shelf of getShelves(sr)) {
        for (const it of shelf.contents || []) {
          const r = it.musicResponsiveListItemRenderer;
          if (!r) continue;
          const vid  = getVideoId(r);
          if (!vid) continue;
          const info = parseInfoRuns(r.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || []);
          const fixRaw = r.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text?.runs?.[0]?.text || '';
          const dur  = (isDuration(fixRaw) ? fixRaw : '') || info.duration;
          if (vid && dur) dMap.set(vid, parseDuration(dur));
        }
      }
      for (const t of topTracks) {
        if (t.duration === 0 && dMap.has(t.id)) t.duration = dMap.get(t.id);
      }
    } catch (e) { console.log(LOG_PREFIX, 'artist duration enrich failed:', e.message); }
  }

  return { id: artistId, name, artworkURL, bio: null, topTracks, albums };
}

async function handlePlaylist(playlistId, env, userToken) {
  const browseId = playlistId.startsWith('VL') ? playlistId : 'VL' + playlistId;
  const data = await ytmBrowse(browseId, env, userToken);

  const hdr = extractResponsiveHeader(data) || {};
  const title    = runsText(hdr.title?.runs) || 'Playlist';
  const creator  = (hdr.subtitle?.runs || [])
    .filter(r => !isBullet(r.text) && r.text !== 'Playlist')
    .map(r => r.text.trim()).filter(Boolean).join('').trim();
  const artworkURL = bestThumbnail(
    hdr.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails ||
    hdr.thumbnail?.croppedSquareThumbnailRenderer?.thumbnail?.thumbnails || []
  );

  const tracks = extractSecondaryTracks(data);

  return { id: playlistId, title, creator, artworkURL, trackCount: tracks.length, tracks };
}

function generateToken() {
  const arr = new Uint8Array(14);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}
function isValidToken(t) { return typeof t === 'string' && /^[a-f0-9]{28}$/.test(t); }
function parseTokenPath(p) {
  const m = p.match(new RegExp("^/u/([a-f0-9]{28})(/.*)?$"));
  return m ? { token: m[1], rest: m[2] || '/' } : null;
}
function lastSegment(rest) { return rest.split('/').filter(Boolean).pop() || ''; }

function buildManifest() {
  return {
    id:          'com.ricky.youtube-music',
    name:        'YouTube Music',
    version:     '1.5.1',
    description: 'Stream from YouTube Music — Songs, Videos, Albums, Artists, Playlists. Multi-client (iOS/Android/WEB) with HLS + AAC + Opus fallback. Offline download support.',
    icon:        'https://www.gstatic.com/youtube/media/ytm/images/applauncher/music_icon_144x144.png',
    resources:   ['search', 'stream', 'catalog', 'download'],
    types:       ['track', 'album', 'artist', 'playlist'],
    contentType: 'music',
    downloadUrl: '/download/{id}',
  };
}

async function handleRoute(rest, url, env, userToken) {
  const q = url.searchParams.get('q') || url.searchParams.get('query') || '';
  if (rest === '/manifest.json' || rest === '/manifest') return jsonRes(buildManifest());
  if (rest === '/search')            return jsonRes(await handleSearch(q, env, userToken));
  if (rest.startsWith('/download/')) { const id = lastSegment(rest); if (!id) return jsonRes({error:'Missing ID'},400); return await handleDownload(id, env, userToken); }
  if (rest.startsWith('/stream/'))   { const id = lastSegment(rest); if (!id) return jsonRes({error:'Missing ID'},400); return jsonRes(await handleStream(id, env, userToken)); }
  if (rest.startsWith('/album/'))    { const id = lastSegment(rest); if (!id) return jsonRes({error:'Missing ID'},400); return jsonRes(await handleAlbum(id, env, userToken)); }
  if (rest.startsWith('/artist/'))   { const id = lastSegment(rest); if (!id) return jsonRes({error:'Missing ID'},400); return jsonRes(await handleArtist(id, env, userToken)); }
  if (rest.startsWith('/playlist/')) { const id = lastSegment(rest); if (!id) return jsonRes({error:'Missing ID'},400); return jsonRes(await handlePlaylist(id, env, userToken)); }
  return null;
}

function jsonRes(data, status) {
  return new Response(JSON.stringify(data, null, 2), {
    status: status || 200,
    headers: {
      'content-type':                'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-methods':'GET, POST, OPTIONS',
      'access-control-allow-headers':'Content-Type',
      'cache-control':               'no-store',
    },
  });
}
function htmlRes(b) { return new Response(b, { headers: { 'content-type': 'text/html; charset=utf-8' } }); }

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
  <p class="sub">Full YouTube Music catalog &mdash; Songs, Videos, Albums, Artists &amp; Playlists. No account required.</p>
  <div class="tip"><b>Save your URL.</b> Paste it below any time to copy it again without reinstalling.</div>
  <div class="pills">
    <span class="pill">Songs &middot; Videos</span>
    <span class="pill">Albums &middot; Artists &middot; Playlists</span>
    <span class="pill hi">HLS Primary</span>
    <span class="pill gr">AAC Fallback</span>
    <span class="pill gr">Opus Fallback</span>
    <span class="pill gr">Offline Downloads</span>
    <span class="pill gr">Upstash Redis</span>
    <span class="pill bl">5-Client Bot Bypass</span>
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
    <div class="step"><div class="sn">4</div><div class="st">Search returns Songs, Videos, Albums, Artists &amp; Playlists with full browse and offline download support</div></div>
  </div>
  <div class="warn">Endpoints: <code>search</code> &bull; <code>stream/:id</code> &bull; <code>download/:id</code> &bull; <code>album/:id</code> &bull; <code>artist/:id</code> &bull; <code>playlist/:id</code><br>Player chain: iOS &rarr; ANDROID_TESTSUITE &rarr; ANDROID_MUSIC &rarr; WEB_EMBEDDED &rarr; MWEB. HLS &rarr; AAC &rarr; Opus. Download: 302 redirect to YouTube CDN. visitorData: 20 min per-user via Upstash Redis.</div>
</div>
<footer>YouTube Music for Eclipse v1.5.1 &bull; by ricky &bull; Cloudflare Workers</footer>
<script>
var gu=null,ru=null;
function generate(){
  var btn=document.getElementById('genBtn');btn.disabled=true;btn.textContent='Generating...';
  fetch('/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})
    .then(function(r){return r.json()}).then(function(d){
      if(d.error){alert(d.error);btn.disabled=false;btn.textContent='Generate My Addon URL';return;}
      gu=d.manifestUrl;document.getElementById('genUrl').textContent=gu;
      document.getElementById('genBox').style.display='block';
      btn.disabled=false;btn.textContent='Generate New URL';
    }).catch(function(e){alert('Error: '+e.message);btn.disabled=false;btn.textContent='Generate My Addon URL'});
}
function copyGen(){if(gu)copyText(gu,document.getElementById('copyGenBtn'));}
function doRefresh(){
  var eu=document.getElementById('existingUrl').value.trim();
  if(!eu){alert('Paste your existing addon URL first.');return;}
  var btn=document.getElementById('refBtn');btn.disabled=true;btn.textContent='Refreshing...';
  fetch('/refresh',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({existingUrl:eu})})
    .then(function(r){return r.json()}).then(function(d){
      if(d.error){alert(d.error);btn.disabled=false;btn.textContent='Refresh Existing URL';return;}
      ru=d.manifestUrl;document.getElementById('refUrl').textContent=ru;
      document.getElementById('refBox').style.display='block';
      btn.disabled=false;btn.textContent='Refresh Again';
    }).catch(function(e){alert('Error: '+e.message);btn.disabled=false;btn.textContent='Refresh Existing URL'});
}
function copyRef(){if(ru)copyText(ru,document.getElementById('copyRefBtn'));}
function copyText(text,btn){
  var o=btn.textContent;
  if(navigator.clipboard){navigator.clipboard.writeText(text).then(function(){btn.textContent='Copied!';setTimeout(function(){btn.textContent=o},1500)});}
  else{var ta=document.createElement('textarea');ta.value=text;ta.style.cssText='position:fixed;opacity:0';document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);btn.textContent='Copied!';setTimeout(function(){btn.textContent=o},1500);}
}
</script>
</body>
</html>`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url), pathname = url.pathname;
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'access-control-allow-origin':'*','access-control-allow-methods':'GET, POST, OPTIONS','access-control-allow-headers':'Content-Type' } });
    try {
      if (pathname === '/')                                                  return htmlRes(buildPage());
      if (pathname === '/generate' && request.method === 'POST') {
        const token = generateToken();
        return jsonRes({ token, manifestUrl: `${url.origin}/u/${token}/manifest.json` });
      }
      if (pathname === '/refresh'  && request.method === 'POST') {
        let body; try { body = await request.json(); } catch {}
        const m = String(body?.existingUrl||'').match(/[a-f0-9]{28}/);
        if (!m) return jsonRes({ error: 'Paste your full addon URL — must contain a valid token' }, 400);
        return jsonRes({ token: m[0], manifestUrl: `${url.origin}/u/${m[0]}/manifest.json`, refreshed: true });
      }
      if (pathname === '/health') return jsonRes({ status:'ok', version:'1.5.1', ts: new Date().toISOString() });

      const tp = parseTokenPath(pathname);
      if (tp) {
        if (!isValidToken(tp.token)) return jsonRes({ error: 'Invalid token.' }, 400);
        const r = await handleRoute(tp.rest, url, env, tp.token);
        return r || jsonRes({ error: 'Not found', path: tp.rest }, 404);
      }

      // Anonymous path — per-request key from cf-ray to avoid shared visitorData bot flagging
      const anonKey = `anon_${request.headers.get('cf-ray')?.slice(0, 8) || Math.random().toString(36).slice(2)}`;
      const base = await handleRoute(pathname, url, env, anonKey);
      return base || jsonRes({ error: 'Not found' }, 404);
    } catch (err) {
      console.error(LOG_PREFIX, err);
      return jsonRes({ error: err.message || 'Internal error' }, 500);
    }
  },
};
