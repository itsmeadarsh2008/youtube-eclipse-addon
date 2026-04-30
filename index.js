// ─── YouTube Music — Eclipse Addon (Cloudflare Workers) ─────────────────────
// author: ricky | version: 1.5.2

const LOG_PREFIX = '[YTMusic]';
const YTM_BASE   = 'https://music.youtube.com';
const YTM_API_KEY = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30';
const VISITOR_TTL_SEC = 1200;

const WEB_REMIX_CONTEXT = {
  clientName: 'WEB_REMIX', clientVersion: '1.20260304.03.00', hl: 'en', gl: 'US',
};
const IOS_CLIENT_BASE = {
  clientName: 'IOS', clientVersion: '20.10.01',
  deviceMake: 'Apple', deviceModel: 'iPhone16,2',
  osName: 'iPhone', osVersion: '18.3.2.22D82', hl: 'en',
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
  'Origin': YTM_BASE, 'Referer': `${YTM_BASE}/`,
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

// ─── Upstash Redis ────────────────────────────────────────────────────────────
async function upstashCmd(env, ...args) {
  const url = env?.UPSTASH_REDIS_REST_URL, token = env?.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const res  = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
    const json = await res.json();
    return json.result ?? null;
  } catch { return null; }
}
async function getVisitorData(env) {
  const cached = await upstashCmd(env, 'GET', 'ytm:visitor');
  if (cached && typeof cached === 'string' && cached.length > 4) return cached;
  return fetchFreshVisitorData(env);
}
async function fetchFreshVisitorData(env) {
  try {
    const resp = await fetch(`${YTM_BASE}/youtubei/v1/visitor_id?key=${YTM_API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: { client: WEB_REMIX_CONTEXT } }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const d = await resp.json();
    const vd = d?.responseContext?.visitorData || null;
    if (vd) upstashCmd(env, 'SET', 'ytm:visitor', vd, 'EX', VISITOR_TTL_SEC);
    return vd;
  } catch (e) { console.log(LOG_PREFIX, 'visitorData failed:', e.message); return null; }
}
function tryRefreshVisitor(data, env) {
  const vd = data?.responseContext?.visitorData;
  if (vd) upstashCmd(env, 'SET', 'ytm:visitor', vd, 'EX', VISITOR_TTL_SEC);
}

// ─── Deep-search helpers ──────────────────────────────────────────────────────
// Handles any YTM response shape change — albums/playlists switched to
// twoColumnBrowseResultsRenderer mid-2024 and may change again.
function findDeep(obj, key, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 12) return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  for (const v of Object.values(obj)) {
    const r = findDeep(v, key, depth + 1);
    if (r !== undefined) return r;
  }
  return undefined;
}
function findAllDeep(obj, key, depth = 0, out = []) {
  if (!obj || typeof obj !== 'object' || depth > 12) return out;
  if (Object.prototype.hasOwnProperty.call(obj, key)) out.push(obj[key]);
  for (const v of Object.values(obj)) findAllDeep(v, key, depth + 1, out);
  return out;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function parseDuration(text) {
  if (!text) return 0;
  const parts = String(text).trim().split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}
// Only accept strings that look like MM:SS or H:MM:SS — rejects play counts like "1.4B"
function isDurationText(text) {
  return /^\d{1,2}:\d{2}(:\d{2})?$/.test((text || '').trim());
}
function extractDurationFromRuns(runs) {
  if (!Array.isArray(runs)) return '';
  for (let i = runs.length - 1; i >= 0; i--) {
    const t = (runs[i]?.text || '').trim();
    if (isDurationText(t)) return t;
  }
  return '';
}
function bestThumbnail(thumbnails) {
  if (!thumbnails?.length) return '';
  return thumbnails.reduce((b, t) => ((t.width || 0) > (b.width || 0) ? t : b)).url;
}
function isBullet(text) { return /^\s*[•·]\s*$/.test(text || ''); }
function parseInfoRuns(runs) {
  if (!runs?.length) return { artist: '', album: '' };
  const parts = []; let cur = '';
  for (const run of runs) {
    if (isBullet(run.text)) { if (cur.trim()) parts.push(cur.trim()); cur = ''; }
    else cur += (run.text || '');
  }
  if (cur.trim()) parts.push(cur.trim());
  while (parts.length > 1 && isDurationText(parts[parts.length - 1])) parts.pop();
  const typeLabels = new Set(['Song','Video','EP','Single','Podcast','Album','Playlist','Compilation']);
  let idx = 0;
  if (parts.length > 1 && typeLabels.has(parts[0])) idx = 1;
  return { artist: parts[idx] || '', album: parts[idx + 1] || '' };
}
function buildIosContext(visitorData) {
  const ctx = { ...IOS_CLIENT_BASE };
  if (visitorData) ctx.visitorData = visitorData;
  return ctx;
}

// ─── Shared YTM browse POST ───────────────────────────────────────────────────
async function ytmBrowse(browseId, env) {
  const resp = await fetch(`${YTM_BASE}/youtubei/v1/browse?key=${YTM_API_KEY}`, {
    method: 'POST', headers: SEARCH_HEADERS,
    body: JSON.stringify({ context: { client: WEB_REMIX_CONTEXT }, browseId }),
  });
  if (!resp.ok) throw new Error(`${LOG_PREFIX} Browse HTTP ${resp.status}`);
  const data = await resp.json();
  tryRefreshVisitor(data, env);
  return data;
}

// ─── Track renderer parser ────────────────────────────────────────────────────
function getVideoId(r) {
  if (!r) return null;
  return (
    r.playlistItemData?.videoId ||
    r.navigationEndpoint?.watchEndpoint?.videoId ||
    r.overlay?.musicItemThumbnailOverlayRenderer?.content
      ?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId ||
    r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs
      ?.find(run => run.navigationEndpoint?.watchEndpoint?.videoId)
      ?.navigationEndpoint?.watchEndpoint?.videoId ||
    null
  );
}
function parseTrackRenderer(r, fallbackArtist, fallbackAlbum, fallbackArtwork) {
  if (!r) return null;
  const videoId = getVideoId(r);
  if (!videoId) return null;

  const titleRuns = r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
  const title     = titleRuns.map(t => t.text).join('').trim();
  const infoRuns  = r.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
  const info      = parseInfoRuns(infoRuns);

  // Scan ALL fixedColumns for a valid duration — fixedColumns[0] on artist pages
  // contains a play count ("1.4B"), not a timestamp, so we validate before using.
  let durationText = '';
  for (const col of (r.fixedColumns || [])) {
    const txt = col?.musicResponsiveListItemFixedColumnRenderer?.text?.runs?.[0]?.text || '';
    if (isDurationText(txt)) { durationText = txt; break; }
  }
  if (!durationText) durationText = extractDurationFromRuns(infoRuns);
  if (!durationText && r.lengthMs) {
    durationText = `${Math.floor(r.lengthMs/60000)}:${String(Math.floor((r.lengthMs%60000)/1000)).padStart(2,'0')}`;
  }

  const thumbs = r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
  return {
    id: videoId,
    title: title || 'Unknown',
    artist: info.artist || fallbackArtist || '',
    album:  info.album  || fallbackAlbum  || '',
    duration:   parseDuration(durationText),
    artworkURL: bestThumbnail(thumbs) || fallbackArtwork || '',
    format: 'aac',
  };
}
// Handles both musicResponsiveListItemRenderer and musicListItemRenderer
function parseTrackItem(item, fallbackArtist, fallbackAlbum, fallbackArtwork) {
  const r = item?.musicResponsiveListItemRenderer || item?.musicListItemRenderer || null;
  return parseTrackRenderer(r, fallbackArtist, fallbackAlbum, fallbackArtwork);
}

// ─── Enrich missing durations via get_queue ───────────────────────────────────
// WEB_REMIX artist pages return play counts in fixedColumns, not duration.
// One batch call to get_queue fills them all in.
async function enrichDurations(tracks) {
  const missing = tracks.filter(t => t.duration === 0);
  if (!missing.length) return;
  try {
    const resp = await fetch(`${YTM_BASE}/youtubei/v1/music/get_queue?key=${YTM_API_KEY}`, {
      method: 'POST', headers: SEARCH_HEADERS,
      body: JSON.stringify({
        context: { client: WEB_REMIX_CONTEXT },
        videoIds: missing.map(t => t.id),
        isAudioOnly: true,
      }),
    });
    if (!resp.ok) return;
    const data = await resp.json();
    const map  = {};
    for (const q of (data?.queueDatas || [])) {
      const pv  = q?.content?.playlistPanelVideoRenderer;
      const vid = pv?.videoId;
      const txt = pv?.lengthText?.runs?.[0]?.text;
      if (vid && txt && isDurationText(txt)) map[vid] = parseDuration(txt);
    }
    for (const t of missing) { if (map[t.id]) t.duration = map[t.id]; }
  } catch (e) { console.log(LOG_PREFIX, 'enrichDurations failed:', e.message); }
}

// ─── Album/Artist/Playlist item parsers ──────────────────────────────────────
function parseAlbumItem(item) {
  const r2 = item?.musicTwoRowItemRenderer;
  if (r2) {
    const id =
      r2.navigationEndpoint?.browseEndpoint?.browseId ||
      r2.overlay?.musicItemThumbnailOverlayRenderer?.content
        ?.musicPlayButtonRenderer?.playNavigationEndpoint?.browseEndpoint?.browseId;
    if (!id) return null;
    const title   = r2.title?.runs?.[0]?.text || '';
    const skipSet = new Set(['Album','EP','Single','Compilation','Podcast']);
    const artist  = (r2.subtitle?.runs || [])
      .filter(r => !isBullet(r.text) && !/^\d{4}$/.test(r.text.trim()) && !skipSet.has(r.text.trim()))
      .map(r => r.text.trim()).filter(Boolean).join(' ').trim();
    return { id, title, artist, artworkURL: bestThumbnail(r2.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails || []) };
  }
  const r = item?.musicResponsiveListItemRenderer;
  if (r) {
    const id = r.navigationEndpoint?.browseEndpoint?.browseId;
    if (!id) return null;
    const title    = r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text || '';
    const infoRuns = r.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
    const info     = parseInfoRuns(infoRuns);
    return { id, title, artist: info.artist, artworkURL: bestThumbnail(r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || []) };
  }
  return null;
}
function parseArtistItem(item) {
  const r = item?.musicResponsiveListItemRenderer;
  if (!r) return null;
  const id   = r.navigationEndpoint?.browseEndpoint?.browseId;
  const name = (r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || []).map(t => t.text).join('').trim();
  if (!id || !name) return null;
  return { id, name, artworkURL: bestThumbnail(r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || []) };
}
function parsePlaylistItem(item) {
  const r2 = item?.musicTwoRowItemRenderer;
  if (r2) {
    const id = r2.navigationEndpoint?.browseEndpoint?.browseId ||
      r2.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.browseEndpoint?.browseId;
    if (!id) return null;
    const title   = r2.title?.runs?.[0]?.text || '';
    const creator = (r2.subtitle?.runs || []).filter(r => !isBullet(r.text)).map(r => r.text.trim()).filter(Boolean)[0] || '';
    return { id, title, creator, artworkURL: bestThumbnail(r2.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails || []) };
  }
  const r = item?.musicResponsiveListItemRenderer;
  if (r) {
    const id = r.navigationEndpoint?.browseEndpoint?.browseId;
    if (!id) return null;
    const title = (r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || []).map(t => t.text).join('').trim();
    return { id, title, artworkURL: bestThumbnail(r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || []) };
  }
  return null;
}

// ─── YTM search helper ────────────────────────────────────────────────────────
async function ytmSearch(query, params, env) {
  const body = { context: { client: WEB_REMIX_CONTEXT }, query };
  if (params) body.params = params;
  const resp = await fetch(`${YTM_BASE}/youtubei/v1/search?key=${YTM_API_KEY}`, {
    method: 'POST', headers: SEARCH_HEADERS, body: JSON.stringify(body),
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
  ).map(s => s.musicShelfRenderer).filter(Boolean);
}

// ─── Search ───────────────────────────────────────────────────────────────────
async function handleSearch(query, env) {
  if (!query) return { tracks: [], albums: [], artists: [], playlists: [] };
  const [songsR, videosR, albumsR, artistsR, playlistsR] = await Promise.allSettled([
    ytmSearch(query, SEARCH_PARAMS.songs,     env),
    ytmSearch(query, SEARCH_PARAMS.videos,    env),
    ytmSearch(query, SEARCH_PARAMS.albums,    env),
    ytmSearch(query, SEARCH_PARAMS.artists,   env),
    ytmSearch(query, SEARCH_PARAMS.playlists, env),
  ]);
  const tracks = [], albums = [], artists = [], playlists = [];
  const seenIds = new Set();
  function addTrack(t) { if (t && !seenIds.has(t.id)) { seenIds.add(t.id); tracks.push(t); } }
  if (songsR.status === 'fulfilled')
    for (const shelf of getShelves(songsR.value)) for (const item of shelf.contents || []) { addTrack(parseTrackItem(item)); if (tracks.length >= 20) break; }
  if (videosR.status === 'fulfilled')
    for (const shelf of getShelves(videosR.value)) for (const item of shelf.contents || []) { addTrack(parseTrackItem(item)); if (tracks.length >= 40) break; }
  if (albumsR.status === 'fulfilled')
    for (const shelf of getShelves(albumsR.value)) for (const item of shelf.contents || []) { const a = parseAlbumItem(item); if (a && albums.length < 10) albums.push(a); }
  if (artistsR.status === 'fulfilled')
    for (const shelf of getShelves(artistsR.value)) for (const item of shelf.contents || []) { const a = parseArtistItem(item); if (a && artists.length < 8) artists.push(a); }
  if (playlistsR.status === 'fulfilled')
    for (const shelf of getShelves(playlistsR.value)) for (const item of shelf.contents || []) { const p = parsePlaylistItem(item); if (p && playlists.length < 8) playlists.push(p); }
  return { tracks, albums, artists, playlists };
}

// ─── Stream ───────────────────────────────────────────────────────────────────
async function fetchPlayerData(trackId, env) {
  const visitorData = await getVisitorData(env);
  const resp = await fetch(`${YTM_BASE}/youtubei/v1/player?prettyPrint=false`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'com.google.ios.youtube/20.10.01 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X)' },
    body: JSON.stringify({ context: { client: buildIosContext(visitorData) }, videoId: trackId, contentCheckOk: true, racyCheckOk: true }),
  });
  if (!resp.ok) throw new Error(`${LOG_PREFIX} Player HTTP ${resp.status}`);
  const data   = await resp.json();
  const status = data?.playabilityStatus?.status;
  if (status !== 'OK') {
    upstashCmd(env, 'DEL', 'ytm:visitor');
    throw new Error(`${LOG_PREFIX} Blocked: ${data?.playabilityStatus?.reason || status || 'unknown'}`);
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
  const expiresAt = Math.floor(Date.now() / 1000) + 21600;

  // PRIMARY: HLS manifest — works on iOS (AVPlayer), Android (ExoPlayer), web (hls.js).
  // Direct adaptiveFormats MP4 URLs contain YouTube's 'n' throttle param which
  // requires client-side JS decoding (yt-dlp style) — without it they cap at ~15 kbps.
  // HLS manifests bypass this entirely. format:'aac' is correct — Eclipse uses codec
  // labels only; all three players detect HLS from the URL pattern automatically.
  if (sd.hlsManifestUrl) return { url: sd.hlsManifestUrl, format: 'aac', quality: 'high', expiresAt };

  // FALLBACK: direct audio/mp4 — only reached if no HLS manifest is returned (rare).
  const mp4Url = pickBestMp4(sd);
  if (mp4Url) return { url: mp4Url, format: 'aac', quality: 'high', expiresAt };

  throw new Error(`${LOG_PREFIX} No playable audio for ${trackId}`);
}

// ─── Album browse ─────────────────────────────────────────────────────────────
// Uses findAllDeep — works regardless of singleColumn vs twoColumn layout.
async function handleAlbum(albumId, env) {
  const data = await ytmBrowse(albumId, env);

  const header =
    data?.header?.musicImmersiveHeaderRenderer ||
    data?.header?.musicDetailHeaderRenderer ||
    data?.header?.musicEditableEntryPointHeaderRenderer?.header?.musicImmersiveHeaderRenderer ||
    data?.header?.musicEditableEntryPointHeaderRenderer?.header?.musicDetailHeaderRenderer ||
    findDeep(data?.header, 'musicImmersiveHeaderRenderer') ||
    findDeep(data?.header, 'musicDetailHeaderRenderer') || {};

  const albumTitle = header?.title?.runs?.[0]?.text || '';
  let albumArtist = '';
  for (const run of header?.subtitle?.runs || []) {
    if (run.navigationEndpoint?.browseEndpoint) { albumArtist = run.text; break; }
  }
  if (!albumArtist)
    albumArtist = (header?.straplineTextOne?.runs || []).map(r => r.text).join('').trim();

  const artworkURL = bestThumbnail(
    header?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails ||
    header?.thumbnail?.croppedSquareThumbnailRenderer?.thumbnail?.thumbnails || []
  );

  // Deep-search the entire contents for the musicShelfRenderer with the most items.
  // This handles singleColumn, twoColumn, and any future layout YTM introduces.
  let shelfContents = [];
  for (const shelf of findAllDeep(data?.contents, 'musicShelfRenderer')) {
    if ((shelf?.contents?.length || 0) > shelfContents.length)
      shelfContents = shelf.contents;
  }

  const tracks = [];
  for (let i = 0; i < shelfContents.length; i++) {
    const t = parseTrackItem(shelfContents[i], albumArtist, albumTitle, artworkURL);
    if (!t) continue;
    if (!t.artworkURL) t.artworkURL = artworkURL;
    t.album = albumTitle; t.trackNumber = i + 1;
    tracks.push(t);
  }
  return { id: albumId, title: albumTitle, artist: albumArtist, artworkURL, trackCount: tracks.length, tracks };
}

// ─── Artist browse ────────────────────────────────────────────────────────────
async function handleArtist(artistId, env) {
  const data = await ytmBrowse(artistId, env);

  const header = data?.header?.musicImmersiveHeaderRenderer || data?.header?.musicVisualHeaderRenderer || {};
  const name   = header?.title?.runs?.[0]?.text || 'Unknown Artist';
  const artworkURL = bestThumbnail(
    header?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails ||
    header?.foregroundThumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails ||
    header?.thumbnail?.croppedSquareThumbnailRenderer?.thumbnail?.thumbnails || []
  );

  const sections = data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]
    ?.tabRenderer?.content?.sectionListRenderer?.contents || [];

  const topTracks = [], albums = [];
  for (const section of sections) {
    const shelf = section?.musicShelfRenderer;
    if (shelf) {
      for (const item of shelf.contents || []) {
        const t = parseTrackItem(item, name, '', '');
        if (t && topTracks.length < 10) topTracks.push(t);
      }
    }
    const carousel = section?.musicCarouselShelfRenderer;
    if (carousel) {
      for (const item of carousel.contents || []) {
        const a = parseAlbumItem(item);
        if (a && albums.length < 30) albums.push({ ...a, artist: a.artist || name });
      }
    }
  }

  // WEB_REMIX artist pages return play counts (not duration) in fixedColumns.
  // Batch-fetch real durations via get_queue.
  if (topTracks.length) await enrichDurations(topTracks);

  return { id: artistId, name, artworkURL, bio: null, topTracks, albums };
}

// ─── Playlist browse ──────────────────────────────────────────────────────────
// YTM switched playlist browse to twoColumnBrowseResultsRenderer mid-2024.
// Deep-search both musicPlaylistShelfRenderer and musicShelfRenderer so the code
// keeps working regardless of which layout YTM returns.
async function handlePlaylist(playlistId, env) {
  const browseId = playlistId.startsWith('VL') ? playlistId : 'VL' + playlistId;
  const data     = await ytmBrowse(browseId, env);

  const header =
    data?.header?.musicDetailHeaderRenderer ||
    data?.header?.musicEditableEntryPointHeaderRenderer?.header?.musicDetailHeaderRenderer ||
    data?.header?.musicImmersiveHeaderRenderer ||
    findDeep(data?.header, 'musicDetailHeaderRenderer') || {};

  const title   = header?.title?.runs?.[0]?.text || 'Playlist';
  const creator = (header?.subtitle?.runs || [])
    .filter(r => !isBullet(r.text) && r.text !== 'Playlist')
    .map(r => r.text.trim()).filter(Boolean).join('').trim();
  const artworkURL = bestThumbnail(
    header?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails ||
    header?.thumbnail?.croppedSquareThumbnailRenderer?.thumbnail?.thumbnails || []
  );

  const tracks = [];

  // Pick the shelf (playlist or music) with the most items — handles any layout.
  const allShelves = [
    ...findAllDeep(data?.contents, 'musicPlaylistShelfRenderer'),
    ...findAllDeep(data?.contents, 'musicShelfRenderer'),
  ];
  let bestShelf = null;
  for (const shelf of allShelves) {
    if ((shelf?.contents?.length || 0) > (bestShelf?.contents?.length || 0))
      bestShelf = shelf;
  }
  for (const item of (bestShelf?.contents || [])) {
    const t = parseTrackItem(item);
    if (t) tracks.push(t);
  }

  return { id: playlistId, title, creator, artworkURL, trackCount: tracks.length, tracks };
}

// ─── Token helpers ────────────────────────────────────────────────────────────
function generateToken() {
  const arr = new Uint8Array(14); crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}
function isValidToken(t) { return typeof t === 'string' && /^[a-f0-9]{28}$/.test(t); }
function parseTokenPath(pathname) {
  const m = pathname.match(/^\/u\/([a-f0-9]{28})(\/.*)?$/);
  return m ? { token: m[1], rest: m[2] || '/' } : null;
}
function lastSegment(rest) { return rest.split('/').filter(Boolean).pop() || ''; }

// ─── Eclipse manifest ─────────────────────────────────────────────────────────
function buildManifest() {
  return {
    id: 'com.ricky.youtube-music', name: 'YouTube Music', version: '1.5.2',
    description: 'Stream from YouTube Music — Songs, Videos, Albums, Artists, Playlists. HLS preferred, MP4 fallback.',
    icon: 'https://www.gstatic.com/youtube/media/ytm/images/applauncher/music_icon_144x144.png',
    resources: ['search', 'stream', 'catalog'],
    types: ['track', 'album', 'artist', 'playlist'],
    contentType: 'music',
  };
}

// ─── Route handler ────────────────────────────────────────────────────────────
async function handleRoute(rest, url, env) {
  const q = url.searchParams.get('q') || url.searchParams.get('query') || '';
  if (rest === '/manifest.json' || rest === '/manifest') return jsonRes(buildManifest());
  if (rest === '/search')            return jsonRes(await handleSearch(q, env));
  if (rest.startsWith('/stream/'))   { const id = lastSegment(rest); if (!id) return jsonRes({ error: 'Missing track ID' }, 400); return jsonRes(await handleStream(id, env)); }
  if (rest.startsWith('/album/'))    { const id = lastSegment(rest); if (!id) return jsonRes({ error: 'Missing album ID' }, 400); return jsonRes(await handleAlbum(id, env)); }
  if (rest.startsWith('/artist/'))   { const id = lastSegment(rest); if (!id) return jsonRes({ error: 'Missing artist ID' }, 400); return jsonRes(await handleArtist(id, env)); }
  if (rest.startsWith('/playlist/')) { const id = lastSegment(rest); if (!id) return jsonRes({ error: 'Missing playlist ID' }, 400); return jsonRes(await handlePlaylist(id, env)); }
  return null;
}

// ─── Response helpers ─────────────────────────────────────────────────────────
function jsonRes(data, status) {
  return new Response(JSON.stringify(data, null, 2), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'Content-Type', 'cache-control': 'no-store' },
  });
}
function htmlRes(b) { return new Response(b, { headers: { 'content-type': 'text/html; charset=utf-8' } }); }

// ─── Landing page HTML ────────────────────────────────────────────────────────
function buildLandingPage(baseUrl) {
  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>YouTube Music — 8SPINE / Eclipse Addon</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300..700&family=Syne:wght@600..800&display=swap" rel="stylesheet"/>
<style>
:root,[data-theme="dark"]{
  --bg:#0f0f10;--surface:#17171a;--surface-2:#1e1e22;--surface-3:#26262c;
  --border:rgba(255,255,255,.08);--border-2:rgba(255,255,255,.12);
  --text:#e8e8ea;--muted:#888;--faint:#444;
  --red:#ff0033;--red-dim:#c20028;--red-glow:rgba(255,0,51,.18);
  --radius:12px;--radius-lg:18px;--radius-full:9999px;
  --transition:180ms cubic-bezier(.16,1,.3,1);
}
[data-theme="light"]{
  --bg:#f5f5f7;--surface:#fff;--surface-2:#f0f0f2;--surface-3:#e8e8ea;
  --border:rgba(0,0,0,.08);--border-2:rgba(0,0,0,.12);
  --text:#111;--muted:#555;--faint:#bbb;
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{-webkit-font-smoothing:antialiased;scroll-behavior:smooth}
body{font-family:'Inter',sans-serif;font-size:16px;background:var(--bg);color:var(--text);line-height:1.6;min-height:100dvh}
img{display:block;max-width:100%}
button{cursor:pointer;font:inherit;color:inherit}
a{color:inherit;text-decoration:none}

/* ── nav */
nav{position:sticky;top:0;z-index:99;background:rgba(15,15,16,.85);backdrop-filter:blur(16px);border-bottom:1px solid var(--border);padding:0 clamp(16px,4vw,48px)}
.nav-inner{max-width:1080px;margin:0 auto;height:56px;display:flex;align-items:center;justify-content:space-between}
.logo{display:flex;align-items:center;gap:10px;font-family:'Syne',sans-serif;font-weight:700;font-size:17px;letter-spacing:-.02em}
.logo svg{flex-shrink:0}
.nav-right{display:flex;align-items:center;gap:12px}
.theme-btn{background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-full);width:36px;height:36px;display:grid;place-items:center;transition:background var(--transition)}
.theme-btn:hover{background:var(--surface-3)}

/* ── hero */
.hero{padding:clamp(60px,10vw,120px) clamp(16px,4vw,48px) clamp(40px,6vw,80px);text-align:center;position:relative;overflow:hidden}
.hero::before{content:'';position:absolute;inset:0;background:radial-gradient(ellipse 70% 50% at 50% 0%,var(--red-glow),transparent);pointer-events:none}
.hero-eyebrow{display:inline-flex;align-items:center;gap:8px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-full);padding:5px 14px;font-size:13px;color:var(--muted);margin-bottom:28px}
.hero-eyebrow span{color:var(--red);font-weight:600}
.hero h1{font-family:'Syne',sans-serif;font-size:clamp(2.2rem,6vw,4.5rem);font-weight:800;letter-spacing:-.04em;line-height:1.05;margin-bottom:20px}
.hero h1 em{font-style:normal;color:var(--red)}
.hero p{font-size:clamp(1rem,2vw,1.2rem);color:var(--muted);max-width:520px;margin:0 auto 40px}
.hero-actions{display:flex;gap:12px;justify-content:center;flex-wrap:wrap}
.btn-primary{background:var(--red);color:#fff;border:none;border-radius:var(--radius-full);padding:12px 28px;font-size:15px;font-weight:600;transition:background var(--transition),transform var(--transition),box-shadow var(--transition)}
.btn-primary:hover{background:var(--red-dim);transform:translateY(-1px);box-shadow:0 8px 24px var(--red-glow)}
.btn-primary:active{transform:translateY(0)}
.btn-ghost{background:var(--surface-2);border:1px solid var(--border-2);border-radius:var(--radius-full);padding:12px 24px;font-size:15px;font-weight:500;transition:background var(--transition)}
.btn-ghost:hover{background:var(--surface-3)}

/* ── badges */
.badges{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:36px}
.badge{background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-full);padding:5px 14px;font-size:12px;color:var(--muted);font-weight:500}

/* ── section */
section{padding:clamp(40px,6vw,80px) clamp(16px,4vw,48px)}
.section-inner{max-width:1080px;margin:0 auto}
.section-label{font-size:12px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--red);margin-bottom:12px}
.section-title{font-family:'Syne',sans-serif;font-size:clamp(1.5rem,3.5vw,2.5rem);font-weight:800;letter-spacing:-.03em;margin-bottom:16px}
.section-desc{color:var(--muted);max-width:540px;margin-bottom:40px;font-size:15px}

/* ── features grid */
.features-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(280px,100%),1fr));gap:16px}
.feature-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);padding:24px;transition:border-color var(--transition),transform var(--transition)}
.feature-card:hover{border-color:var(--border-2);transform:translateY(-2px)}
.feature-icon{width:40px;height:40px;border-radius:10px;background:var(--red-glow);border:1px solid rgba(255,0,51,.25);display:grid;place-items:center;margin-bottom:16px;color:var(--red)}
.feature-card h3{font-family:'Syne',sans-serif;font-size:15px;font-weight:700;margin-bottom:6px}
.feature-card p{font-size:13px;color:var(--muted);line-height:1.5}

/* ── endpoints */
.endpoints-list{display:flex;flex-direction:column;gap:8px}
.endpoint{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px 18px;display:flex;align-items:center;gap:12px;font-family:monospace;font-size:13px;transition:border-color var(--transition)}
.endpoint:hover{border-color:var(--border-2)}
.method{background:var(--red);color:#fff;border-radius:6px;padding:2px 8px;font-size:11px;font-weight:700;font-family:'Inter',sans-serif;flex-shrink:0}
.ep-path{color:var(--text);flex:1}
.ep-desc{color:var(--muted);font-family:'Inter',sans-serif;font-size:12px;margin-left:auto}

/* ── manifest generator */
.generator{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);padding:clamp(24px,4vw,40px)}
.gen-url-display{background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;font-family:monospace;font-size:13px;word-break:break-all;color:var(--red);margin-bottom:16px;min-height:48px;display:flex;align-items:center}
.gen-actions{display:flex;gap:10px;flex-wrap:wrap}
.copy-btn{background:var(--surface-2);border:1px solid var(--border-2);border-radius:var(--radius-full);padding:9px 20px;font-size:13px;font-weight:600;transition:background var(--transition),color var(--transition)}
.copy-btn:hover{background:var(--surface-3)}
.copy-btn.copied{background:var(--red);color:#fff;border-color:var(--red)}
.open-btn{background:var(--red);color:#fff;border:none;border-radius:var(--radius-full);padding:9px 20px;font-size:13px;font-weight:600;transition:background var(--transition)}
.open-btn:hover{background:var(--red-dim)}

/* ── footer */
footer{border-top:1px solid var(--border);padding:clamp(24px,4vw,40px) clamp(16px,4vw,48px);text-align:center;color:var(--muted);font-size:13px}
footer a{color:var(--red)}

@media(max-width:600px){.hero-actions{flex-direction:column;align-items:center}.gen-actions{flex-direction:column}}
</style>
</head>
<body>

<nav>
  <div class="nav-inner">
    <div class="logo">
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-label="YouTube Music">
        <rect width="28" height="28" rx="8" fill="#ff0033"/>
        <circle cx="14" cy="14" r="7" fill="rgba(0,0,0,.35)"/>
        <polygon points="11.5,10.5 20,14 11.5,17.5" fill="#fff"/>
      </svg>
      YouTube Music
    </div>
    <div class="nav-right">
      <button class="theme-btn" data-theme-toggle aria-label="Toggle theme">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
      </button>
    </div>
  </div>
</nav>

<main>
  <!-- Hero -->
  <section class="hero">
    <div class="hero-eyebrow"><span>v1.5.2</span> Eclipse / 8SPINE Addon</div>
    <h1>YouTube Music<br/>for <em>Eclipse</em></h1>
    <p>Full-featured addon — songs, albums, artists, playlists. HLS streaming with automatic MP4 fallback.</p>
    <div class="hero-actions">
      <button class="btn-primary" onclick="document.getElementById('generator').scrollIntoView({behavior:'smooth'})">Get Manifest URL</button>
      <button class="btn-ghost" onclick="document.getElementById('endpoints').scrollIntoView({behavior:'smooth'})">View API Docs</button>
    </div>
    <div class="badges">
      <span class="badge">HLS Primary</span>
      <span class="badge">MP4 Fallback</span>
      <span class="badge">Upstash Redis</span>
      <span class="badge">Search · Albums · Artists · Playlists</span>
      <span class="badge">Cloudflare Workers</span>
    </div>
  </section>

  <!-- Features -->
  <section style="background:var(--surface)">
    <div class="section-inner">
      <div class="section-label">What's included</div>
      <div class="section-title">Everything you need</div>
      <div class="features-grid">
        <div class="feature-card">
          <div class="feature-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg></div>
          <h3>Smart Search</h3>
          <p>Parallel search across songs, videos, albums, artists, and playlists in one request.</p>
        </div>
        <div class="feature-card">
          <div class="feature-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg></div>
          <h3>HLS + MP4 Streaming</h3>
          <p>HLS manifest is served first for native player compatibility. Direct MP4 used as fallback.</p>
        </div>
        <div class="feature-card">
          <div class="feature-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg></div>
          <h3>Album Browse</h3>
          <p>Full album track listing with artwork, artist, and track numbers — layout-agnostic parsing.</p>
        </div>
        <div class="feature-card">
          <div class="feature-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></div>
          <h3>Artist Pages</h3>
          <p>Top tracks and discography with real durations fetched via get_queue batch call.</p>
        </div>
        <div class="feature-card">
          <div class="feature-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>
          <h3>Playlists</h3>
          <p>Community and personal playlists — deep-search parser handles YTM's changing layout.</p>
        </div>
        <div class="feature-card">
          <div class="feature-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg></div>
          <h3>Upstash Redis Cache</h3>
          <p>visitorData cached with TTL — zero cold-start delay on first play, automatic refresh.</p>
        </div>
      </div>
    </div>
  </section>

  <!-- Manifest Generator -->
  <section id="generator">
    <div class="section-inner">
      <div class="section-label">Get started</div>
      <div class="section-title">Manifest URL</div>
      <p class="section-desc">Generate your personal manifest URL and add it to Eclipse to start listening.</p>
      <div class="generator">
        <div class="gen-url-display" id="manifestDisplay">${baseUrl}/manifest.json</div>
        <div class="gen-actions">
          <button class="copy-btn" id="copyBtn" onclick="copyManifest()">Copy URL</button>
          <button class="open-btn" onclick="openInEclipse()">Open in Eclipse</button>
        </div>
      </div>
    </div>
  </section>

  <!-- Endpoints -->
  <section id="endpoints" style="background:var(--surface)">
    <div class="section-inner">
      <div class="section-label">API Reference</div>
      <div class="section-title">Endpoints</div>
      <div class="endpoints-list">
        <div class="endpoint"><span class="method">GET</span><span class="ep-path">/manifest.json</span><span class="ep-desc">Eclipse manifest</span></div>
        <div class="endpoint"><span class="method">GET</span><span class="ep-path">/search?q={query}</span><span class="ep-desc">Search tracks, albums, artists, playlists</span></div>
        <div class="endpoint"><span class="method">GET</span><span class="ep-path">/stream/{videoId}</span><span class="ep-desc">Get HLS / MP4 stream URL</span></div>
        <div class="endpoint"><span class="method">GET</span><span class="ep-path">/album/{browseId}</span><span class="ep-desc">Album + track list</span></div>
        <div class="endpoint"><span class="method">GET</span><span class="ep-path">/artist/{browseId}</span><span class="ep-desc">Artist top tracks + discography</span></div>
        <div class="endpoint"><span class="method">GET</span><span class="ep-path">/playlist/{playlistId}</span><span class="ep-desc">Playlist track list</span></div>
      </div>
    </div>
  </section>
</main>

<footer>
  <p>YouTube Music Addon · <a href="#">v1.5.2</a> · Built for Eclipse &amp; 8SPINE · Cloudflare Workers</p>
</footer>

<script>
(function(){
  const t=document.querySelector('[data-theme-toggle]'),r=document.documentElement;
  let d=matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light';
  r.setAttribute('data-theme',d);
  if(t)t.addEventListener('click',()=>{
    d=d==='dark'?'light':'dark';r.setAttribute('data-theme',d);
    t.innerHTML=d==='dark'
      ?'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>'
      :'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>';
  });
})();

async function copyManifest(){
  const url=document.getElementById('manifestDisplay').textContent;
  try{await navigator.clipboard.writeText(url);}catch(e){const el=document.createElement('textarea');el.value=url;document.body.appendChild(el);el.select();document.execCommand('copy');document.body.removeChild(el);}
  const btn=document.getElementById('copyBtn');btn.textContent='Copied!';btn.classList.add('copied');
  setTimeout(()=>{btn.textContent='Copy URL';btn.classList.remove('copied');},2000);
}
function openInEclipse(){
  const url=document.getElementById('manifestDisplay').textContent;
  window.open('eclipse://addons?url='+encodeURIComponent(url),'_blank');
}
</script>
</body>
</html>`;
}

// ─── Cloudflare Worker entry point ────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'Content-Type' } });

    try {
      // ── Direct public routes (no token required) ──
      const pub = await handleRoute(pathname, url, env);
      if (pub) return pub;

      // ── Token-scoped routes: /u/{token}/... ──
      const tp = parseTokenPath(pathname);
      if (tp) {
        const stored = await upstashCmd(env, 'EXISTS', `token:${tp.token}`);
        if (!stored) return jsonRes({ error: 'Invalid or expired token' }, 403);
        const routed = await handleRoute(tp.rest, url, env);
        if (routed) return routed;
      }

      // ── Token provisioning ──
      if (pathname === '/generate' || pathname === '/token/new') {
        const token = generateToken();
        await upstashCmd(env, 'SET', `token:${token}`, '1', 'EX', 2592000);
        const base = `${url.origin}/u/${token}`;
        return jsonRes({ token, manifestUrl: `${base}/manifest.json`, base });
      }

      // ── Landing page ──
      if (pathname === '/' || pathname === '') return htmlRes(buildLandingPage(url.origin));

      return jsonRes({ error: 'Not found' }, 404);
    } catch (e) {
      console.error(LOG_PREFIX, e);
      return jsonRes({ error: e.message }, 500);
    }
  },
};
