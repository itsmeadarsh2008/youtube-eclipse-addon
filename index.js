const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');

let Redis;
try { Redis = require('ioredis'); } catch(e) { Redis = null; }

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

let redis = null;
if (Redis && process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 3, enableReadyCheck: false });
  redis.on('connect', () => console.log('[Redis] Connected'));
  redis.on('error', e => console.error('[Redis]', e.message));
}

async function redisSave(token, entry) {
  if (!redis) return;
  try {
    await redis.set('ytaddon:' + token, JSON.stringify({
      createdAt: entry.createdAt, lastUsed: entry.lastUsed, reqCount: entry.reqCount, ytApiKey: entry.ytApiKey || null
    }));
  } catch(e) {}
}
async function redisLoad(token) {
  if (!redis) return null;
  try { const d = await redis.get('ytaddon:' + token); return d ? JSON.parse(d) : null; } catch(e) { return null; }
}

const TOKEN_CACHE = new Map();
const SEARCH_CACHE = new Map();
const DETAIL_CACHE = new Map();
const STREAM_CACHE = new Map();
const IP_CREATES = new Map();
const MAX_TOKENS_PER_IP = 10;
const RATE_MAX = 80;
const RATE_WINDOW_MS = 60000;
const SOURCE_TIMEOUT_MS = 10000;
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const INVIDIOUS_INSTANCES = [
  'https://invidious.nerdvpn.de',
  'https://yt.cdaut.de',
  'https://invidious.slipfox.xyz',
  'https://vid.puffyan.us',
  'https://invidious.io',
  'https://inv.nadeko.net',
  'https://yewtu.be',
  'https://invidious.cnx.app',
  'https://invidious.kavin.rocks',
  'https://invidious.13ad.de'
];

function generateToken() { return crypto.randomBytes(14).toString('hex'); }
function cleanText(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
function getBaseUrl(req) { return (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.get('host'); }
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;'); }

function getOrCreateIpBucket(ip) {
  const now = Date.now();
  let b = IP_CREATES.get(ip);
  if (!b || now > b.resetAt) { b = { count: 0, resetAt: now + 86400000 }; IP_CREATES.set(ip, b); }
  return b;
}
async function getTokenEntry(token) {
  if (TOKEN_CACHE.has(token)) return TOKEN_CACHE.get(token);
  const saved = await redisLoad(token);
  if (!saved) return null;
  const entry = { createdAt: saved.createdAt, lastUsed: saved.lastUsed, reqCount: saved.reqCount || 0, rateWin: [], ytApiKey: saved.ytApiKey || null };
  TOKEN_CACHE.set(token, entry);
  return entry;
}
function checkRateLimit(entry) {
  const now = Date.now();
  entry.rateWin = (entry.rateWin || []).filter(t => now - t < RATE_WINDOW_MS);
  if (entry.rateWin.length >= RATE_MAX) return false;
  entry.rateWin.push(now);
  entry.lastUsed = now;
  entry.reqCount = (entry.reqCount || 0) + 1;
  return true;
}
async function tokenMiddleware(req, res, next) {
  const entry = await getTokenEntry(req.params.token);
  if (!entry) return res.status(404).json({ error: 'Invalid token.' });
  if (!checkRateLimit(entry)) return res.status(429).json({ error: 'Rate limit exceeded. Try again in a minute.' });
  req.tokenEntry = entry;
  if (entry.reqCount % 20 === 0) redisSave(req.params.token, entry);
  next();
}
async function fetchYT(url, params) {
  const r = await axios.get(url, {
    params,
    timeout: SOURCE_TIMEOUT_MS,
    headers: { 'User-Agent': UA, 'Accept': 'application/json' }
  });
  return r.data;
}
async function validateYouTubeKey(key) {
  try {
    const data = await fetchYT('https://www.googleapis.com/youtube/v3/search', {
      part: 'snippet', q: 'music', type: 'video', maxResults: 1, key
    });
    return Array.isArray(data.items);
  } catch(e) { return false; }
}
function parseISODuration(iso) {
  const m = String(iso || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return null;
  const secs = (parseInt(m[1]||0)*3600) + (parseInt(m[2]||0)*60) + parseInt(m[3]||0);
  return secs > 0 ? secs : null;
}
function normalizeLoose(s) {
  return String(s||'').toLowerCase()
    .replace(/&/g,' and ').replace(/\\(.*?\\)/g,' ').replace(/\\[.*?\\]/g,' ')
    .replace(/[^a-z0-9]+/g,' ')
    .replace(/\b(official|video|audio|lyrics|lyric|hd|4k|visualizer|topic|live|feat|ft)\b/g,' ')
    .replace(/\s+/g,' ').trim();
}
function tokenizeLoose(s) { return normalizeLoose(s).split(/\s+/).filter(Boolean); }
function overlapScore(query, text) {
  const qw = tokenizeLoose(query), tw = new Set(tokenizeLoose(text));
  if (!qw.length) return 0;
  return qw.filter(w => tw.has(w)).length / qw.length;
}
function scoreVideo(query, title, channel, desc) {
  const q = normalizeLoose(query), t = normalizeLoose(title), c = normalizeLoose(channel), d = normalizeLoose(desc);
  const words = tokenizeLoose(query);
  let score = 0;
  if (!q || !t) return 0;
  if (t === q) score += 180;
  else if (t.startsWith(q)) score += 70;
  else if (t.includes(q)) score += 45;
  for (const w of words) {
    if (t.includes(w)) score += 14;
    else if (c.includes(w)) score += 6;
    else if (d.includes(w)) score += 2;
    else score -= 6;
  }
  score += Math.round(overlapScore(query, [title, channel, desc].join(' ')) * 70);
  if (/\b(full album|playlist|mix|compilation|slowed|reverb|nightcore|reaction|review|interview|podcast|trailer)\b/i.test(title + ' ' + desc)) score -= 60;
  if (/\b(official audio|official video|audio|lyrics?|visualizer|topic)\b/i.test(title)) score += 20;
  return score;
}
function pickArt(snippet) {
  return (snippet && (snippet.thumbnails?.high?.url || snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url)) || null;
}
function mapToTrack(videoId, snippet, contentDetails) {
  return {
    id: 'ytvid_' + videoId,
    title: cleanText(snippet.title || 'YouTube Video'),
    artist: cleanText(snippet.channelTitle || 'YouTube'),
    album: 'YouTube',
    duration: parseISODuration(contentDetails?.duration),
    artworkURL: pickArt(snippet),
    format: 'm4a',
    sourceURL: 'https://www.youtube.com/watch?v=' + videoId
  };
}

async function resolveAudioViaInvidious(videoId) {
  for (const instance of INVIDIOUS_INSTANCES) {
    try {
      const url = `${instance}/api/v1/videos/${videoId}`;
      const data = await axios.get(url, {
        timeout: 10000,
        headers: { 'User-Agent': UA }
      });

      const formats = data.data?.adaptiveFormats || [];
      const playableFormats = formats.filter(f =>
        f.type?.startsWith('audio/') ||
        f.type?.includes('audio/mp4') ||
        f.type?.includes('audio/webm') ||
        f.type?.includes('audio/opus')
      );

      if (!playableFormats.length) {
        console.warn(`[stream] ${instance} has no suitable audio for ${videoId}`);
        continue;
      }

      // Prefer m4a, then webm/opus, then any audio
      const m4a = playableFormats.find(f => f.type?.includes('audio/mp4'));
      const webm = playableFormats.find(f => f.type?.includes('audio/webm'));
      const opus = playableFormats.find(f => f.type?.includes('audio/opus'));
      const any = playableFormats[0];

      const best = m4a || webm || opus || any;

      if (best && best.url) {
        const fmt = best.type?.includes('mp4') ? 'm4a' :
                    best.type?.includes('webm') ? 'webm' :
                    best.type?.includes('opus') ? 'opus' : 'ogg';

        console.log(`[stream] ✅ ${videoId} → ${fmt} from ${instance}`);

        return {
          url: best.url,
          format: fmt,
          quality: best.bitrate ? `${Math.round(best.bitrate / 1000)}kbps` : 'standard',
          expiresAt: Date.now() + 3600000
        };
      }
    } catch(e) {
      console.warn(`[stream] Invidious instance ${instance} failed: ${e.message}`);
    }
  }
  console.error('[stream] all instances failed for', videoId);
  return null;
}

async function youtubeSearch(apiKey, q) {
  const cacheKey = apiKey.slice(-8) + '|' + q.toLowerCase();
  const cached = SEARCH_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < 5 * 60 * 1000) return cached.out;

  const searchData = await fetchYT('https://www.googleapis.com/youtube/v3/search', {
    part: 'snippet', q, type: 'video', maxResults: 20, safeSearch: 'none', key: apiKey
  });

  const items = Array.isArray(searchData.items) ? searchData.items : [];
  const ids = items.map(x => x.id?.videoId).filter(Boolean).join(',');

  let detailMap = new Map();
  if (ids) {
    try {
      const detailData = await fetchYT('https://www.googleapis.com/youtube/v3/videos', {
        part: 'contentDetails,snippet', id: ids, key: apiKey
      });
      (detailData.items || []).forEach(d => detailMap.set(String(d.id), d));
    } catch(e) {}
  }

  const ranked = items.map(item => {
    const vid = String(item.id?.videoId || '');
    const detail = detailMap.get(vid);
    const s = item.snippet || {};
    return { vid, snippet: detail?.snippet || s, detail, score: scoreVideo(q, s.title||'', s.channelTitle||'', s.description||'') };
  }).filter(x => x.score >= 20).sort((a, b) => b.score - a.score).slice(0, 12);

  const tracks = ranked.map(x => mapToTrack(x.vid, x.snippet, x.detail?.contentDetails));

  const albums = ranked.slice(0, 8).map(x => ({
    id: 'ytalbum_' + x.vid,
    title: cleanText(x.snippet.title || 'YouTube Video'),
    artist: cleanText(x.snippet.channelTitle || 'YouTube'),
    artworkURL: pickArt(x.snippet),
    trackCount: 1,
    year: String(x.snippet.publishedAt || '').slice(0, 4) || null
  }));

  const seenArtists = new Set(), artists = [];
  const seenPlaylists = new Set(), playlists = [];
  for (const x of ranked) {
    const cid = String(x.snippet.channelId || '');
    const cname = cleanText(x.snippet.channelTitle || 'YouTube');
    if (cid && !seenArtists.has(cid)) {
      seenArtists.add(cid);
      artists.push({ id: 'ytartist_' + cid, name: cname, artworkURL: pickArt(x.snippet), genres: [] });
    }
    if (cid && !seenPlaylists.has(cid)) {
      seenPlaylists.add(cid);
      playlists.push({ id: 'ytplaylist_' + cid, title: cname + ' Picks', creator: cname, artworkURL: pickArt(x.snippet), trackCount: null });
    }
  }

  const out = { tracks, albums, artists: artists.slice(0, 6), playlists: playlists.slice(0, 6) };
  SEARCH_CACHE.set(cacheKey, { ts: Date.now(), out });
  return out;
}

async function getVideoById(apiKey, videoId) {
  const key = 'v:' + videoId;
  const cached = DETAIL_CACHE.get(key);
  if (cached && Date.now() - cached.ts < 30 * 60 * 1000) return cached.item;
  try {
    const data = await fetchYT('https://www.googleapis.com/youtube/v3/videos', {
      part: 'contentDetails,snippet', id: videoId, key: apiKey
    });
    const item = Array.isArray(data.items) ? data.items[0] : null;
    DETAIL_CACHE.set(key, { ts: Date.now(), item: item || null });
    return item || null;
  } catch(e) { return null; }
}

async function getChannelVideos(apiKey, channelId) {
  const key = 'ch:' + channelId;
  const cached = DETAIL_CACHE.get(key);
  if (cached && Date.now() - cached.ts < 10 * 60 * 1000) return cached.items;
  try {
    const data = await fetchYT('https://www.googleapis.com/youtube/v3/search', {
      part: 'snippet', channelId, type: 'video', maxResults: 12, order: 'relevance', key: apiKey
    });
    const items = Array.isArray(data.items) ? data.items : [];
    DETAIL_CACHE.set(key, { ts: Date.now(), items });
    return items;
  } catch(e) { return []; }
}

function buildConfigPage(baseUrl) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>YouTube Search Addon</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0c0a08;color:#e8e4de;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:48px 20px 64px}
.card{background:#131109;border:1px solid #2a2310;border-radius:18px;padding:36px;max-width:540px;width:100%;box-shadow:0 24px 64px rgba(0,0,0,.6);margin-bottom:20px}
button{cursor:pointer;border:none;border-radius:10px;font-size:15px;font-weight:700;padding:13px;width:100%;margin-top:6px;margin-bottom:12px}
.bo{background:#c8a53a;color:#0c0a00}.bg{background:#1a2a14;color:#e8e4de;border:1px solid #3a5020}.bd{background:#1a1a14;color:#aaa;border:1px solid #2a2a18;font-size:13px;padding:10px}
input{width:100%;background:#0c0a06;border:1px solid #2a2000;border-radius:10px;color:#e8e4de;font-size:14px;padding:12px 14px;margin-bottom:6px;outline:none}
.box{display:none;background:#0c0a06;border:1px solid #2a2000;border-radius:12px;padding:18px;margin-bottom:14px}
.status{font-size:13px;color:#6a5a28;margin:8px 0;min-height:18px}.status.ok{color:#6db86d}.status.err{color:#c0392b}.status.spin{color:#c8a53a}
.burl{font-size:12px;color:#c8a53a;word-break:break-all;font-family:"SF Mono",ui-monospace,monospace;margin-bottom:14px;line-height:1.5}
.preview{background:#0c0a06;border:1px solid #1a1600;border-radius:10px;padding:12px;max-height:220px;overflow-y:auto;margin-bottom:12px;display:none}
</style>
</head>
<body>
<div class="card">
  <input id="ytKey" placeholder="Paste your YouTube API key">
  <button class="bo" id="genBtn">Generate My Addon URL</button>
  <div class="box" id="genBox"><div class="burl" id="genUrl"></div><button class="bd" id="copyBtn">Copy URL</button></div>
  <div class="status" id="genStatus"></div>
  <input id="expToken" placeholder="Paste your addon URL here">
  <input id="expQuery" placeholder="Search query">
  <div class="status" id="expStatus"></div>
  <div class="preview" id="expPreview"></div>
  <button class="bg" id="expBtn">Fetch &amp; Download CSV</button>
</div>
<script>
var addonUrl = '';
document.getElementById('genBtn').addEventListener('click', function() {
  var btn = document.getElementById('genBtn');
  var st = document.getElementById('genStatus');
  var key = document.getElementById('ytKey').value.trim();
  if (!key) { st.className='status err'; st.textContent='Paste your YouTube API key first.'; return; }
  btn.disabled = true;
  btn.textContent = 'Validating key...';
  st.className = 'status spin';
  st.textContent = 'Checking your API key with YouTube...';
  fetch('/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ytApiKey: key })
  }).then(function(r){ return r.json(); }).then(function(d){
    if (d.error) { st.className='status err'; st.textContent=d.error; btn.disabled=false; btn.textContent='Generate My Addon URL'; return; }
    addonUrl = d.manifestUrl;
    document.getElementById('genUrl').textContent = addonUrl;
    document.getElementById('genBox').style.display = 'block';
    document.getElementById('expToken').value = addonUrl;
    st.className = 'status ok';
    st.textContent = '\u2713 Your addon URL is ready';
    btn.disabled = false;
    btn.textContent = 'Regenerate URL';
  }).catch(function(e){
    st.className = 'status err';
    st.textContent = 'Error: ' + e.message;
    btn.disabled = false;
    btn.textContent = 'Generate My Addon URL';
  });
});
document.getElementById('copyBtn').addEventListener('click', function() {
  if (!addonUrl) return;
  navigator.clipboard.writeText(addonUrl).then(function() {
    var b = document.getElementById('copyBtn');
    b.textContent = 'Copied!';
    setTimeout(function() { b.textContent = 'Copy URL'; }, 1500);
  });
});
document.getElementById('expBtn').addEventListener('click', function() {
  var btn = document.getElementById('expBtn');
  var raw = document.getElementById('expToken').value.trim();
  var q = document.getElementById('expQuery').value.trim();
  var st = document.getElementById('expStatus');
  var pv = document.getElementById('expPreview');
  if (!raw) { st.className='status err'; st.textContent='Paste your addon URL first.'; return; }
  if (!q) { st.className='status err'; st.textContent='Enter a search query.'; return; }
  var m = raw.match(/\/([a-f0-9]{28})\//i);
  if (!m) { st.className='status err'; st.textContent='Could not find token in URL.'; return; }
  var tok = m[1];
  btn.disabled = true;
  btn.textContent = 'Fetching...';
  st.className = 'status spin';
  st.textContent = 'Searching...';
  fetch('/' + tok + '/search?q=' + encodeURIComponent(q)).then(function(r){
    if (!r.ok) return r.json().then(function(e){ throw new Error(e.error || ('Server error ' + r.status)); });
    return r.json();
  }).then(function(data){
    var tracks = data.tracks || [];
    if (!tracks.length) throw new Error('No tracks found for that query.');
    pv.innerHTML = tracks.slice(0, 40).map(function(t, i){
      return '<div>' + (i+1) + '. ' + t.title + ' \u2014 ' + t.artist + '</div>';
    }).join('');
    pv.style.display = 'block';
    st.className = 'status ok';
    st.textContent = 'Found ' + tracks.length + ' tracks';
    btn.disabled = false;
    btn.textContent = 'Fetch & Download CSV';
  }).catch(function(e){
    st.className = 'status err';
    st.textContent = e.message;
    btn.disabled = false;
    btn.textContent = 'Fetch & Download CSV';
  });
});
</script>
</body>
</html>`;
}

app.get('/', function(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildConfigPage(getBaseUrl(req)));
});

app.post('/generate', async function(req, res) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  const bucket = getOrCreateIpBucket(ip);
  if (bucket.count >= MAX_TOKENS_PER_IP) return res.status(429).json({ error: 'Too many tokens today from this IP.' });
  const ytApiKey = cleanText((req.body && req.body.ytApiKey) || '');
  if (!ytApiKey) return res.status(400).json({ error: 'Paste your YouTube API key.' });
  const valid = await validateYouTubeKey(ytApiKey);
  if (!valid) return res.status(401).json({ error: 'Invalid YouTube API key. Make sure YouTube Data API v3 is enabled in Google Cloud Console.' });
  const token = generateToken();
  const entry = { createdAt: Date.now(), lastUsed: Date.now(), reqCount: 0, rateWin: [], ytApiKey };
  TOKEN_CACHE.set(token, entry);
  await redisSave(token, entry);
  bucket.count++;
  res.json({ token, manifestUrl: getBaseUrl(req) + '/' + token + '/manifest.json' });
});

app.get('/health', function(req, res) {
  res.json({ status: 'ok', version: '1.0.2', redisConnected: !!(redis && redis.status === 'ready'), activeTokens: TOKEN_CACHE.size, cachedSearches: SEARCH_CACHE.size, timestamp: new Date().toISOString() });
});

app.get('/:token/manifest.json', tokenMiddleware, function(req, res) {
  res.json({
    id: 'com.eclipse.youtube.search.' + req.params.token.slice(0, 8),
    name: 'YouTube Search',
    version: '1.0.2',
    description: 'YouTube Data API search addon for Eclipse. Returns tracks, albums, artists, and playlists.',
    icon: 'https://upload.wikimedia.org/wikipedia/commons/e/ef/Youtube_logo.png',
    resources: ['search', 'stream', 'catalog'],
    types: ['track', 'album', 'artist', 'playlist']
  });
});

app.get('/:token/search', tokenMiddleware, async function(req, res) {
  const q = cleanText(req.query.q || '');
  if (!q) return res.json({ tracks: [], albums: [], artists: [], playlists: [] });
  try {
    const data = await youtubeSearch(req.tokenEntry.ytApiKey, q);
    res.json(data);
  } catch(e) {
    console.error('[search]', e.message);
    res.status(500).json({ error: 'Search failed: ' + e.message, tracks: [], albums: [], artists: [], playlists: [] });
  }
});

app.get('/:token/stream/:id', tokenMiddleware, async function(req, res) {
  const id = String(req.params.id || '');
  if (!id.startsWith('ytvid_')) return res.status(404).json({ error: 'Track not found.' });

  const videoId = id.replace('ytvid_', '');

  const cached = STREAM_CACHE.get(videoId);
  if (cached && Date.now() < cached.expiresAt - 300000) {
    console.log('[stream] serve from cache', videoId, cached.url);
    return res.json(cached);
  }

  const result = await resolveAudioViaInvidious(videoId);
  if (!result) {
    console.error('[stream] no stream URL for', videoId);
    return res.status(502).json({ error: 'Could not resolve audio stream.' });
  }

  STREAM_CACHE.set(videoId, result);
  res.json(result);
});

app.get('/:token/album/:id', tokenMiddleware, async function(req, res) {
  const id = String(req.params.id || '');
  if (!id.startsWith('ytalbum_')) return res.status(404).json({ error: 'Album not found.' });
  const videoId = id.replace('ytalbum_', '');
  try {
    const detail = await getVideoById(req.tokenEntry.ytApiKey, videoId);
    if (!detail) return res.status(404).json({ error: 'Album not found.' });
    const track = mapToTrack(videoId, detail.snippet || {}, detail.contentDetails);
    res.json({
      id, title: track.title, artist: track.artist, artworkURL: track.artworkURL,
      year: String(detail.snippet?.publishedAt || '').slice(0, 4) || null,
      description: cleanText(detail.snippet?.description || '').slice(0, 700),
      trackCount: 1, tracks: [track]
    });
  } catch(e) {
    res.status(500).json({ error: 'Album fetch failed.' });
  }
});

app.get('/:token/artist/:id', tokenMiddleware, async function(req, res) {
  const id = String(req.params.id || '');
  if (!id.startsWith('ytartist_')) return res.status(404).json({ error: 'Artist not found.' });
  const channelId = id.replace('ytartist_', '');
  try {
    const items = await getChannelVideos(req.tokenEntry.ytApiKey, channelId);
    if (!items.length) return res.status(404).json({ error: 'No videos found for this channel.' });
    const topTracks = items.slice(0, 8).map(item => mapToTrack(String(item.id?.videoId || ''), item.snippet || {}));
    const albums = items.slice(0, 8).map(item => ({
      id: 'ytalbum_' + String(item.id?.videoId || ''),
      title: cleanText(item.snippet?.title || ''),
      artist: cleanText(item.snippet?.channelTitle || ''),
      artworkURL: pickArt(item.snippet),
      trackCount: 1,
      year: null
    }));
    res.json({
      id, name: cleanText(items[0].snippet?.channelTitle || 'YouTube'),
      artworkURL: pickArt(items[0].snippet), bio: null, genres: [], topTracks, albums
    });
  } catch(e) {
    res.status(500).json({ error: 'Artist fetch failed.' });
  }
});

app.get('/:token/playlist/:id', tokenMiddleware, async function(req, res) {
  const id = String(req.params.id || '');
  if (!id.startsWith('ytplaylist_')) return res.status(404).json({ error: 'Playlist not found.' });
  const channelId = id.replace('ytplaylist_', '');
  try {
    const items = await getChannelVideos(req.tokenEntry.ytApiKey, channelId);
    if (!items.length) return res.status(404).json({ error: 'No videos found.' });
    const tracks = items.slice(0, 12).map(item => mapToTrack(String(item.id?.videoId || ''), item.snippet || {}));
    res.json({
      id, title: cleanText(items[0].snippet?.channelTitle || 'YouTube') + ' Picks',
      description: 'Top results from this YouTube channel.',
      artworkURL: pickArt(items[0].snippet),
      creator: cleanText(items[0].snippet?.channelTitle || 'YouTube'),
      tracks
    });
  } catch(e) {
    res.status(500).json({ error: 'Playlist fetch failed.' });
  }
});

app.listen(PORT, () => console.log('YouTube Search Addon v1.0.2 on port ' + PORT));
