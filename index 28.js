const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const Redis = require('ioredis');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

let redis = null;
if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 3, enableReadyCheck: false });
  redis.on('connect', () => console.log('[Redis] Connected'));
  redis.on('error', e => console.error('[Redis]', e.message));
}

async function redisSave(token, entry) {
  if (!redis) return;
  try {
    await redis.set('ytaddon:token:' + token, JSON.stringify({
      createdAt: entry.createdAt,
      lastUsed: entry.lastUsed,
      reqCount: entry.reqCount,
      ytApiKey: entry.ytApiKey || null
    }));
  } catch (e) {
    console.error('[Redis] Save failed:', e.message);
  }
}

async function redisLoad(token) {
  if (!redis) return null;
  try {
    const d = await redis.get('ytaddon:token:' + token);
    return d ? JSON.parse(d) : null;
  } catch (e) {
    return null;
  }
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
function normalizeLoose(s) {
  return cleanText(String(s || '').toLowerCase())
    .replace(/&/g, ' and ')
    .replace(/\(.*?\)/g, ' ')
    .replace(/\[.*?\]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(official|video|audio|lyrics|lyric|hd|4k|visualizer|visualiser|remastered|topic|live|feat|ft|prod)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function tokenizeLoose(s) { return normalizeLoose(s).split(/\s+/).filter(Boolean); }
function overlapScore(query, text) {
  const qWords = tokenizeLoose(query);
  const tWords = new Set(tokenizeLoose(text));
  if (!qWords.length) return 0;
  let hit = 0;
  for (const w of qWords) if (tWords.has(w)) hit++;
  return hit / qWords.length;
}
function parseISODuration(iso) {
  const m = String(iso || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return null;
  const h = parseInt(m[1] || 0, 10);
  const min = parseInt(m[2] || 0, 10);
  const sec = parseInt(m[3] || 0, 10);
  const total = h * 3600 + min * 60 + sec;
  return total > 0 ? total : null;
}
function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function getOrCreateIpBucket(ip) {
  const now = Date.now();
  let b = IP_CREATES.get(ip);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + 86400000 };
    IP_CREATES.set(ip, b);
  }
  return b;
}
async function getTokenEntry(token) {
  if (TOKEN_CACHE.has(token)) return TOKEN_CACHE.get(token);
  const saved = await redisLoad(token);
  if (!saved) return null;
  const entry = {
    createdAt: saved.createdAt,
    lastUsed: saved.lastUsed,
    reqCount: saved.reqCount,
    rateWin: [],
    ytApiKey: saved.ytApiKey || null
  };
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
async function fetchWithTimeout(url, opts = {}, timeout = SOURCE_TIMEOUT_MS) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout);
  try {
    return await axios.get(url, {
      ...opts,
      signal: controller.signal,
      timeout,
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json',
        ...(opts.headers || {})
      }
    });
  } finally {
    clearTimeout(t);
  }
}
async function validateYouTubeKey(key) {
  try {
    const r = await fetchWithTimeout('https://www.googleapis.com/youtube/v3/search', {
      params: { part: 'snippet', q: 'test', type: 'video', maxResults: 1, key }
    }, 8000);
    return Array.isArray((r.data || {}).items);
  } catch (e) {
    return false;
  }
}
function scoreVideo(query, title, channel, description) {
  const q = normalizeLoose(query);
  const t = normalizeLoose(title);
  const c = normalizeLoose(channel);
  const d = normalizeLoose(description);
  const words = tokenizeLoose(query);
  let score = 0;
  if (!q || !t) return 0;
  if (t === q) score += 180;
  if (t.startsWith(q)) score += 70;
  if (t.includes(q)) score += 45;
  for (const w of words) {
    if (t.includes(w)) score += 14;
    else if (c.includes(w)) score += 6;
    else if (d.includes(w)) score += 2;
    else score -= 6;
  }
  const ov = overlapScore(query, [title, channel, description].join(' '));
  score += Math.round(ov * 70);
  if (/\b(full album|playlist|mix|compilation|slowed|reverb|nightcore|sped up|8d|reaction|review|interview|podcast|trailer)\b/i.test(title + ' ' + description)) score -= 60;
  if (/\b(official audio|official video|audio|lyrics?|visualizer|visualiser|topic)\b/i.test(title)) score += 20;
  return score;
}
function pickArtwork(snippet) {
  return (snippet.thumbnails?.high?.url || snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url || null);
}
function mapVideoToTrack(video, detail) {
  const id = String(video.id?.videoId || detail?.id || '');
  const snippet = video.snippet || detail?.snippet || {};
  const duration = parseISODuration(detail?.contentDetails?.duration);
  const title = cleanText(snippet.title || 'YouTube Video');
  const artist = cleanText(snippet.channelTitle || 'YouTube');
  return {
    id: 'ytvid_' + id,
    title,
    artist,
    album: 'YouTube',
    duration,
    artworkURL: pickArtwork(snippet),
    format: 'youtube',
    sourceURL: 'https://www.youtube.com/watch?v=' + id
  };
}
function mapVideoToAlbum(video, detail) {
  const t = mapVideoToTrack(video, detail);
  return {
    id: 'ytalbum_' + t.id.replace(/^ytvid_/, ''),
    title: t.title,
    artist: t.artist,
    artworkURL: t.artworkURL,
    trackCount: 1,
    year: cleanText((detail?.snippet?.publishedAt || video.snippet?.publishedAt || '')).slice(0, 4) || null
  };
}
function mapVideoToArtist(video) {
  const snippet = video.snippet || {};
  const cid = String(snippet.channelId || '');
  return {
    id: 'ytartist_' + cid,
    name: cleanText(snippet.channelTitle || 'YouTube'),
    artworkURL: pickArtwork(snippet),
    genres: []
  };
}
function mapVideoToPlaylist(video) {
  const snippet = video.snippet || {};
  return {
    id: 'ytplaylist_' + String(snippet.channelId || ''),
    title: cleanText((snippet.channelTitle || 'YouTube') + ' Picks'),
    creator: cleanText(snippet.channelTitle || 'YouTube'),
    artworkURL: pickArtwork(snippet),
    trackCount: null,
    description: 'Top matching videos from this channel.'
  };
}
async function youtubeSearch(apiKey, q) {
  const key = apiKey + '|' + q.toLowerCase();
  const cached = SEARCH_CACHE.get(key);
  if (cached && Date.now() - cached.ts < 5 * 60 * 1000) return cached.data;

  const searchResp = await fetchWithTimeout('https://www.googleapis.com/youtube/v3/search', {
    params: {
      part: 'snippet',
      q,
      type: 'video',
      maxResults: 20,
      safeSearch: 'none',
      key: apiKey
    }
  });

  const items = Array.isArray(searchResp.data?.items) ? searchResp.data.items : [];
  const ids = items.map(x => x.id?.videoId).filter(Boolean).join(',');
  let detailMap = new Map();
  if (ids) {
    try {
      const detailsResp = await fetchWithTimeout('https://www.googleapis.com/youtube/v3/videos', {
        params: {
          part: 'contentDetails,snippet,statistics',
          id: ids,
          key: apiKey
        }
      });
      const details = Array.isArray(detailsResp.data?.items) ? detailsResp.data.items : [];
      detailMap = new Map(details.map(d => [String(d.id), d]));
    } catch (e) {}
  }

  const ranked = items.map(item => {
    const detail = detailMap.get(String(item.id?.videoId || ''));
    const score = scoreVideo(q, item.snippet?.title || '', item.snippet?.channelTitle || '', item.snippet?.description || '');
    return { item, detail, score };
  }).filter(x => x.score >= 35)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);

  const tracks = ranked.map(x => mapVideoToTrack(x.item, x.detail));
  const albums = ranked.slice(0, 8).map(x => mapVideoToAlbum(x.item, x.detail));
  const artists = [];
  const playlists = [];
  const seenArtists = new Set();
  const seenPlaylists = new Set();
  for (const x of ranked) {
    const a = mapVideoToArtist(x.item);
    if (a.id && !seenArtists.has(a.id)) {
      seenArtists.add(a.id);
      artists.push(a);
    }
    const p = mapVideoToPlaylist(x.item);
    if (p.id && !seenPlaylists.has(p.id)) {
      seenPlaylists.add(p.id);
      playlists.push(p);
    }
  }

  const out = { tracks, albums, artists: artists.slice(0, 8), playlists: playlists.slice(0, 8) };
  SEARCH_CACHE.set(key, { ts: Date.now(), data: out });
  return out;
}
async function getVideoById(apiKey, videoId) {
  const key = 'video:' + apiKey + ':' + videoId;
  const cached = DETAIL_CACHE.get(key);
  if (cached && Date.now() - cached.ts < 30 * 60 * 1000) return cached.data;
  const r = await fetchWithTimeout('https://www.googleapis.com/youtube/v3/videos', {
    params: {
      part: 'contentDetails,snippet,statistics',
      id: videoId,
      key: apiKey
    }
  });
  const item = Array.isArray(r.data?.items) ? r.data.items[0] : null;
  DETAIL_CACHE.set(key, { ts: Date.now(), data: item || null });
  return item || null;
}
async function getChannelVideos(apiKey, channelId, q = '') {
  const key = 'channel:' + apiKey + ':' + channelId + ':' + q.toLowerCase();
  const cached = DETAIL_CACHE.get(key);
  if (cached && Date.now() - cached.ts < 10 * 60 * 1000) return cached.data;
  const r = await fetchWithTimeout('https://www.googleapis.com/youtube/v3/search', {
    params: {
      part: 'snippet',
      channelId,
      type: 'video',
      maxResults: 12,
      order: 'relevance',
      q: q || '',
      key: apiKey
    }
  });
  const items = Array.isArray(r.data?.items) ? r.data.items : [];
  DETAIL_CACHE.set(key, { ts: Date.now(), data: items });
  return items;
}
function buildConfigPage(baseUrl) {
  let h = '';
  h += '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">';
  h += '<meta name="viewport" content="width=device-width,initial-scale=1">';
  h += '<title>YouTube Search Addon</title>';
  h += '<style>';
  h += '*{box-sizing:border-box;margin:0;padding:0}';
  h += 'body{background:#0c0a08;color:#e8e4de;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:48px 20px 64px}';
  h += '.logo-wrap{display:flex;align-items:center;gap:14px;margin-bottom:28px}.logo-text{font-size:26px;font-weight:800;color:#c8a53a;letter-spacing:-.02em}.logo-sub{font-size:13px;color:#554e3a;margin-top:3px}';
  h += '.card{background:#131109;border:1px solid #2a2310;border-radius:18px;padding:36px;max-width:540px;width:100%;box-shadow:0 24px 64px rgba(0,0,0,.6);margin-bottom:20px}';
  h += 'h2{font-size:16px;font-weight:700;margin-bottom:14px;color:#fff}p.sub{font-size:14px;color:#6a6457;margin-bottom:20px;line-height:1.6}';
  h += '.stat-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:20px}.stat{background:#110e06;border:1px solid #2a2000;border-radius:10px;padding:14px;text-align:center}.stat-n{font-size:22px;font-weight:800;color:#c8a53a}.stat-l{font-size:11px;color:#554e3a;margin-top:3px}';
  h += '.pills{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:24px}.pill{border-radius:20px;font-size:11px;font-weight:600;padding:4px 10px;background:#1a1400;color:#c8a53a;border:1px solid #3a2e08}.pill.g{background:#0a1a0a;color:#6db86d;border-color:#2d422a}';
  h += '.lbl{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#554e3a;margin-bottom:8px;margin-top:16px}';
  h += 'input{width:100%;background:#0c0a06;border:1px solid #2a2000;border-radius:10px;color:#e8e4de;font-size:14px;padding:12px 14px;margin-bottom:6px;outline:none;transition:border-color .15s}input:focus{border-color:#c8a53a}input::placeholder{color:#2a2416}';
  h += '.hint{font-size:12px;color:#484030;margin-bottom:12px;line-height:1.7}.hint code{background:#1a1400;padding:1px 5px;border-radius:4px;color:#6a5a28}';
  h += 'button{cursor:pointer;border:none;border-radius:10px;font-size:15px;font-weight:700;padding:13px;width:100%;margin-top:6px;margin-bottom:12px;transition:background .15s}';
  h += '.bo{background:#c8a53a;color:#0c0a00}.bo:hover{background:#e0bc50}.bo:disabled{background:#252014;color:#444;cursor:not-allowed}';
  h += '.bg{background:#1a2a14;color:#e8e4de;border:1px solid #3a5020}.bg:hover{background:#243a1a}.bg:disabled{background:#1a1a14;color:#444;cursor:not-allowed}';
  h += '.bd{background:#1a1a14;color:#aaa;border:1px solid #2a2a18;font-size:13px;padding:10px}.bd:hover{background:#222218;color:#fff}';
  h += '.box{display:none;background:#0c0a06;border:1px solid #2a2000;border-radius:12px;padding:18px;margin-bottom:14px}.blbl{font-size:10px;color:#554e3a;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px}.burl{font-size:12px;color:#c8a53a;word-break:break-all;font-family:SF Mono,ui-monospace,monospace;margin-bottom:14px;line-height:1.5}';
  h += '.status{font-size:13px;color:#6a5a28;margin:8px 0;min-height:18px}.status.ok{color:#6db86d}.status.err{color:#c0392b}.status.spin{color:#c8a53a}';
  h += '.preview{background:#0c0a06;border:1px solid #1a1600;border-radius:10px;padding:12px;max-height:220px;overflow-y:auto;margin-bottom:12px;display:none}.tr{display:flex;gap:10px;align-items:center;padding:6px 0;border-bottom:1px solid #181200;font-size:13px}.tr:last-child{border-bottom:none}.tn{color:#444;font-size:11px;min-width:22px;text-align:right}.ti{flex:1;min-width:0}.tt{color:#e8e4de;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ta{color:#666;font-size:11px}';
  h += 'hr{border:none;border-top:1px solid #1a1600;margin:24px 0}footer{margin-top:32px;font-size:12px;color:#3a3020;text-align:center;line-height:1.8}footer a{color:#3a3020;text-decoration:none}';
  h += '</style></head><body>';
  h += '<div class="logo-wrap"><svg width="52" height="52" viewBox="0 0 52 52" fill="none"><circle cx="26" cy="26" r="26" fill="#1a1400"/><rect x="10" y="32" width="32" height="4" rx="2" fill="#c8a53a"/><rect x="14" y="26" width="24" height="4" rx="2" fill="#c8a53a" opacity=".7"/><rect x="18" y="20" width="16" height="4" rx="2" fill="#c8a53a" opacity=".45"/><rect x="22" y="14" width="8" height="4" rx="2" fill="#c8a53a" opacity=".25"/></svg><div><div class="logo-text">YouTube Search</div><div class="logo-sub">Eclipse Addon for Render</div></div></div>';
  h += '<div class="card">';
  h += '<div class="stat-grid"><div class="stat"><div class="stat-n">0</div><div class="stat-l">Bot bypasses</div></div><div class="stat"><div class="stat-n">100%</div><div class="stat-l">API-based</div></div><div class="stat"><div class="stat-n">User key</div><div class="stat-l">Own quota</div></div></div>';
  h += '<p class="sub">This addon uses the official YouTube Data API for search metadata only. It avoids datacenter stream scraping, cookies, bot bypasses, and extractor tricks. Your users generate their own tokenized addon URL with their own YouTube API key.</p>';
  h += '<div class="pills"><span class="pill">Tracks</span><span class="pill">Albums</span><span class="pill">Artists</span><span class="pill">Playlists</span><span class="pill g">No scraper</span><span class="pill g">Render-safe</span></div>';
  h += '<div class="lbl">YouTube Data API Key</div><input type="text" id="ytKey" placeholder="Paste your YouTube API key">';
  h += '<div class="hint">Create one in <code>Google Cloud Console</code>, enable <code>YouTube Data API v3</code>, then paste the key here. This addon uses the key only for official search/detail requests.</div>';
  h += '<button class="bo" id="genBtn" onclick="generate()">Generate My Addon URL</button>';
  h += '<div class="box" id="genBox"><div class="blbl">Your addon URL — paste into Eclipse</div><div class="burl" id="genUrl"></div><button class="bd" id="copyBtn" onclick="copyUrl()">Copy URL</button></div>';
  h += '<div class="status" id="genStatus"></div>';
  h += '<hr>';
  h += '<h2>Export Search to CSV</h2><p class="sub">Quick test tool for GitHub + Render. Search videos, inspect what the addon returns, then export rows to CSV for debugging.</p>';
  h += '<div class="lbl">Your Addon URL</div><input type="text" id="expToken" placeholder="Paste your generated addon URL here">';
  h += '<div class="lbl">Search Query</div><input type="text" id="expQuery" placeholder="Drake Gods Plan">';
  h += '<div class="status" id="expStatus"></div><div class="preview" id="expPreview"></div><button class="bg" id="expBtn" onclick="doExport()">Fetch & Download CSV</button>';
  h += '</div>';
  h += '<footer>YouTube Search Addon v1.0.0 • Render-ready • API metadata only • <a href="' + baseUrl + '/health" target="_blank" rel="noopener noreferrer">Health</a></footer>';
  h += '<script>';
  h += 'var gu="";';
  h += 'function getTok(s){var m=String(s||"").match(/\/([a-f0-9]{28})\//i);return m?m[1]:null}';
  h += 'function csvEsc(s){s=String(s||"");if(s.includes(",")||s.includes("\"")||s.includes("\n"))return "\""+s.replace(/\"/g,"\"\"")+"\"";return s}';
  h += 'function hesc(s){return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}';
  h += 'function copyUrl(){if(!gu)return;navigator.clipboard.writeText(gu).then(function(){var b=document.getElementById("copyBtn");b.textContent="Copied!";setTimeout(function(){b.textContent="Copy URL"},1500)})}';
  h += 'function generate(){var btn=document.getElementById("genBtn"),st=document.getElementById("genStatus"),key=document.getElementById("ytKey").value.trim();if(!key){st.className="status err";st.textContent="Paste your YouTube API key first.";return}btn.disabled=true;btn.textContent="Generating...";st.className="status spin";st.textContent="Validating API key...";fetch("/generate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({ytApiKey:key})}).then(function(r){return r.json()}).then(function(d){if(d.error){st.className="status err";st.textContent=d.error;btn.disabled=false;btn.textContent="Generate My Addon URL";return}gu=d.manifestUrl;document.getElementById("genUrl").textContent=gu;document.getElementById("genBox").style.display="block";document.getElementById("expToken").value=gu;st.className="status ok";st.textContent="✓ Your addon URL is ready";btn.disabled=false;btn.textContent="Regenerate URL"}).catch(function(e){st.className="status err";st.textContent="Error: "+e.message;btn.disabled=false;btn.textContent="Generate My Addon URL"})}';
  h += 'function doExport(){var btn=document.getElementById("expBtn"),raw=document.getElementById("expToken").value.trim(),q=document.getElementById("expQuery").value.trim(),st=document.getElementById("expStatus"),pv=document.getElementById("expPreview");if(!raw){st.className="status err";st.textContent="Paste your addon URL first.";return}if(!q){st.className="status err";st.textContent="Enter a search query.";return}var tok=getTok(raw);if(!tok){st.className="status err";st.textContent="Could not find your token in the URL.";return}btn.disabled=true;btn.textContent="Fetching...";st.className="status spin";st.textContent="Searching...";pv.style.display="none";fetch("/"+tok+"/search?q="+encodeURIComponent(q)).then(function(r){if(!r.ok)return r.json().then(function(e){throw new Error(e.error||("Server error "+r.status))});return r.json()}).then(function(data){var tracks=data.tracks||[];var rows=tracks.slice(0,60).map(function(t,i){return "<div class=tr><span class=tn>"+(i+1)+"</span><div class=ti><div class=tt>"+hesc(t.title)+"</div><div class=ta>"+hesc(t.artist)+(t.duration?" · "+Math.floor(t.duration/60)+"m":"")+"</div></div></div>"}).join("");if(!tracks.length)throw new Error("No tracks found.");if(tracks.length>60)rows += "<div class=tr style=text-align:center;color:#555>"+(tracks.length-60)+" more rows</div>";pv.innerHTML=rows;pv.style.display="block";st.className="status ok";st.textContent="Found "+tracks.length+" tracks";var lines=["Title,Artist,Album,Duration,SourceURL"];tracks.forEach(function(t){lines.push([csvEsc(t.title),csvEsc(t.artist),csvEsc(t.album),csvEsc(t.duration||""),csvEsc(t.sourceURL||"")].join(","))});var blob=new Blob([lines.join("\n")],{type:"text/csv"});var a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=q.replace(/[^a-zA-Z0-9 -]/g,"").trim()+".csv";document.body.appendChild(a);a.click();document.body.removeChild(a);btn.disabled=false;btn.textContent="Fetch & Download CSV"}).catch(function(e){st.className="status err";st.textContent=e.message;btn.disabled=false;btn.textContent="Fetch & Download CSV"})}';
  h += '</script></body></html>';
  return h;
}

app.get('/', function(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildConfigPage(getBaseUrl(req)));
});

app.post('/generate', async function(req, res) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  const bucket = getOrCreateIpBucket(ip);
  if (bucket.count >= MAX_TOKENS_PER_IP) return res.status(429).json({ error: 'Too many tokens today from this IP.' });
  const ytApiKey = cleanText(req.body && req.body.ytApiKey);
  if (!ytApiKey) return res.status(400).json({ error: 'Paste your YouTube API key.' });
  const valid = await validateYouTubeKey(ytApiKey);
  if (!valid) return res.status(401).json({ error: 'Invalid YouTube API key. Enable YouTube Data API v3 and try again.' });
  const token = generateToken();
  const entry = { createdAt: Date.now(), lastUsed: Date.now(), reqCount: 0, rateWin: [], ytApiKey };
  TOKEN_CACHE.set(token, entry);
  await redisSave(token, entry);
  bucket.count++;
  return res.json({ token, manifestUrl: getBaseUrl(req) + '/' + token + '/manifest.json' });
});

app.get('/health', function(req, res) {
  res.json({
    status: 'ok',
    version: '1.0.0',
    redisConnected: !!(redis && redis.status === 'ready'),
    activeTokens: TOKEN_CACHE.size,
    cachedSearches: SEARCH_CACHE.size,
    cachedDetails: DETAIL_CACHE.size,
    timestamp: new Date().toISOString()
  });
});

app.get('/:token/manifest.json', tokenMiddleware, function(req, res) {
  res.json({
    id: 'com.eclipse.youtube.search.' + req.params.token.slice(0, 8),
    name: 'YouTube Search Addon',
    version: '1.0.0',
    description: 'Official YouTube Data API metadata addon for Eclipse. Searches tracks, albums, artists, and playlists without server-side bot bypassing.',
    icon: 'https://upload.wikimedia.org/wikipedia/commons/e/ef/Youtube_logo.png',
    resources: ['search', 'stream', 'catalog'],
    types: ['track', 'album', 'artist', 'playlist']
  });
});

app.get('/:token/search', tokenMiddleware, async function(req, res) {
  const q = cleanText(req.query.q);
  if (!q) return res.json({ tracks: [], albums: [], artists: [], playlists: [] });
  try {
    const data = await youtubeSearch(req.tokenEntry.ytApiKey, q);
    res.json(data);
  } catch (e) {
    console.error('[search]', e.message);
    res.status(500).json({ error: 'Search failed.', tracks: [], albums: [], artists: [], playlists: [] });
  }
});

app.get('/:token/stream/:id', tokenMiddleware, async function(req, res) {
  const id = String(req.params.id || '');
  if (!id.startsWith('ytvid_')) return res.status(404).json({ error: 'Track not found.' });
  const videoId = id.replace('ytvid_', '');
  try {
    const detail = await getVideoById(req.tokenEntry.ytApiKey, videoId);
    if (!detail) return res.status(404).json({ error: 'Video not found.' });
    return res.json({
      url: 'https://www.youtube.com/watch?v=' + videoId,
      format: 'html',
      quality: 'YouTube watch URL'
    });
  } catch (e) {
    return res.status(500).json({ error: 'Stream resolution failed.' });
  }
});

app.get('/:token/album/:id', tokenMiddleware, async function(req, res) {
  const id = String(req.params.id || '');
  if (!id.startsWith('ytalbum_')) return res.status(404).json({ error: 'Album not found.' });
  const videoId = id.replace('ytalbum_', '');
  try {
    const detail = await getVideoById(req.tokenEntry.ytApiKey, videoId);
    if (!detail) return res.status(404).json({ error: 'Album not found.' });
    const track = mapVideoToTrack({ snippet: detail.snippet, id: { videoId } }, detail);
    return res.json({
      id,
      title: track.title,
      artist: track.artist,
      artworkURL: track.artworkURL,
      year: cleanText(detail.snippet?.publishedAt || '').slice(0, 4) || null,
      description: cleanText(detail.snippet?.description || '').slice(0, 700),
      trackCount: 1,
      tracks: [track]
    });
  } catch (e) {
    return res.status(500).json({ error: 'Album fetch failed.' });
  }
});

app.get('/:token/artist/:id', tokenMiddleware, async function(req, res) {
  const id = String(req.params.id || '');
  if (!id.startsWith('ytartist_')) return res.status(404).json({ error: 'Artist not found.' });
  const channelId = id.replace('ytartist_', '');
  try {
    const items = await getChannelVideos(req.tokenEntry.ytApiKey, channelId);
    if (!items.length) return res.status(404).json({ error: 'Artist not found.' });
    const topTracks = items.slice(0, 8).map(item => mapVideoToTrack(item));
    const albums = items.slice(0, 8).map(item => mapVideoToAlbum(item));
    return res.json({
      id,
      name: cleanText(items[0].snippet?.channelTitle || 'YouTube'),
      artworkURL: pickArtwork(items[0].snippet || {}),
      bio: 'YouTube channel results for this artist.',
      genres: [],
      topTracks,
      albums
    });
  } catch (e) {
    return res.status(500).json({ error: 'Artist fetch failed.' });
  }
});

app.get('/:token/playlist/:id', tokenMiddleware, async function(req, res) {
  const id = String(req.params.id || '');
  if (!id.startsWith('ytplaylist_')) return res.status(404).json({ error: 'Playlist not found.' });
  const channelId = id.replace('ytplaylist_', '');
  try {
    const items = await getChannelVideos(req.tokenEntry.ytApiKey, channelId);
    if (!items.length) return res.status(404).json({ error: 'Playlist not found.' });
    const tracks = items.slice(0, 12).map(item => mapVideoToTrack(item));
    return res.json({
      id,
      title: cleanText((items[0].snippet?.channelTitle || 'YouTube') + ' Picks'),
      description: 'Top channel matches from YouTube search results.',
      artworkURL: pickArtwork(items[0].snippet || {}),
      creator: cleanText(items[0].snippet?.channelTitle || 'YouTube'),
      tracks
    });
  } catch (e) {
    return res.status(500).json({ error: 'Playlist fetch failed.' });
  }
});

app.listen(PORT, () => console.log('YouTube Search Addon v1.0.0 on port ' + PORT));
