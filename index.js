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

const QUALITY = {
  LOW: 'LOW',
  HIGH: 'HIGH',
  LOSSLESS: 'LOSSLESS',
};

const QUALITY_OPTIONS = [
  { label: 'Low (saves data)', value: QUALITY.LOW },
  { label: 'High', value: QUALITY.HIGH },
  { label: 'Best Available', value: QUALITY.LOSSLESS },
];

const DOWNLOAD_QUALITY_OPTIONS = [
  { label: '128 kbps', value: '128' },
  { label: '320 kbps', value: '320' },
];

const DOWNLOAD_API_BASE = 'https://capi.y2jar.cc/scr/';

function parseDuration(text) {
  if (!text) return 0;
  const parts = text.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

function bestThumbnail(thumbnails) {
  if (!thumbnails || !thumbnails.length) return '';
  return thumbnails.reduce((best, t) => ((t.width || 0) > (best.width || 0) ? t : best)).url;
}

function parseInfoRuns(runs) {
  if (!runs || !runs.length) return { artist: '', album: '' };
  const parts = [];
  let current = '';
  for (const run of runs) {
    if (run.text === ' • ') {
      if (current) parts.push(current.trim());
      current = '';
    } else {
      current += run.text;
    }
  }
  if (current) parts.push(current.trim());
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

async function fetchFreshVisitorData(env) {
  try {
    const resp = await fetch(`${YTM_BASE}/youtubei/v1/visitor_id?key=${YTM_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: { client: WEB_REMIX_CONTEXT } }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const d = await resp.json();
    const visitorData = d?.responseContext?.visitorData || null;
    if (visitorData && env.YTM_CACHE) {
      await env.YTM_CACHE.put(
        'visitorData',
        JSON.stringify({ visitorData, fetchedAt: Date.now() }),
        { expirationTtl: Math.floor(VISITOR_DATA_TTL_MS / 1000) }
      );
    }
    return visitorData;
  } catch (e) {
    console.log(LOG_PREFIX, 'visitorData fetch failed:', e.message);
    return null;
  }
}

async function getVisitorData(env) {
  if (env.YTM_CACHE) {
    const raw = await env.YTM_CACHE.get('visitorData');
    if (raw) {
      try {
        const cached = JSON.parse(raw);
        if (cached.visitorData && Date.now() - cached.fetchedAt < VISITOR_DATA_TTL_MS) {
          return cached.visitorData;
        }
      } catch {}
    }
  }
  return fetchFreshVisitorData(env);
}

async function searchTracks(query, limit = 20, env) {
  const headers = {
    'Content-Type': 'application/json',
    Origin: YTM_BASE,
    Referer: `${YTM_BASE}/`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  };

  const response = await fetch(`${YTM_BASE}/youtubei/v1/search?key=${YTM_API_KEY}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      context: { client: WEB_REMIX_CONTEXT },
      query,
      params: 'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D',
    }),
  });

  if (!response.ok) throw new Error(`${LOG_PREFIX} Search failed: HTTP ${response.status}`);
  const data = await response.json();

  if (data?.responseContext?.visitorData && env.YTM_CACHE) {
    await env.YTM_CACHE.put(
      'visitorData',
      JSON.stringify({ visitorData: data.responseContext.visitorData, fetchedAt: Date.now() }),
      { expirationTtl: Math.floor(VISITOR_DATA_TTL_MS / 1000) }
    );
  }

  const tracks = [];
  const sections = data?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];

  for (const section of sections) {
    const shelf = section.musicShelfRenderer;
    if (!shelf) continue;
    for (const item of shelf.contents || []) {
      if (tracks.length >= limit) break;
      const r = item.musicResponsiveListItemRenderer;
      if (!r) continue;

      const videoId =
        r.playlistItemData?.videoId ||
        r.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId;
      if (!videoId) continue;

      const title = r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.map(t => t.text).join('') || '';
      const infoRuns = r.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
      const info = parseInfoRuns(infoRuns);
      const durationText = r.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text?.runs?.[0]?.text || '';
      const thumbs = r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];

      tracks.push({
        id: videoId,
        title,
        artist: info.artist,
        album: info.album,
        duration: parseDuration(durationText),
        albumCover: bestThumbnail(thumbs),
      });
    }
  }

  return { tracks, total: tracks.length };
}

async function fetchPlayerData(trackId, env) {
  const visitorData = await getVisitorData(env);
  const clientContext = buildIosContext(visitorData);

  const response = await fetch(`${YTM_BASE}/youtubei/v1/player?prettyPrint=false`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'com.google.ios.youtube/20.10.01 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X)',
    },
    body: JSON.stringify({
      context: { client: clientContext },
      videoId: trackId,
      contentCheckOk: true,
      racyCheckOk: true,
    }),
  });

  if (!response.ok) throw new Error(`${LOG_PREFIX} Player HTTP error: ${response.status}`);
  const data = await response.json();
  const status = data?.playabilityStatus?.status;

  if (status !== 'OK') {
    if (env.YTM_CACHE) await env.YTM_CACHE.delete('visitorData');
    throw new Error(`${LOG_PREFIX} Playback blocked: ${data?.playabilityStatus?.reason || status || 'unknown'}`);
  }

  return data.streamingData;
}

function pickMp4Url(sd, quality) {
  const mp4Formats = (sd.adaptiveFormats || []).filter(f => f.mimeType?.startsWith('audio/mp4') && f.url);
  if (!mp4Formats.length) return null;
  mp4Formats.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  return quality === QUALITY.LOW ? mp4Formats[mp4Formats.length - 1].url : mp4Formats[0].url;
}

async function getTrackStreamUrl(trackId, preferredQuality, context, env, forceDirectMp4 = false) {
  const quality = context?.settings?.quality?.value || preferredQuality || QUALITY.HIGH;
  const sd = await fetchPlayerData(trackId, env);
  if (!sd) throw new Error(`${LOG_PREFIX} No streaming data returned`);

  if (!forceDirectMp4 && sd.hlsManifestUrl) {
    return {
      streamUrl: sd.hlsManifestUrl,
      streamType: 'hls',
      track: { id: trackId, audioQuality: quality },
    };
  }

  const mp4Url = pickMp4Url(sd, quality);
  if (mp4Url) {
    return {
      streamUrl: mp4Url,
      streamType: 'mp4',
      track: { id: trackId, audioQuality: quality },
    };
  }

  throw new Error(`${LOG_PREFIX} No playable audio found for ${trackId}`);
}

async function getTrackDownloadUrl(trackId, quality, context) {
  const dlQuality = context?.settings?.downloadQuality?.value || quality || '128';
  const response = await fetch(`${DOWNLOAD_API_BASE}${trackId}?s=5`);
  if (!response.ok) throw new Error(`${LOG_PREFIX} Download API error: HTTP ${response.status}`);
  const data = await response.json();
  if (!data.downloadUrl) throw new Error(`${LOG_PREFIX} No download URL returned for ${trackId}`);
  return {
    streamUrl: data.downloadUrl,
    track: {
      id: trackId,
      audioQuality: dlQuality === '320' ? QUALITY.HIGH : QUALITY.LOW,
    },
  };
}

async function getAlbum(albumId, env) {
  const headers = {
    'Content-Type': 'application/json',
    Origin: YTM_BASE,
    Referer: `${YTM_BASE}/`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  };

  const response = await fetch(`${YTM_BASE}/youtubei/v1/browse?key=${YTM_API_KEY}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      context: { client: WEB_REMIX_CONTEXT },
      browseId: albumId,
    }),
  });

  if (!response.ok) throw new Error(`${LOG_PREFIX} Album fetch failed: HTTP ${response.status}`);
  const data = await response.json();

  if (data?.responseContext?.visitorData && env.YTM_CACHE) {
    await env.YTM_CACHE.put(
      'visitorData',
      JSON.stringify({ visitorData: data.responseContext.visitorData, fetchedAt: Date.now() }),
      { expirationTtl: Math.floor(VISITOR_DATA_TTL_MS / 1000) }
    );
  }

  const header = data?.header?.musicImmersiveHeaderRenderer || data?.header?.musicDetailHeaderRenderer || {};
  const albumTitle = header?.title?.runs?.[0]?.text || '';
  let albumArtist = '';
  if (header?.subtitle?.runs) {
    for (const run of header.subtitle.runs) {
      if (run.navigationEndpoint?.browseEndpoint) {
        albumArtist = run.text;
        break;
      }
    }
  }
  const albumCover = bestThumbnail(header?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || []);

  const contents =
    data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]?.musicShelfRenderer?.contents || [];

  const tracks = contents
    .filter(c => c.musicResponsiveListItemRenderer?.playlistItemData?.videoId)
    .map(c => {
      const r = c.musicResponsiveListItemRenderer;
      return {
        id: r.playlistItemData.videoId,
        title: r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text || '',
        artist: albumArtist,
        album: albumTitle,
        duration: parseDuration(r.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text?.runs?.[0]?.text || ''),
        albumCover,
      };
    });

  return {
    album: { id: albumId, title: albumTitle, artist: albumArtist, albumCover },
    tracks,
  };
}

function buildManifest(baseUrl) {
  return {
    id: 'youtube-music',
    name: 'YouTube Music',
    author: 'nvmindl',
    version: '3.1.0',
    labels: ['YT Music', 'Audio', 'Download', 'Settings'],
    description: 'Stream and download from YouTube Music. HLS preferred with automatic mp4 fallback.',
    noPrefetch: true,
    noStreamCache: true,
    settings: {
      quality: {
        type: 'selector',
        label: 'Audio Quality',
        description: 'Select preferred streaming quality',
        logo: 'https://www.gstatic.com/youtube/media/ytm/images/applauncher/music_icon_144x144.png',
        options: QUALITY_OPTIONS,
        defaultValue: QUALITY.HIGH,
      },
      downloadQuality: {
        type: 'selector',
        label: 'Download Quality',
        description: 'Quality label for downloaded tracks (cosmetic — the download API does not support quality selection)',
        options: DOWNLOAD_QUALITY_OPTIONS,
        defaultValue: '128',
      },
    },
    endpoints: {
      searchTracks: `${baseUrl}/api/search`,
      getTrackStreamUrl: `${baseUrl}/api/stream`,
      getTrackDownloadUrl: `${baseUrl}/api/download`,
      getAlbum: `${baseUrl}/api/album`,
    },
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'Content-Type',
    },
  });
}

function html(body) {
  return new Response(body, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

function website(baseUrl) {
  const manifestUrl = `${baseUrl}/manifest.json`;
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Eclipse YouTube Music Addon</title>
  <meta name="description" content="Generate your Eclipse addon manifest URL for a Cloudflare Workers-powered YouTube Music addon." />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://api.fontshare.com/v2/css?f[]=satoshi@400,500,700,900&f[]=cabinet-grotesk@500,700,800&display=swap" rel="stylesheet">
  <style>
    :root {
      --text-xs: clamp(0.75rem, 0.7rem + 0.25vw, 0.875rem);
      --text-sm: clamp(0.875rem, 0.8rem + 0.35vw, 1rem);
      --text-base: clamp(1rem, 0.95rem + 0.25vw, 1.125rem);
      --text-lg: clamp(1.125rem, 1rem + 0.75vw, 1.5rem);
      --text-xl: clamp(1.5rem, 1.2rem + 1.25vw, 2.25rem);
      --text-2xl: clamp(2rem, 1.2rem + 2.5vw, 3.5rem);
      --space-1: 0.25rem; --space-2: 0.5rem; --space-3: 0.75rem; --space-4: 1rem;
      --space-5: 1.25rem; --space-6: 1.5rem; --space-8: 2rem; --space-10: 2.5rem;
      --space-12: 3rem; --space-16: 4rem; --space-20: 5rem;
      --radius-sm: 0.375rem; --radius-md: 0.5rem; --radius-lg: 0.75rem; --radius-xl: 1rem; --radius-full: 9999px;
      --font-body: 'Satoshi', 'Inter', sans-serif;
      --font-display: 'Cabinet Grotesk', 'Satoshi', sans-serif;
      --color-bg: #171614;
      --color-surface: #1c1b19;
      --color-surface-2: #201f1d;
      --color-surface-offset: #22211f;
      --color-border: #393836;
      --color-text: #f2f0eb;
      --color-text-muted: #b5b1aa;
      --color-primary: #ff0033;
      --color-primary-hover: #d9002c;
      --color-blue: #4f98a3;
      --shadow-sm: 0 1px 2px rgb(0 0 0 / .2);
      --shadow-md: 0 10px 30px rgb(0 0 0 / .28);
      --shadow-lg: 0 20px 50px rgb(0 0 0 / .42);
      --transition: 180ms cubic-bezier(0.16, 1, 0.3, 1);
      --content: 1180px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { min-height: 100%; }
    body {
      font-family: var(--font-body);
      font-size: var(--text-base);
      line-height: 1.6;
      color: var(--color-text);
      background:
        radial-gradient(circle at top left, rgba(255,0,51,.14), transparent 28%),
        radial-gradient(circle at top right, rgba(79,152,163,.12), transparent 24%),
        linear-gradient(180deg, #121110 0%, #171614 100%);
    }
    a { color: inherit; text-decoration: none; }
    button, input { font: inherit; }
    .container { width: min(calc(100% - 2rem), var(--content)); margin: 0 auto; }
    .skip-link { position: absolute; left: -999px; top: 0; }
    .skip-link:focus { left: 1rem; top: 1rem; background: var(--color-text); color: #000; padding: .75rem 1rem; border-radius: var(--radius-md); }
    .site-header {
      position: sticky; top: 0; z-index: 10;
      backdrop-filter: blur(16px);
      background: rgba(18,17,16,.72);
      border-bottom: 1px solid rgba(255,255,255,.08);
    }
    .nav {
      display: flex; align-items: center; justify-content: space-between;
      padding: var(--space-4) 0;
      gap: var(--space-4);
    }
    .brand { display: flex; align-items: center; gap: .85rem; font-weight: 700; }
    .logo {
      width: 2.5rem; height: 2.5rem; border-radius: .85rem; display: grid; place-items: center;
      background: linear-gradient(135deg, rgba(255,0,51,.2), rgba(79,152,163,.15));
      border: 1px solid rgba(255,255,255,.1);
      box-shadow: var(--shadow-sm);
    }
    .hero {
      padding: clamp(4rem, 8vw, 7rem) 0 var(--space-16);
    }
    .hero-grid {
      display: grid; grid-template-columns: 1.15fr .85fr; gap: var(--space-10); align-items: center;
    }
    .eyebrow {
      display: inline-flex; align-items: center; gap: .5rem; padding: .45rem .8rem; border-radius: var(--radius-full);
      background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.08); color: var(--color-text-muted); font-size: var(--text-sm);
    }
    h1 {
      font-family: var(--font-display);
      font-size: var(--text-2xl);
      line-height: 1;
      letter-spacing: -.03em;
      margin-top: var(--space-5);
      max-width: 11ch;
    }
    .hero p {
      color: var(--color-text-muted);
      margin-top: var(--space-5);
      max-width: 62ch;
    }
    .cta-row { display: flex; gap: var(--space-3); flex-wrap: wrap; margin-top: var(--space-6); }
    .btn {
      min-height: 44px; padding: .9rem 1.1rem; border-radius: .9rem; border: 1px solid transparent;
      transition: all var(--transition); display: inline-flex; align-items: center; justify-content: center; gap: .65rem;
    }
    .btn-primary { background: var(--color-primary); color: white; box-shadow: var(--shadow-md); }
    .btn-primary:hover { background: var(--color-primary-hover); transform: translateY(-1px); }
    .btn-secondary { background: rgba(255,255,255,.04); border-color: rgba(255,255,255,.1); }
    .btn-secondary:hover { background: rgba(255,255,255,.08); }
    .panel {
      background: linear-gradient(180deg, rgba(255,255,255,.05), rgba(255,255,255,.025));
      border: 1px solid rgba(255,255,255,.09);
      border-radius: 1.35rem;
      box-shadow: var(--shadow-lg);
    }
    .generator { padding: var(--space-6); }
    .generator h2, .section-title { font-family: var(--font-display); font-size: var(--text-xl); line-height: 1.05; }
    .generator p, .muted { color: var(--color-text-muted); }
    .stack { display: grid; gap: var(--space-4); margin-top: var(--space-5); }
    .field { display: grid; gap: .55rem; }
    label { font-size: var(--text-sm); color: var(--color-text-muted); }
    input {
      width: 100%; min-height: 52px; padding: .9rem 1rem; border-radius: .9rem;
      border: 1px solid rgba(255,255,255,.12); background: rgba(0,0,0,.16); color: var(--color-text);
      outline: none;
    }
    input:focus { border-color: rgba(255,0,51,.65); box-shadow: 0 0 0 4px rgba(255,0,51,.14); }
    .output {
      margin-top: var(--space-4); padding: 1rem; border-radius: .9rem; background: rgba(0,0,0,.28);
      border: 1px solid rgba(255,255,255,.09); word-break: break-all; font-size: var(--text-sm);
    }
    .mini-grid {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-4); margin-top: var(--space-8);
    }
    .stat-card, .feature-card {
      padding: var(--space-5); background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.08); border-radius: 1rem;
    }
    .stat-card strong { display: block; font-size: var(--text-lg); }
    .section { padding: var(--space-10) 0; }
    .feature-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-4); margin-top: var(--space-6); }
    .feature-card h3 { margin-bottom: .5rem; font-size: 1.05rem; }
    .feature-card p { color: var(--color-text-muted); font-size: var(--text-sm); }
    .steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-4); margin-top: var(--space-6); }
    .step-number {
      width: 2rem; height: 2rem; border-radius: var(--radius-full); display: grid; place-items: center; margin-bottom: 1rem;
      background: rgba(255,0,51,.18); color: #fff; border: 1px solid rgba(255,0,51,.35);
    }
    code.inline {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: .93em; padding: .15rem .35rem; border-radius: .4rem; background: rgba(255,255,255,.06);
    }
    .site-footer {
      padding: var(--space-10) 0 var(--space-16); color: var(--color-text-muted); font-size: var(--text-sm);
    }
    @media (max-width: 980px) {
      .hero-grid, .feature-grid, .steps, .mini-grid { grid-template-columns: 1fr; }
      h1 { max-width: 14ch; }
    }
  </style>
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="site-header">
    <div class="container nav">
      <div class="brand">
        <div class="logo" aria-hidden="true">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-label="Eclipse YT Music logo">
            <path d="M4 12a8 8 0 1 0 8-8" />
            <path d="M15 7.5 20 10.5 15 13.5Z" fill="currentColor" stroke="none" />
          </svg>
        </div>
        <div>
          <div style="font-weight:800;line-height:1">Eclipse YT Music</div>
          <div style="font-size:.85rem;color:var(--color-text-muted)">Cloudflare Worker addon</div>
        </div>
      </div>
      <a class="btn btn-secondary" href="${manifestUrl}" target="_blank" rel="noopener noreferrer">Open manifest</a>
    </div>
  </header>

  <main id="main">
    <section class="hero">
      <div class="container hero-grid">
        <div>
          <div class="eyebrow">YouTube + YouTube Music search • Eclipse-ready manifest</div>
          <h1>Generate your addon URL and drop it straight into Eclipse.</h1>
          <p>This worker ships a clean manifest endpoint, search, album lookup, playback URL resolution, and download URL passthrough. The page is built to make setup fast on desktop or mobile.</p>
          <div class="cta-row">
            <button class="btn btn-primary" id="copyManifest">Copy manifest URL</button>
            <a class="btn btn-secondary" href="#setup">Install steps</a>
          </div>
          <div class="mini-grid">
            <div class="stat-card"><strong>Search</strong><span class="muted">YouTube Music track search</span></div>
            <div class="stat-card"><strong>Playback</strong><span class="muted">HLS first, MP4 fallback</span></div>
            <div class="stat-card"><strong>Deploy</strong><span class="muted">Cloudflare Workers + Wrangler</span></div>
          </div>
        </div>

        <aside class="panel generator" aria-label="Manifest generator">
          <h2>Manifest URL</h2>
          <p>Most deployments can use the auto-detected Worker origin instantly.</p>
          <div class="stack">
            <div class="field">
              <label for="baseUrl">Worker base URL</label>
              <input id="baseUrl" type="url" value="${baseUrl}" />
            </div>
            <button class="btn btn-primary" id="generateBtn">Generate manifest URL</button>
            <div class="output" id="manifestOutput">${manifestUrl}</div>
            <div class="cta-row">
              <button class="btn btn-secondary" id="copyBtn">Copy</button>
              <a class="btn btn-secondary" id="openBtn" href="${manifestUrl}" target="_blank" rel="noopener noreferrer">Open</a>
            </div>
          </div>
        </aside>
      </div>
    </section>

    <section class="section" id="features">
      <div class="container">
        <h2 class="section-title">What this worker includes</h2>
        <div class="feature-grid">
          <article class="feature-card">
            <h3>Manifest endpoint</h3>
            <p>A single <code class="inline">/manifest.json</code> endpoint exposes Eclipse-facing metadata and server endpoints for search, stream, album, and download actions.</p>
          </article>
          <article class="feature-card">
            <h3>Automatic visitorData refresh</h3>
            <p>The worker refreshes visitor identity with TTL-backed caching so first play and retry behavior stay smoother across sessions.</p>
          </article>
          <article class="feature-card">
            <h3>Nice install page</h3>
            <p>Users get a polished landing page that shows the ready-to-copy manifest URL, plus a dead-simple setup flow that works well on mobile.</p>
          </article>
        </div>
      </div>
    </section>

    <section class="section" id="setup">
      <div class="container">
        <h2 class="section-title">Install flow</h2>
        <div class="steps">
          <article class="feature-card">
            <div class="step-number">1</div>
            <h3>Deploy the Worker</h3>
            <p>Run <code class="inline">npm install</code> and then <code class="inline">npm run deploy</code>. Cloudflare will assign your worker URL.</p>
          </article>
          <article class="feature-card">
            <div class="step-number">2</div>
            <h3>Copy the manifest</h3>
            <p>Use the copy button on this page. The manifest URL points to <code class="inline">/manifest.json</code> on your worker origin.</p>
          </article>
          <article class="feature-card">
            <div class="step-number">3</div>
            <h3>Add it in Eclipse</h3>
            <p>Paste that URL into Eclipse addon installation and the app can call the worker-backed endpoints directly.</p>
          </article>
        </div>
      </div>
    </section>
  </main>

  <footer class="site-footer">
    <div class="container">Built for Eclipse addon hosting on Cloudflare Workers.</div>
  </footer>

  <script>
    const baseUrlInput = document.getElementById('baseUrl');
    const manifestOutput = document.getElementById('manifestOutput');
    const openBtn = document.getElementById('openBtn');

    function normalizeBaseUrl(url) {
      return String(url || '').trim().replace(/\/$/, '');
    }

    function updateManifest() {
      const base = normalizeBaseUrl(baseUrlInput.value || window.location.origin);
      const manifest = base + '/manifest.json';
      manifestOutput.textContent = manifest;
      openBtn.href = manifest;
      return manifest;
    }

    async function copyText(text, button) {
      try {
        await navigator.clipboard.writeText(text);
        const old = button.textContent;
        button.textContent = 'Copied';
        setTimeout(() => button.textContent = old, 1400);
      } catch {
        const range = document.createRange();
        range.selectNodeContents(manifestOutput);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        document.execCommand('copy');
        selection.removeAllRanges();
      }
    }

    document.getElementById('generateBtn').addEventListener('click', () => updateManifest());
    document.getElementById('copyBtn').addEventListener('click', (e) => copyText(updateManifest(), e.currentTarget));
    document.getElementById('copyManifest').addEventListener('click', (e) => copyText(updateManifest(), e.currentTarget));
    baseUrlInput.addEventListener('input', updateManifest);
    updateManifest();
  </script>
</body>
</html>`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return json({}, 204);

    try {
      if (url.pathname === '/') {
        return html(website(url.origin));
      }

      if (url.pathname === '/manifest.json') {
        return json(buildManifest(url.origin));
      }

      if (url.pathname === '/api/search') {
        const query = url.searchParams.get('query') || '';
        const limit = Number(url.searchParams.get('limit') || '20');
        return json(await searchTracks(query, limit, env));
      }

      if (url.pathname === '/api/stream') {
        const trackId = url.searchParams.get('trackId');
        const quality = url.searchParams.get('quality') || QUALITY.HIGH;
        const forceDirectMp4 = url.searchParams.get('forceDirectMp4') === 'true';
        if (!trackId) return json({ error: 'Missing trackId' }, 400);
        return json(await getTrackStreamUrl(trackId, quality, {}, env, forceDirectMp4));
      }

      if (url.pathname === '/api/download') {
        const trackId = url.searchParams.get('trackId');
        const quality = url.searchParams.get('quality') || '128';
        if (!trackId) return json({ error: 'Missing trackId' }, 400);
        return json(await getTrackDownloadUrl(trackId, quality, {}));
      }

      if (url.pathname === '/api/album') {
        const albumId = url.searchParams.get('albumId');
        if (!albumId) return json({ error: 'Missing albumId' }, 400);
        return json(await getAlbum(albumId, env));
      }

      return json({ error: 'Not found' }, 404);
    } catch (error) {
      return json({ error: error.message || 'Unknown error' }, 500);
    }
  },
};
