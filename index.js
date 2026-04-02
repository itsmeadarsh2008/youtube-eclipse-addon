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
const IP_CREATES = new Map();
const MAX_TOKENS_PER_IP = 10;
const RATE_MAX = 80;
const RATE_WINDOW_MS = 60000;
const SOURCE_TIMEOUT_MS = 10000;
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

function generateToken() { return crypto.randomBytes(14).toString('hex'); }
function cleanText(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
function getBaseUrl(req) { return (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.get('host'); }
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

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
    .replace(/&/g,' and ').replace(/\(.*?\)/g,' ').replace(/\[.*?\]/g,' ')
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
    format: 'youtube',
    sourceURL: 'https://www.youtube.com/watch?v=' + videoId
  };
}

async function youtubeSearch(apiKey, q) {
  const cacheKey = apiKey.slice(-8) + '|' + q.toLowerCase();
  const cached = SEARCH_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < 5 * 60 * 1000) return cached.data;

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
  SEARCH_CACHE.set(cacheKey, { ts: Date.now(), data: out });
  return out;
}

async function getVideoById(apiKey, videoId) {
  const key = 'v:' + videoId;
  const cached = DETAIL_CACHE.get(key);
  if (cached && Date.now() - cached.ts < 30 * 60 * 1000) return cached.data;
  try {
    const data = await fetchYT('https://www.googleapis.com/youtube/v3/videos', {
      part: 'contentDetails,snippet', id: videoId, key: apiKey
    });
    const item = Array.isArray(data.items) ? data.items[0] : null;
    DETAIL_CACHE.set(key, { ts: Date.now(), data: item || null });
    return item || null;
  } catch(e) { return null; }
}

async function getChannelVideos(apiKey, channelId) {
  const key = 'ch:' + channelId;
  const cached = DETAIL_CACHE.get(key);
  if (cached && Date.now() - cached.ts < 10 * 60 * 1000) return cached.data;
  try {
    const data = await fetchYT('https://www.googleapis.com/youtube/v3/search', {
      part: 'snippet', channelId, type: 'video', maxResults: 12, order: 'relevance', key: apiKey
    });
    const items = Array.isArray(data.items) ? data.items : [];
    DETAIL_CACHE.set(key, { ts: Date.now(), data: items });
    return items;
  } catch(e) { return []; }
}

// ─── Config page (clean template literal, no escaping hell) ──────────────────
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
.logo-wrap{display:flex;align-items:center;gap:14px;margin-bottom:28px}
.logo-text{font-size:26px;font-weight:800;color:#c8a53a;letter-spacing:-.02em}
.logo-sub{font-size:13px;color:#554e3a;margin-top:3px}
.card{background:#131109;border:1px solid #2a2310;border-radius:18px;padding:36px;max-width:540px;width:100%;box-shadow:0 24px 64px rgba(0,0,0,.6);margin-bottom:20px}
h2{font-size:16px;font-weight:700;margin-bottom:14px;color:#fff}
p.sub{font-size:14px;color:#6a6457;margin-bottom:20px;line-height:1.6}
.stat-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:20px}
.stat{background:#110e06;border:1px solid #2a2000;border-radius:10px;padding:14px;text-align:center}
.stat-n{font-size:22px;font-weight:800;color:#c8a53a}.stat-l{font-size:11px;color:#554e3a;margin-top:3px}
.pills{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:24px}
.pill{border-radius:20px;font-size:11px;font-weight:600;padding:4px 10px;background:#1a1400;color:#c8a53a;border:1px solid #3a2e08}
.pill.g{background:#0a1a0a;color:#6db86d;border-color:#2d422a}
.lbl{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#554e3a;margin-bottom:8px;margin-top:16px}
input,textarea{width:100%;background:#0c0a06;border:1px solid #2a2000;border-radius:10px;color:#e8e4de;font-size:14px;padding:12px 14px;margin-bottom:6px;outline:none;transition:border-color .15s}
input:focus,textarea:focus{border-color:#c8a53a}
input::placeholder,textarea::placeholder{color:#2a2416}
.hint{font-size:12px;color:#484030;margin-bottom:12px;line-height:1.7}
.hint code{background:#1a1400;padding:1px 5px;border-radius:4px;color:#6a5a28}
button{cursor:pointer;border:none;border-radius:10px;font-size:15px;font-weight:700;padding:13px;width:100%;margin-top:6px;margin-bottom:12px;transition:background .15s}
.bo{background:#c8a53a;color:#0c0a00}.bo:hover{background:#e0bc50}.bo:disabled{background:#252014;color:#444;cursor:not-allowed}
.bg{background:#1a2a14;color:#e8e4de;border:1px solid #3a5020}.bg:hover{background:#243a1a}.bg:disabled{background:#1a1a14;color:#444;cursor:not-allowed}
.bd{background:#1a1a14;color:#aaa;border:1px solid #2a2a18;font-size:13px;padding:10px}.bd:hover{background:#222218;color:#fff}
.box{display:none;background:#0c0a06;border:1px solid #2a2000;border-radius:12px;padding:18px;margin-bottom:14px}
.blbl{font-size:10px;color:#554e3a;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px}
.burl{font-size:12px;color:#c8a53a;word-break:break-all;font-family:"SF Mono",ui-monospace,monospace;margin-bottom:14px;line-height:1.5}
.status{font-size:13px;color:#6a5a28;margin:8px 0;min-height:18px}
.status.ok{color:#6db86d}.status.err{color:#c0392b}.status.spin{color:#c8a53a}
.preview{background:#0c0a06;border:1px solid #1a1600;border-radius:10px;padding:12px;max-height:220px;overflow-y:auto;margin-bottom:12px;display:none}
.tr{display:flex;gap:10px;align-items:center;padding:6px 0;border-bottom:1px solid #181200;font-size:13px}
.tr:last-child{border-bottom:none}.tn{color:#444;font-size:11px;min-width:22px;text-align:right}
.ti{flex:1;min-width:0}.tt{color:#e8e4de;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ta{color:#666;font-size:11px}
hr{border:none;border-top:1px solid #1a1600;margin:24px 0}
footer{margin-top:32px;font-size:12px;color:#3a3020;text-align:center;line-height:1.8}
footer a{color:#3a3020;text-decoration:none}
</style>
</head>
<body>

<div class="logo-wrap">
  <svg width="52" height="52" viewBox="0 0 52 52" fill="none">
    <circle cx="26" cy="26" r="26" fill="#1a1400"/>
    <rect x="10" y="32" width="32" height="4" rx="2" fill="#c8a53a"/>
    <rect x="14" y="26" width="24" height="4" rx="2" fill="#c8a53a" opacity=".7"/>
    <rect x="18" y="20" width="16" height="4" rx="2" fill="#c8a53a" opacity=".45"/>
    <rect x="22" y="14" width="8" height="4" rx="2" fill="#c8a53a" opacity=".25"/>
  </svg>
  <div>
    <div class="logo-text">YouTube Search</div>
    <div class="logo-sub">Eclipse Addon &mdash; Render Ready</div>
  </div>
</div>

<div class="card">
  <div class="stat-grid">
    <div class="stat"><div class="stat-n">API</div><div class="stat-l">Official only</div></div>
    <div class="stat"><div class="stat-n">0</div><div class="stat-l">Bot bypasses</div></div>
    <div class="stat"><div class="stat-n">User key</div><div class="stat-l">Own quota</div></div>
  </div>
  <p class="sub">Uses the official YouTube Data API v3 — no scraping, no bot bypass, no datacenter blocks. Each user provides their own free API key.</p>
  <div class="pills">
    <span class="pill">Tracks</span>
    <span class="pill">Albums</span>
    <span class="pill">Artists</span>
    <span class="pill">Playlists</span>
    <span class="pill g">No scraper</span>
    <span class="pill g">Render-safe</span>
  </div>

  <div class="lbl">YouTube Data API v3 Key</div>
  <input type="text" id="ytKey" placeholder="Paste your YouTube API key (AIzaSy...)">
  <div class="hint">
    Get a free key at <code>console.cloud.google.com</code> &rarr; Create Project &rarr; Enable <code>YouTube Data API v3</code> &rarr; Credentials &rarr; Create API Key.
  </div>

  <button class="bo" id="genBtn">Generate My Addon URL</button>

  <div class="box" id="genBox">
    <div class="blbl">Your addon URL &mdash; paste into Eclipse</div>
    <div class="burl" id="genUrl"></div>
    <button class="bd" id="copyBtn">Copy URL</button>
  </div>
  <div class="status" id="genStatus"></div>

  <hr>
  <h2>Export Search to CSV</h2>
  <p class="sub">Test what the addon returns for any query and download the results as a CSV.</p>

  <div class="lbl">Your Addon URL</div>
  <input type="text" id="expToken" placeholder="Paste your generated addon URL here">

  <div class="lbl">Search Query</div>
  <input type="text" id="expQuery" placeholder="e.g. Drake Gods Plan">

  <div class="status" id="expStatus"></div>
  <div class="preview" id="expPreview"></div>
  <button class="bg" id="expBtn">Fetch &amp; Download CSV</button>
</div>

<footer>
  YouTube Search Addon v1.0.0 &bull; Render-ready &bull;
  <a href="${baseUrl}/health" target="_blank" rel="noopener noreferrer">Health</a>
</footer>

<script>
var addonUrl = '';

document.getElementById('genBtn').addEventListener('click', function() {
  var btn = document.getElementById('genBtn');
  var st = document.getElementById('genStatus');
  var key = document.getElementById('ytKey').value.trim();

  if (!key) {
    st.className = 'status err';
    st.textContent = 'Paste your YouTube API key first.';
    return;
  }
  if (!key.startsWith('AIza')) {
    st.className = 'status err';
    st.textContent = 'That does not look like a YouTube API key (should start with AIza).';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Validating key...';
  st.className = 'status spin';
  st.textContent = 'Checking your API key with YouTube...';

  fetch('/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ytApiKey: key })
  })
  .then(function(r) { return r.json(); })
  .then(function(d) {
    if (d.error) {
      st.className = 'status err';
      st.textContent = d.error;
      btn.disabled = false;
      btn.textContent = 'Generate My Addon URL';
      return;
    }
    addonUrl = d.manifestUrl;
    document.getElementById('genUrl').textContent = addonUrl;
    document.getElementById('genBox').style.display = 'block';
    document.getElementById('expToken').value = addonUrl;
    st.className = 'status ok';
    st.textContent = '\u2713 Your addon URL is ready';
    btn.disabled = false;
    btn.textContent = 'Regenerate URL';
  })
  .catch(function(e) {
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

  if (!raw) { st.className = 'status err'; st.textContent = 'Paste your addon URL first.'; return; }
  if (!q) { st.className = 'status err'; st.textContent = 'Enter a search query.'; return; }

  var tokMatch = raw.match(/\/([a-f0-9]{28})\//i);
  if (!tokMatch) { st.className = 'status err'; st.textContent = 'Could not find token in your URL.'; return; }
  var tok = tokMatch[1];

  btn.disabled = true;
  btn.textContent = 'Fetching...';
  st.className = 'status spin';
  st.textContent = 'Searching...';
  pv.style.display = 'none';

  fetch('/' + tok + '/search?q=' + encodeURIComponent(q))
  .then(function(r) {
    if (!r.ok) return r.json().then(function(e) { throw new Error(e.error || 'Server error ' + r.status); });
    return r.json();
  })
  .then(function(data) {
    var tracks = data.tracks || [];
    if (!tracks.length) throw new Error('No tracks found for that query.');

    var rows = tracks.slice(0, 60).map(function(t, i) {
      return '<div class="tr"><span class="tn">' + (i+1) + '</span><div class="ti"><div class="tt">' +
        t.title.replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</div><div class="ta">' +
        t.artist.replace(/</g,'&lt;').replace(/>/g,'&gt;') +
        (t.duration ? ' \u00b7 ' + Math.floor(t.duration/60) + 'm' : '') + '</div></div></div>';
    }).join('');
    if (tracks.length > 60) rows += '<div class="tr" style="text-align:center;color:#555">' + (tracks.length - 60) + ' more rows</div>';
    pv.innerHTML = rows;
    pv.style.display = 'block';
    st.className = 'status ok';
    st.textContent = 'Found ' + tracks.length + ' tracks';

    var csv = ['Title,Artist,Album,Duration,SourceURL'];
    tracks.forEach(function(t) {
      function ce(s) { s = String(s||''); if(s.includes(',') || s.includes('"') || s.includes('\n')) return '"' + s.replace(/"/g,'""') + '"'; return s; }
      csv.push([ce(t.title), ce(t.artist), ce(t.album), ce(t.duration||''), ce(t.sourceURL||'')].join(','));
    });
    var blob = new Blob([csv.join('\n')], { type: 'text/csv' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = q.replace(/[^a-zA-Z0-9 -]/g, '').trim() + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    btn.disabled = false;
    btn.textContent = 'Fetch & Download CSV';
  })
  .catch(function(e) {
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

// ─── Routes ──────────────────────────────────────────────────────────────────

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
  res.json({
    status: 'ok', version: '1.0.1',
    redisConnected: !!(redis && redis.status === 'ready'),
    activeTokens: TOKEN_CACHE.size,
    cachedSearches: SEARCH_CACHE.size,
    timestamp: new Date().toISOString()
  });
});

app.get('/:token/manifest.json', tokenMiddleware, function(req, res) {
  res.json({
    id: 'com.eclipse.youtube.search.' + req.params.token.slice(0, 8),
    name: 'YouTube Search',
    version: '1.0.1',
    description: 'YouTube Data API search addon for Eclipse. Returns tracks, albums, artists and playlists.',
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
  try {
    const detail = await getVideoById(req.tokenEntry.ytApiKey, videoId);
    if (!detail) return res.status(404).json({ error: 'Video not found.' });
    res.json({ url: 'https://www.youtube.com/watch?v=' + videoId, format: 'html', quality: 'YouTube' });
  } catch(e) {
    res.status(500).json({ error: 'Stream resolution failed.' });
  }
});

app.get('/:token/album/:id', tokenMiddleware, async function(req, res) {
  const id = String(req.params.id || '');
  if (!id.startsWith('ytalbum_')) return res.status(404).json({ error: 'Album not found.' });
  const videoId = id.replace('ytalbum_', '');
  try {
    const detail = await getVideoById(req.tokenEntry.ytApiKey, videoId);
    if (!detail) return res.status(404).json({ error: 'Video not found.' });
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
      artworkURL: pickArt(item.snippet), trackCount: 1, year: null
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

app.listen(PORT, () => console.log('YouTube Search Addon v1.0.1 on port ' + PORT));
