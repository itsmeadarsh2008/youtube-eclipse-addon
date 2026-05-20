// ─── YouTube hiut Music — Eclipse Addon (Cloudflare Workers) ─────────────────────
// author: ricky | version: 1.9.0
const LOG_PREFIX  = '[YTMusic]';
const YTM_BASE    = 'https://music.youtube.com';
// YTM_API_KEY: set this as a Cloudflare Workers secret (YTM_API_KEY) to avoid exposing it.
// Falls back to the public key if the env secret is not set.
const YTM_API_KEY_FALLBACK = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30';
function getApiKey(env) { return env?.YTM_API_KEY || YTM_API_KEY_FALLBACK; }
const VISITOR_TTL_SEC = 300;

const STREAM_EXPIRES_SEC = 5 * 3600 + 50 * 60;

const WEB_REMIX_CONTEXT = {
  clientName: 'WEB_REMIX', clientVersion: '1.20260304.03.00', hl: 'en', gl: 'US',
};
// iOS client — used for /stream (returns hlsManifestUrl)
const IOS_CLIENT_BASE = {
  clientName: 'IOS', clientVersion: '20.10.01',
  deviceMake: 'Apple', deviceModel: 'iPhone16,2',
  osName: 'iPhone', osVersion: '18.3.2.22D82', hl: 'en',
};
// Android Music client — used for /download
// Its adaptiveFormats URLs are directly fetchable server-side without CDN header tricks
const ANDROID_MUSIC_CLIENT = {
  clientName: 'ANDROID_MUSIC', clientVersion: '7.27.0',
  androidSdkVersion: 34, hl: 'en', gl: 'US',
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
const ANDROID_MUSIC_UA = 'com.google.android.apps.youtube.music/7.27.0 (Linux; U; Android 14; en_US) gzip';
const IOS_UA           = 'com.google.ios.youtube/20.12.4 (iPhone17,3; U; CPU iOS 18_4_1 like Mac OS X)';

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
  const key = userToken ? `ytm:visitor:${userToken}` : 'ytm:visitor';
  const cached = await upstashCmd(env, 'GET', key);
  if (cached && typeof cached === 'string' && cached.length > 4) return cached;
  return fetchFreshVisitorData(env, userToken);
}
async function fetchFreshVisitorData(env, userToken) {
  const key = userToken ? `ytm:visitor:${userToken}` : 'ytm:visitor';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await fetch(`${YTM_BASE}/youtubei/v1/visitor_id?key=${getApiKey(env)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: { client: WEB_REMIX_CONTEXT } }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const vd = (await resp.json())?.responseContext?.visitorData || null;
      if (vd) { upstashCmd(env, 'SET', key, vd, 'EX', VISITOR_TTL_SEC); return vd; }
      throw new Error('empty visitorData');
    } catch (e) {
      console.log(LOG_PREFIX, `visitorData attempt ${attempt} failed:`, e.message);
      if (attempt < 3) await new Promise(r => setTimeout(r, 300 * attempt));
    }
  }
  // Return empty string so buildIosContext still produces a valid context object
  return '';
}
function tryRefreshVisitor(data, env, userToken) {
  const vd = data?.responseContext?.visitorData;
  const key = userToken ? `ytm:visitor:${userToken}` : 'ytm:visitor';
  if (vd) upstashCmd(env, 'SET', key, vd, 'EX', VISITOR_TTL_SEC);
}

function parseDuration(text) {
  if (!text) return 0;
  const s = String(text).trim();
  const iso = s.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (iso) return (parseInt(iso[1]||0)*3600)+(parseInt(iso[2]||0)*60)+parseInt(iso[3]||0);
  const parts = s.split(':').map(Number);
  if (parts.length === 3) return parts[0]*3600+parts[1]*60+parts[2];
  if (parts.length === 2) return parts[0]*60+parts[1];
  return parts[0]||0;
}
function isDuration(text) { return /^\d{1,2}:\d{2}(:\d{2})?$/.test((text||'').trim()); }
function isBullet(text)   { return /^\s*[•·]\s*$/.test(text||''); }
function bestThumbnail(thumbs) {
  if (!thumbs?.length) return '';
  return thumbs.reduce((b,t)=>((t.width||0)>(b.width||0)?t:b)).url;
}
function runsText(runs) { return (runs||[]).map(r=>r.text||'').join('').trim(); }

function parseInfoRuns(runs) {
  if (!runs?.length) return { artist:'', album:'', duration:'' };
  const parts=[]; let cur='';
  for (const run of runs) {
    if (isBullet(run.text)) { if (cur.trim()) parts.push(cur.trim()); cur=''; }
    else cur+=(run.text||'');
  }
  if (cur.trim()) parts.push(cur.trim());
  let duration='';
  if (parts.length && isDuration(parts[parts.length-1])) duration=parts.pop();
  const typeLabels=new Set(['Song','Video','EP','Single','Podcast','Album','Playlist','Compilation']);
  let idx=0;
  if (parts.length>1 && typeLabels.has(parts[0])) idx=1;
  return { artist:parts[idx]||'', album:parts[idx+1]||'', duration };
}

function buildIosContext(visitorData) {
  const ctx={...IOS_CLIENT_BASE};
  if (visitorData) ctx.visitorData=visitorData;
  return ctx;
}

async function ytmPost(path, body, env, userToken) {
  const resp = await fetch(`${YTM_BASE}${path}`, {
    method:'POST', headers:SEARCH_HEADERS, body:JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`${LOG_PREFIX} HTTP ${resp.status} on ${path}`);
  const data = await resp.json();
  tryRefreshVisitor(data, env, userToken);
  return data;
}
async function ytmBrowse(browseId, env, userToken) {
  return ytmPost(`/youtubei/v1/browse?key=${getApiKey(env)}`,
    { context:{client:WEB_REMIX_CONTEXT}, browseId }, env, userToken);
}
async function ytmSearch(query, params, env, userToken) {
  const body={context:{client:WEB_REMIX_CONTEXT}, query};
  if (params) body.params=params;
  return ytmPost(`/youtubei/v1/search?key=${getApiKey(env)}`, body, env, userToken);
}

// ─── YouTube Data API helpers ────────────────────────────────────────────────

async function ytDataChannelSearch(query, env) {
  const apiKey=env?.YOUTUBE_DATA_API_KEY;
  if (!apiKey) return [];
  try {
    const sr=await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=5&q=${encodeURIComponent(query)}&key=${apiKey}`);
    if (!sr.ok) return [];
    const sd=await sr.json();
    const items=sd.items||[];
    if (!items.length) return [];
    const channelIds=items.map(i=>i.snippet?.channelId||i.id?.channelId).filter(Boolean);
    const cr=await fetch(`https://www.googleapis.com/youtube/v3/channels?part=statistics,snippet&id=${channelIds.join(',')}&key=${apiKey}`);
    const statsMap=new Map();
    if (cr.ok) {
      const cd=await cr.json();
      for (const ch of cd.items||[]) statsMap.set(ch.id,{
        subscribers:parseInt(ch.statistics?.subscriberCount||'0'),
        thumb:ch.snippet?.thumbnails?.high?.url||ch.snippet?.thumbnails?.default?.url||'',
        title:ch.snippet?.title||'',
      });
    }
    return channelIds
      .map(id=>{
        const s=statsMap.get(id);
        const fb=items.find(i=>(i.snippet?.channelId||i.id?.channelId)===id);
        return { id, name:s?.title||fb?.snippet?.title||'', artworkURL:s?.thumb||fb?.snippet?.thumbnails?.high?.url||'', subscribers:s?.subscribers||0 };
      })
      .filter(a=>a.id&&a.name)
      .sort((a,b)=>b.subscribers-a.subscribers)
      .map(({id,name,artworkURL})=>({id,name,artworkURL}));
  } catch(e){ console.log(LOG_PREFIX,'ytDataChannelSearch failed:',e.message); return []; }
}

async function ytDataChannelVideos(channelId, artistName, env) {
  const apiKey=env?.YOUTUBE_DATA_API_KEY;
  if (!apiKey) return [];
  try {
    const resp=await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&type=video&order=date&maxResults=20&key=${apiKey}`);
    if (!resp.ok) return [];
    const data=await resp.json();
    const videoIds=(data.items||[]).map(i=>i.id?.videoId).filter(Boolean);
    if (!videoIds.length) return [];
    const dr=await fetch(`https://www.googleapis.com/youtube/v3/videos?part=contentDetails,snippet&id=${videoIds.join(',')}&key=${apiKey}`);
    if (!dr.ok) return videoIds.map((id,i)=>({ id, title:data.items[i]?.snippet?.title||'Unknown', artist:artistName, album:'', duration:0, artworkURL:data.items[i]?.snippet?.thumbnails?.high?.url||'', format:'aac' }));
    const dd=await dr.json();
    return (dd.items||[]).map(v=>({
      id:v.id, title:v.snippet?.title||'Unknown', artist:artistName, album:'',
      duration:parseDuration(v.contentDetails?.duration||''),
      artworkURL:v.snippet?.thumbnails?.high?.url||v.snippet?.thumbnails?.default?.url||'',
      format:'aac',
    })).filter(t=>t.id&&t.title);
  } catch(e){ console.log(LOG_PREFIX,'ytDataChannelVideos failed:',e.message); return []; }
}

// ─── Channel browse helpers ──────────────────────────────────────────────────

async function browseChannelVideos(channelId, env, userToken) {
  const channelData=await ytmPost(`/youtubei/v1/browse?key=${getApiKey(env)}`,
    { context:{client:WEB_REMIX_CONTEXT}, browseId:channelId }, env, userToken);
  const tabs=channelData?.contents?.twoColumnBrowseResultsRenderer?.tabs||
             channelData?.contents?.singleColumnBrowseResultsRenderer?.tabs||[];
  let videosParams=null, videosBrowseId=channelId;
  for (const tab of tabs) {
    const tr=tab?.tabRenderer;
    const title=(typeof tr?.title==='string'?tr.title:runsText(tr?.title?.runs)).toLowerCase();
    if (title==='videos') {
      videosParams=tr?.endpoint?.browseEndpoint?.params;
      videosBrowseId=tr?.endpoint?.browseEndpoint?.browseId||channelId;
      if (tr?.selected) return channelData;
      break;
    }
  }
  if (!videosParams) return channelData;
  return ytmPost(`/youtubei/v1/browse?key=${getApiKey(env)}`,
    { context:{client:WEB_REMIX_CONTEXT}, browseId:videosBrowseId, params:videosParams }, env, userToken);
}

function extractChannelVideoTracks(data, fallbackArtist) {
  const tracks=[], seenIds=new Set();
  const pushVideo=(videoId,title,durText,thumbs)=>{
    if (!videoId||seenIds.has(videoId)||!title) return;
    let dur=parseDuration(durText);
    if (!dur) {
      const acc=String(durText||'');
      const m=acc.match(/(\d+)\s*minute/i), s=acc.match(/(\d+)\s*second/i);
      if (m||s) dur=(parseInt(m?.[1]||0)*60)+parseInt(s?.[1]||0);
    }
    seenIds.add(videoId);
    tracks.push({ id:videoId, title, artist:fallbackArtist||'', album:'', duration:dur, artworkURL:bestThumbnail(thumbs)||'', format:'aac' });
  };
  const addFromMRLIR=(r)=>{
    if (!r) return;
    const t=parseTrackRenderer(r,fallbackArtist,'','');
    if (t&&!seenIds.has(t.id)){ seenIds.add(t.id); tracks.push(t); }
  };
  const allTabs=[
    ...(data?.contents?.twoColumnBrowseResultsRenderer?.tabs||[]),
    ...(data?.contents?.singleColumnBrowseResultsRenderer?.tabs||[]),
  ];
  for (const tab of allTabs) {
    const content=tab?.tabRenderer?.content;
    const richGrid=content?.richGridRenderer;
    if (richGrid) {
      for (const item of richGrid.contents||[]) {
        const vr=item?.richItemRenderer?.content?.videoRenderer||item?.richItemRenderer?.content?.musicVideoRenderer;
        if (vr) {
          const durText=vr.lengthText?.simpleText||vr.lengthText?.accessibility?.accessibilityData?.label
            ||vr.thumbnailOverlays?.find(o=>o.thumbnailOverlayTimeStatusRenderer)?.thumbnailOverlayTimeStatusRenderer?.text?.simpleText||'';
          pushVideo(vr.videoId,runsText(vr.title?.runs)||vr.title?.simpleText,durText,vr.thumbnail?.thumbnails||[]);
        }
        const mr=item?.richItemRenderer?.content?.musicResponsiveListItemRenderer;
        if (mr) addFromMRLIR(mr);
        if (tracks.length>=30) break;
      }
    }
    const grid=content?.gridRenderer, secList=content?.sectionListRenderer;
    for (const item of (grid?.items||secList?.contents||[])) {
      const gvr=item?.gridVideoRenderer;
      if (gvr) {
        const durText=gvr.lengthText?.simpleText||gvr.lengthText?.accessibility?.accessibilityData?.label||'';
        pushVideo(gvr.videoId,runsText(gvr.title?.runs)||gvr.title?.simpleText,durText,gvr.thumbnail?.thumbnails||[]);
      }
      const mr=item?.musicResponsiveListItemRenderer;
      if (mr) addFromMRLIR(mr);
      if (tracks.length>=30) break;
    }
  }
  const sections=data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]
    ?.tabRenderer?.content?.sectionListRenderer?.contents||[];
  for (const sec of sections) {
    for (const it of sec.musicShelfRenderer?.contents||[]) {
      addFromMRLIR(it.musicResponsiveListItemRenderer);
      if (tracks.length>=30) break;
    }
  }
  return tracks;
}

// ─── Core parsers ────────────────────────────────────────────────────────────

function getVideoId(r) {
  if (!r) return null;
  return (
    r.playlistItemData?.videoId||
    r.overlay?.musicItemThumbnailOverlayRenderer?.content
      ?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId||
    (r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs||[])
      .find(run=>run.navigationEndpoint?.watchEndpoint?.videoId)
      ?.navigationEndpoint?.watchEndpoint?.videoId||
    null
  );
}

function parseTrackRenderer(r, fallbackArtist, fallbackAlbum, fallbackArtwork) {
  if (!r) return null;
  const videoId=getVideoId(r);
  if (!videoId) return null;
  const title=runsText(r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs);
  const infoRuns=r.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs||[];
  const info=parseInfoRuns(infoRuns);
  const fixedRaw=r.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text?.runs?.[0]?.text||'';
  const durationStr=(isDuration(fixedRaw)?fixedRaw:'')||info.duration||
    (r.lengthMs?`${Math.floor(r.lengthMs/60000)}:${String(Math.floor((r.lengthMs%60000)/1000)).padStart(2,'0')}`:'' );
  const thumbs=r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails||[];
  return {
    id:videoId, title:title||'Unknown',
    artist:info.artist||fallbackArtist||'',
    album:info.album||fallbackAlbum||'',
    duration:parseDuration(durationStr),
    artworkURL:bestThumbnail(thumbs)||fallbackArtwork||'',
    format:'aac',
  };
}

function parseAlbumItem(item) {
  const r2=item?.musicTwoRowItemRenderer;
  if (r2) {
    const hasWatch=!!(r2.overlay?.musicItemThumbnailOverlayRenderer?.content
      ?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId||r2.navigationEndpoint?.watchEndpoint);
    if (hasWatch) return null;
    const id=r2.navigationEndpoint?.browseEndpoint?.browseId||
      r2.overlay?.musicItemThumbnailOverlayRenderer?.content
        ?.musicPlayButtonRenderer?.playNavigationEndpoint?.browseEndpoint?.browseId;
    if (!id||!id.startsWith('MPRE')) return null;
    const title=r2.title?.runs?.[0]?.text||'';
    const skip=new Set(['Album','EP','Single','Compilation','Podcast']);
    const artist=(r2.subtitle?.runs||[])
      .filter(r=>!isBullet(r.text)&&!/^\d{4}$/.test(r.text.trim())&&!skip.has(r.text.trim()))
      .map(r=>r.text.trim()).filter(Boolean).join(' ').trim();
    return { id, title, artist, artworkURL:bestThumbnail(r2.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails||[]) };
  }
  const r=item?.musicResponsiveListItemRenderer;
  if (r) {
    if (getVideoId(r)) return null;
    const id=r.navigationEndpoint?.browseEndpoint?.browseId||
      r.overlay?.musicItemThumbnailOverlayRenderer?.content
        ?.musicPlayButtonRenderer?.playNavigationEndpoint?.browseEndpoint?.browseId||
      (r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs||[])
        .map(run=>run.navigationEndpoint?.browseEndpoint?.browseId).find(Boolean);
    if (!id||!id.startsWith('MPRE')) return null;
    const title=runsText(r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs);
    const info=parseInfoRuns(r.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs||[]);
    return { id, title, artist:info.artist, artworkURL:bestThumbnail(r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails||[]) };
  }
  return null;
}

function parseArtistItem(item) {
  const r=item?.musicResponsiveListItemRenderer;
  if (!r) return null;
  const id=r.navigationEndpoint?.browseEndpoint?.browseId;
  const name=runsText(r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs);
  if (!id||!name) return null;
  return { id, name, artworkURL:bestThumbnail(r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails||[]) };
}

function parseArtistItemBroad(item) {
  const r2=item?.musicTwoRowItemRenderer;
  if (r2) {
    const id=r2.navigationEndpoint?.browseEndpoint?.browseId;
    if (!id||!id.startsWith('UC')) return null;
    const name=r2.title?.runs?.[0]?.text||'';
    if (!name) return null;
    return { id, name, artworkURL:bestThumbnail(r2.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails||[]) };
  }
  const r=item?.musicResponsiveListItemRenderer;
  if (!r) return null;
  const id=r.navigationEndpoint?.browseEndpoint?.browseId;
  if (!id||!id.startsWith('UC')) return null;
  const name=runsText(r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs);
  if (!name) return null;
  return { id, name, artworkURL:bestThumbnail(r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails||[]) };
}

function parsePlaylistItem(item) {
  const r2=item?.musicTwoRowItemRenderer;
  if (r2) {
    const id=r2.navigationEndpoint?.browseEndpoint?.browseId||
      r2.overlay?.musicItemThumbnailOverlayRenderer?.content
        ?.musicPlayButtonRenderer?.playNavigationEndpoint?.browseEndpoint?.browseId;
    if (!id) return null;
    const title=r2.title?.runs?.[0]?.text||'';
    const creator=(r2.subtitle?.runs||[]).filter(r=>!isBullet(r.text)).map(r=>r.text.trim()).filter(Boolean)[0]||'';
    return { id, title, creator, artworkURL:bestThumbnail(r2.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails||[]) };
  }
  const r=item?.musicResponsiveListItemRenderer;
  if (r) {
    const id=r.navigationEndpoint?.browseEndpoint?.browseId;
    if (!id) return null;
    return { id, title:runsText(r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs), artworkURL:bestThumbnail(r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails||[]) };
  }
  return null;
}

function getShelves(data) {
  return (data?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]
    ?.tabRenderer?.content?.sectionListRenderer?.contents||[])
    .map(s=>s.musicShelfRenderer).filter(Boolean);
}

// ─── Search ──────────────────────────────────────────────────────────────────

async function handleSearch(query, env, userToken, mode) {
  if (!query) return { tracks:[], albums:[], artists:[], playlists:[] };
  const m=mode||'both';
  const fetchSongs=m==='both'||m==='songs';
  const fetchVideos=m==='both'||m==='videos';
  const fetchAlbums=m!=='videos';

  const [songsR,videosR,albumsR,artistsR,plR,broadR]=await Promise.allSettled([
    fetchSongs  ?ytmSearch(query,SEARCH_PARAMS.songs,    env,userToken):Promise.resolve(null),
    fetchVideos ?ytmSearch(query,SEARCH_PARAMS.videos,   env,userToken):Promise.resolve(null),
    fetchAlbums ?ytmSearch(query,SEARCH_PARAMS.albums,   env,userToken):Promise.resolve(null),
    ytmSearch(query,SEARCH_PARAMS.artists,  env,userToken),
    ytmSearch(query,SEARCH_PARAMS.playlists,env,userToken),
    ytmSearch(query,null,env,userToken),
  ]);

  const tracks=[],albums=[],artists=[],playlists=[],seenIds=new Set();
  const addTrack=t=>{ if(t&&!seenIds.has(t.id)){seenIds.add(t.id);tracks.push(t);} };

  if (songsR.status==='fulfilled'&&songsR.value)  for (const s of getShelves(songsR.value))
    for (const it of s.contents||[]){ addTrack(parseTrackRenderer(it.musicResponsiveListItemRenderer)); if(tracks.length>=40)break; }
  if (videosR.status==='fulfilled'&&videosR.value) for (const s of getShelves(videosR.value))
    for (const it of s.contents||[]){ addTrack(parseTrackRenderer(it.musicResponsiveListItemRenderer)); if(tracks.length>=100)break; }

  if (fetchAlbums&&albumsR.status==='fulfilled'&&albumsR.value)
    for (const s of getShelves(albumsR.value))
      for (const it of s.contents||[]){ const a=parseAlbumItem(it); if(a&&albums.length<15)albums.push(a); }

  const seenArtistIds=new Set();
  if (artistsR.status==='fulfilled'&&artistsR.value) for (const s of getShelves(artistsR.value))
    for (const it of s.contents||[]){
      const a=parseArtistItem(it);
      if(a&&!seenArtistIds.has(a.id)&&artists.length<12){ seenArtistIds.add(a.id); artists.push(a); }
    }

  if (broadR.status==='fulfilled'&&broadR.value) {
    for (const s of getShelves(broadR.value))
      for (const it of s.contents||[]){
        const a=parseArtistItemBroad(it);
        if(a&&!seenArtistIds.has(a.id)&&artists.length<12){ seenArtistIds.add(a.id); artists.push(a); }
      }
    const tabs=broadR.value?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]
      ?.tabRenderer?.content?.sectionListRenderer?.contents||[];
    for (const sec of tabs) {
      const card=sec.musicCardShelfRenderer;
      if (!card) continue;
      const id=card.header?.musicCardShelfHeaderBasicRenderer?.title?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId;
      if (id&&id.startsWith('UC')&&!seenArtistIds.has(id)&&artists.length<12) {
        const name=card.header?.musicCardShelfHeaderBasicRenderer?.title?.runs?.[0]?.text||'';
        const artworkURL=bestThumbnail(card.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails||[]);
        if (name){ seenArtistIds.add(id); artists.push({id,name,artworkURL}); }
      }
    }
  }

  if (artists.length===0) {
    const ytChannels=await ytDataChannelSearch(query,env);
    for (const ch of ytChannels)
      if (!seenArtistIds.has(ch.id)&&artists.length<12){ seenArtistIds.add(ch.id); artists.push(ch); }
  }

  if (plR.status==='fulfilled'&&plR.value) for (const s of getShelves(plR.value))
    for (const it of s.contents||[]){ const p=parsePlaylistItem(it); if(p&&playlists.length<12)playlists.push(p); }

  return { tracks, albums, artists, playlists };
}

// ─── Player ──────────────────────────────────────────────────────────────────

// iOS client — for /stream (gives hlsManifestUrl)
async function fetchPlayerData(trackId, env, userToken) {
  const visitorData=await getVisitorData(env,userToken);
  const resp=await fetch(`${YTM_BASE}/youtubei/v1/player?prettyPrint=false`,{
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'User-Agent': IOS_UA },
    body:JSON.stringify({ context:{client:buildIosContext(visitorData)}, videoId:trackId, contentCheckOk:true, racyCheckOk:true }),
  });
  if (!resp.ok) throw new Error(`${LOG_PREFIX} Player HTTP ${resp.status}`);
  const data=await resp.json();
  if (data?.playabilityStatus?.status!=='OK') {
    // Only invalidate cached visitorData if we had one — avoids cascade failures on transient IP blocks
    if (visitorData) {
      const key=userToken?`ytm:visitor:${userToken}`:'ytm:visitor';
      upstashCmd(env,'DEL',key);
    }
    throw new Error(`${LOG_PREFIX} Blocked: ${data?.playabilityStatus?.reason||'unknown'}`);
  }
  return data;
}

// Android Music client — for /download
// ANDROID_MUSIC adaptiveFormats URLs are directly fetchable server-side;
// no CDN signature mismatch, no &alr= or &cpn= requirements.
async function fetchPlayerDataAndroid(trackId) {
  const resp=await fetch(`https://www.youtube.com/youtubei/v1/player?prettyPrint=false`,{
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'User-Agent': ANDROID_MUSIC_UA, 'X-Goog-Api-Format-Version': '2' },
    body:JSON.stringify({
      context:{ client: ANDROID_MUSIC_CLIENT },
      videoId: trackId,
      contentCheckOk: true,
      racyCheckOk: true,
    }),
  });
  if (!resp.ok) throw new Error(`${LOG_PREFIX} Android player HTTP ${resp.status}`);
  const data=await resp.json();
  if (data?.playabilityStatus?.status!=='OK') {
    throw new Error(`${LOG_PREFIX} Android blocked: ${data?.playabilityStatus?.reason||'unknown'}`);
  }
  return data;
}

function pickBestAudio(sd) {
  return (sd?.adaptiveFormats||[])
    .filter(f=>f.mimeType?.startsWith('audio/mp4')&&f.url)
    .sort((a,b)=>(b.bitrate||0)-(a.bitrate||0))[0]||null;
}

// /stream/{id} — proxies audio bytes via Android Music client.
// The iOS client returns CDN URLs signed for Cloudflare's IP, which Eclipse
// cannot play directly. Android Music client URLs are fetchable server-side,
// so we proxy the bytes through the Worker instead.
async function handleStream(trackId, incomingRequest, env, userToken) {
  const data = await fetchPlayerDataAndroid(trackId);
  const sd = data.streamingData;
  if (!sd) throw new Error(`${LOG_PREFIX} No streaming data for stream`);
  const best = pickBestAudio(sd);
  if (!best) throw new Error(`${LOG_PREFIX} No streamable audio for ${trackId}`);
  const cdnUrl = best.url.includes('?') ? best.url + '&alr=yes' : best.url + '?alr=yes';
  const reqHeaders = {
    'User-Agent': ANDROID_MUSIC_UA,
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': 'https://music.youtube.com',
    'Referer': 'https://music.youtube.com/',
  };
  const range = incomingRequest.headers.get('range');
  if (range) reqHeaders['Range'] = range;
  const upstream = await fetch(cdnUrl, { headers: reqHeaders });
  const upstreamCT = upstream.headers.get('content-type') || '';
  if (!upstream.ok && upstream.status !== 206) {
    throw new Error(`${LOG_PREFIX} CDN ${upstream.status} for stream ${trackId}`);
  }
  if (!upstreamCT.includes('audio') && !upstreamCT.includes('octet-stream') && !upstreamCT.includes('video')) {
    const preview = await upstream.text();
    throw new Error(`${LOG_PREFIX} CDN returned non-audio content-type "${upstreamCT}" — body: ${preview.slice(0,200)}`);
  }
  const contentLength = best.contentLength || upstream.headers.get('content-length') || null;
  const resHeaders = {
    'content-type': 'audio/mp4',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, OPTIONS',
    'cache-control': 'no-store',
  };
  if (contentLength) resHeaders['content-length'] = String(contentLength);
  if (upstream.headers.get('content-range')) resHeaders['content-range'] = upstream.headers.get('content-range');
  if (upstream.headers.get('accept-ranges')) resHeaders['accept-ranges'] = upstream.headers.get('accept-ranges');
  return new Response(upstream.body, { status: upstream.status, headers: resHeaders });
}

// /download/{id}
// Uses the Android Music client whose CDN URLs are directly fetchable server-side.
// Validates that the upstream response is actually audio before streaming to Eclipse.
async function proxyDownload(trackId, incomingRequest, env, userToken) {
  // Fetch player data with Android client (URLs work without CDN header tricks)
  const data = await fetchPlayerDataAndroid(trackId);
  const sd = data.streamingData;
  if (!sd) throw new Error(`${LOG_PREFIX} No streaming data for download`);

  const best = pickBestAudio(sd);
  if (!best) throw new Error(`${LOG_PREFIX} No downloadable audio for ${trackId}`);

  // Append &alr=yes which tells YouTube CDN this is an allowed range request
  const cdnUrl = best.url.includes('?') ? best.url + '&alr=yes' : best.url + '?alr=yes';

  const reqHeaders = {
    'User-Agent':      ANDROID_MUSIC_UA,
    'Accept':          '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin':          'https://music.youtube.com',
    'Referer':         'https://music.youtube.com/',
  };
  const range = incomingRequest.headers.get('range');
  if (range) reqHeaders['Range'] = range;

  const upstream = await fetch(cdnUrl, { headers: reqHeaders });

  // Guard: if YouTube returned an error body (HTML/JSON ~30KB) instead of audio, fail loudly
  const upstreamCT = upstream.headers.get('content-type') || '';
  if (!upstream.ok && upstream.status !== 206) {
    throw new Error(`${LOG_PREFIX} CDN ${upstream.status} for ${trackId}`);
  }
  if (!upstreamCT.includes('audio') && !upstreamCT.includes('octet-stream') && !upstreamCT.includes('video')) {
    const preview = await upstream.text();
    throw new Error(`${LOG_PREFIX} CDN returned non-audio content-type "${upstreamCT}" — body: ${preview.slice(0,200)}`);
  }

  const contentLength = best.contentLength || upstream.headers.get('content-length') || null;

  const resHeaders = {
    'content-type':                 'audio/mp4',
    'access-control-allow-origin':  '*',
    'access-control-allow-methods': 'GET, OPTIONS',
    'cache-control':                'no-store',
    'content-disposition':          `attachment; filename="${trackId}.m4a"`,
  };
  if (contentLength)                         resHeaders['content-length'] = String(contentLength);
  if (upstream.headers.get('content-range')) resHeaders['content-range']  = upstream.headers.get('content-range');
  if (upstream.headers.get('accept-ranges')) resHeaders['accept-ranges']  = upstream.headers.get('accept-ranges');

  return new Response(upstream.body, { status: upstream.status, headers: resHeaders });
}

// ─── Browse helpers ──────────────────────────────────────────────────────────

function extractSecondaryTracks(data, fallbackArtist, fallbackAlbum, fallbackArtwork) {
  const twoCol=data?.contents?.twoColumnBrowseResultsRenderer;
  if (!twoCol) return [];
  const tracks=[];
  for (const s of twoCol?.secondaryContents?.sectionListRenderer?.contents||[]) {
    const shelf=s.musicShelfRenderer||s.musicPlaylistShelfRenderer;
    if (!shelf) continue;
    for (const item of shelf.contents||[]) {
      const t=parseTrackRenderer(item.musicResponsiveListItemRenderer,fallbackArtist,fallbackAlbum,fallbackArtwork);
      if (t) tracks.push(t);
    }
  }
  return tracks;
}

function extractResponsiveHeader(data) {
  const twoCol=data?.contents?.twoColumnBrowseResultsRenderer;
  const rhr=twoCol?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]?.musicResponsiveHeaderRenderer;
  if (rhr) return rhr;
  return data?.header?.musicImmersiveHeaderRenderer||data?.header?.musicDetailHeaderRenderer||null;
}

// ─── Route handlers ──────────────────────────────────────────────────────────

async function handleAlbum(albumId, env, userToken) {
  const data=await ytmBrowse(albumId,env,userToken);
  const hdr=extractResponsiveHeader(data)||{};
  const albumTitle=runsText(hdr.title?.runs);
  let albumArtist='';
  for (const run of hdr.subtitle?.runs||[]) { if(run.navigationEndpoint?.browseEndpoint){albumArtist=run.text;break;} }
  if (!albumArtist) albumArtist=runsText(hdr.straplineTextOne?.runs);
  if (!albumArtist) {
    const skip=new Set(['Album','EP','Single','Compilation']);
    for (const run of hdr.subtitle?.runs||[]) {
      const t=run.text?.trim();
      if(t&&!isBullet(t)&&!skip.has(t)&&!/^\d{4}$/.test(t)){albumArtist=t;break;}
    }
  }
  const artworkURL=bestThumbnail(hdr.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails||hdr.thumbnail?.croppedSquareThumbnailRenderer?.thumbnail?.thumbnails||[]);
  const tracks=extractSecondaryTracks(data,albumArtist,albumTitle,artworkURL);
  tracks.forEach((t,i)=>{ t.album=albumTitle; t.trackNumber=i+1; if(!t.artworkURL)t.artworkURL=artworkURL; });
  return { id:albumId, title:albumTitle, artist:albumArtist, artworkURL, trackCount:tracks.length, tracks };
}

async function handleArtist(artistId, env, userToken, mode) {
  const data=await ytmBrowse(artistId,env,userToken);
  const hdr=data?.header?.musicImmersiveHeaderRenderer||data?.header?.musicVisualHeaderRenderer||{};
  const name=runsText(hdr.title?.runs)||'Unknown Artist';
  const artworkURL=bestThumbnail(
    hdr.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails||
    hdr.foregroundThumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails||
    hdr.thumbnail?.croppedSquareThumbnailRenderer?.thumbnail?.thumbnails||[]);

  const sections=data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]
    ?.tabRenderer?.content?.sectionListRenderer?.contents||[];
  const rawTracks=[],albums=[];
  for (const section of sections) {
    const shelf=section.musicShelfRenderer,carousel=section.musicCarouselShelfRenderer;
    if (shelf) for (const it of shelf.contents||[]){
      const t=parseTrackRenderer(it.musicResponsiveListItemRenderer,name,'','');
      if(t&&rawTracks.length<15)rawTracks.push(t);
    }
    if (carousel) for (const it of carousel.contents||[]){
      const a=parseAlbumItem(it);
      if(a&&albums.length<30)albums.push({...a,artist:a.artist||name});
    }
  }

  if (mode==='videos') {
    let topTracks=[];
    try {
      const channelData=await browseChannelVideos(artistId,env,userToken);
      topTracks=extractChannelVideoTracks(channelData,name);
    } catch(e){ console.log(LOG_PREFIX,'channel browse failed:',e.message); }

    if (topTracks.length===0&&env?.YOUTUBE_DATA_API_KEY) {
      try { topTracks=await ytDataChannelVideos(artistId,name,env); }
      catch(e){ console.log(LOG_PREFIX,'ytData videos fallback failed:',e.message); }
    }

    if (topTracks.length===0) {
      try {
        const vr=await ytmSearch(name,SEARCH_PARAMS.videos,env,userToken);
        const seenIds=new Set(), nameLower=name.toLowerCase();
        for (const shelf of getShelves(vr))
          for (const it of shelf.contents||[]){
            const t=parseTrackRenderer(it.musicResponsiveListItemRenderer,name,'','');
            if(t&&!seenIds.has(t.id)){
              if(!t.artist||t.artist.toLowerCase().includes(nameLower)||nameLower.includes(t.artist.toLowerCase()))
                { seenIds.add(t.id); topTracks.push(t); }
            }
            if(topTracks.length>=20)break;
          }
      } catch(e){ console.log(LOG_PREFIX,'video search fallback failed:',e.message); }
    }
    return { id:artistId, name, artworkURL, bio:null, topTracks, albums };
  }

  let topTracks=rawTracks;
  if (topTracks.some(t=>t.duration===0)) {
    try {
      const sr=await ytmSearch(name,SEARCH_PARAMS.songs,env,userToken);
      const dMap=new Map();
      for (const shelf of getShelves(sr))
        for (const it of shelf.contents||[]){
          const r=it.musicResponsiveListItemRenderer; if(!r)continue;
          const vid=getVideoId(r); if(!vid)continue;
          const info=parseInfoRuns(r.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs||[]);
          const fixRaw=r.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text?.runs?.[0]?.text||'';
          const dur=(isDuration(fixRaw)?fixRaw:'')||info.duration;
          if(vid&&dur)dMap.set(vid,parseDuration(dur));
        }
      for (const t of topTracks) if(t.duration===0&&dMap.has(t.id))t.duration=dMap.get(t.id);
    } catch(e){ console.log(LOG_PREFIX,'duration enrich failed:',e.message); }
  }
  topTracks=topTracks.filter(t=>t.duration>0);
  return { id:artistId, name, artworkURL, bio:null, topTracks, albums };
}

async function handlePlaylist(playlistId, env, userToken) {
  const browseId=playlistId.startsWith('VL')?playlistId:'VL'+playlistId;
  const data=await ytmBrowse(browseId,env,userToken);
  const hdr=extractResponsiveHeader(data)||{};
  const title=runsText(hdr.title?.runs)||'Playlist';
  const creator=(hdr.subtitle?.runs||[])
    .filter(r=>!isBullet(r.text)&&r.text!=='Playlist')
    .map(r=>r.text.trim()).filter(Boolean).join('').trim();
  const artworkURL=bestThumbnail(hdr.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails||hdr.thumbnail?.croppedSquareThumbnailRenderer?.thumbnail?.thumbnails||[]);
  const tracks=extractSecondaryTracks(data);
  return { id:playlistId, title, creator, artworkURL, trackCount:tracks.length, tracks };
}

// ─── Token / routing ─────────────────────────────────────────────────────────

function generateToken() {
  const arr=new Uint8Array(14); crypto.getRandomValues(arr);
  return Array.from(arr,b=>b.toString(16).padStart(2,'0')).join('');
}
function isValidToken(t){ return typeof t==='string'&&/^[a-f0-9]{28}$/.test(t); }
function parseTokenPath(p) {
  const m=p.match(/^\/u\/([a-f0-9]{28})\/(songs|videos)(\/.*)?$/);
  if (m) return { token:m[1], mode:m[2], rest:m[3]||'/' };
  const m2=p.match(/^\/u\/([a-f0-9]{28})(\/.*)?$/);
  return m2?{ token:m2[1], mode:'both', rest:m2[2]||'/' }:null;
}
function lastSegment(rest){ return rest.split('/').filter(Boolean).pop()||''; }

function buildManifest(mode) {
  const m=mode||'both';
  const variants={
    both:   { id:'com.ricky.youtube-music',        name:'YouTube Music',          description:'Stream from YouTube Music — Songs & Videos, Albums, Artists, Playlists. HLS + AAC.' },
    songs:  { id:'com.ricky.youtube-music-songs',  name:'YouTube Music — Songs',  description:'Stream from YouTube Music — Songs tab only. Albums, Artists & Playlists. HLS + AAC.' },
    videos: { id:'com.ricky.youtube-music-videos', name:'YouTube Music — Videos', description:'Stream from YouTube Music — Videos tab. Artists & Playlists. HLS + AAC.' },
  };
  const v=variants[m]||variants.both;
  return {
    id:v.id, name:v.name, version:'1.9.0', description:v.description,
    icon:'https://www.gstatic.com/youtube/media/ytm/images/applauncher/music_icon_144x144.png',
    resources:['search','stream','download','catalog'],
    types:['track','album','artist','playlist'],
    contentType:'music',
  };
}

async function handleRoute(rest, url, request, env, userToken, mode) {
  const q=url.searchParams.get('q')||url.searchParams.get('query')||'';
  if (rest==='/manifest.json'||rest==='/manifest') return jsonRes(buildManifest(mode));
  if (rest==='/search')              return jsonRes(await handleSearch(q,env,userToken,mode));
  if (rest.startsWith('/stream/'))   { const id=lastSegment(rest); if(!id)return jsonRes({error:'Missing ID'},400); return await handleStream(id,request,env,userToken); }
  if (rest.startsWith('/download/')) { const id=lastSegment(rest); if(!id)return jsonRes({error:'Missing ID'},400); return await proxyDownload(id,request,env,userToken); }
  if (rest.startsWith('/album/'))    { const id=lastSegment(rest); if(!id)return jsonRes({error:'Missing ID'},400); return jsonRes(await handleAlbum(id,env,userToken)); }
  if (rest.startsWith('/artist/'))   { const id=lastSegment(rest); if(!id)return jsonRes({error:'Missing ID'},400); return jsonRes(await handleArtist(id,env,userToken,mode)); }
  if (rest.startsWith('/playlist/')) { const id=lastSegment(rest); if(!id)return jsonRes({error:'Missing ID'},400); return jsonRes(await handlePlaylist(id,env,userToken)); }
  return null;
}

function jsonRes(data, status) {
  return new Response(JSON.stringify(data,null,2),{
    status:status||200,
    headers:{
      'content-type':                'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-methods':'GET, POST, OPTIONS',
      'access-control-allow-headers':'Content-Type, Range',
      'cache-control':               'no-store',
    },
  });
}
function htmlRes(b){ return new Response(b,{headers:{'content-type':'text/html; charset=utf-8'}}); }

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
  <div class="tip"><b>Save your URLs.</b> Paste one below any time to copy it again without reinstalling.</div>
  <div class="pills">
    <span class="pill">Songs &middot; Videos</span>
    <span class="pill">Albums &middot; Artists &middot; Playlists</span>
    <span class="pill hi">HLS Streaming</span>
    <span class="pill gr">Proxied AAC Downloads</span>
    <span class="pill gr">Offline Playback</span>
    <span class="pill gr">Upstash Redis</span>
    <span class="pill bl">No Account</span>
  </div>
  <button class="bw" id="genBtn" onclick="generate()">Generate My Addon URLs</button>
  <div class="box" id="genBox">
    <div class="blbl">Songs &amp; Videos (both) &mdash; paste into Eclipse</div>
    <div class="burl" id="genUrl"></div>
    <button class="bd" id="copyGenBtn" onclick="copyGen()">Copy Both URL</button>
  </div>
  <div class="box" id="genBoxSongs">
    <div class="blbl">Songs tab only &mdash; paste into Eclipse</div>
    <div class="burl" id="genUrlSongs"></div>
    <button class="bd" id="copyGenBtnSongs" onclick="copyGenSongs()">Copy Songs URL</button>
  </div>
  <div class="box" id="genBoxVideos">
    <div class="blbl">Videos tab only &mdash; paste into Eclipse</div>
    <div class="burl" id="genUrlVideos"></div>
    <button class="bd" id="copyGenBtnVideos" onclick="copyGenVideos()">Copy Videos URL</button>
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
    <div class="step"><div class="sn">1</div><div class="st">Generate and copy any URL above</div></div>
    <div class="step"><div class="sn">2</div><div class="st">Open <b>Eclipse</b> &rarr; Settings &rarr; Connections &rarr; Add Connection &rarr; Addon</div></div>
    <div class="step"><div class="sn">3</div><div class="st">Paste your URL and tap <b>Install</b></div></div>
    <div class="step"><div class="sn">4</div><div class="st">Install all 3 as separate addons, or just the one you want</div></div>
  </div>
  <div class="warn">
    /stream &rarr; iOS client, HLS manifest (AVPlayer live playback)<br>
    /download &rarr; Android Music client, proxied AAC mp4 bytes<br>
    content-type validated before streaming — no silent garbage files
  </div>
</div>
<footer>YouTube Music for Eclipse v1.9.0 &bull; by ricky &bull; Cloudflare Workers</footer>
<script>
var gu=null,guSongs=null,guVideos=null,ru=null;
function generate(){
  var btn=document.getElementById('genBtn');btn.disabled=true;btn.textContent='Generating...';
  fetch('/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})
    .then(function(r){return r.json()}).then(function(d){
      if(d.error){alert(d.error);btn.disabled=false;btn.textContent='Generate My Addon URLs';return;}
      gu=d.manifestUrl;guSongs=d.manifestUrlSongs;guVideos=d.manifestUrlVideos;
      document.getElementById('genUrl').textContent=gu;
      document.getElementById('genUrlSongs').textContent=guSongs;
      document.getElementById('genUrlVideos').textContent=guVideos;
      document.getElementById('genBox').style.display='block';
      document.getElementById('genBoxSongs').style.display='block';
      document.getElementById('genBoxVideos').style.display='block';
      btn.disabled=false;btn.textContent='Generate New URLs';
    }).catch(function(e){alert('Error: '+e.message);btn.disabled=false;btn.textContent='Generate My Addon URLs'});
}
function copyGen(){if(gu)copyText(gu,document.getElementById('copyGenBtn'));}
function copyGenSongs(){if(guSongs)copyText(guSongs,document.getElementById('copyGenBtnSongs'));}
function copyGenVideos(){if(guVideos)copyText(guVideos,document.getElementById('copyGenBtnVideos'));}
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
    const url=new URL(request.url), pathname=url.pathname;
    if (request.method==='OPTIONS') return new Response(null,{status:204,headers:{'access-control-allow-origin':'*','access-control-allow-methods':'GET, POST, OPTIONS','access-control-allow-headers':'Content-Type, Range'}});
    try {
      if (pathname==='/') return htmlRes(buildPage());
      if (pathname==='/generate'&&request.method==='POST') {
        const token=generateToken();
        return jsonRes({ token, manifestUrl:`${url.origin}/u/${token}/manifest.json`, manifestUrlSongs:`${url.origin}/u/${token}/songs/manifest.json`, manifestUrlVideos:`${url.origin}/u/${token}/videos/manifest.json` });
      }
      if (pathname==='/refresh'&&request.method==='POST') {
        let body; try{body=await request.json();}catch{}
        const m=String(body?.existingUrl||'').match(/[a-f0-9]{28}/);
        if (!m) return jsonRes({error:'Paste your full addon URL — must contain a valid token'},400);
        return jsonRes({token:m[0],manifestUrl:`${url.origin}/u/${m[0]}/manifest.json`,refreshed:true});
      }
      if (pathname==='/health') return jsonRes({status:'ok',version:'1.9.0',ts:new Date().toISOString()});

      const tp=parseTokenPath(pathname);
      if (tp) {
        if (!isValidToken(tp.token)) return jsonRes({error:'Invalid token.'},400);
        if (tp.rest.startsWith('/download/')) {
          const id=lastSegment(tp.rest);
          if (!id) return jsonRes({error:'Missing ID'},400);
          return await proxyDownload(id,request,env,tp.token);
        }
        const r=await handleRoute(tp.rest,url,request,env,tp.token,tp.mode);
        return r||jsonRes({error:'Not found',path:tp.rest},404);
      }
      if (pathname.startsWith('/download/')) {
        const id=lastSegment(pathname);
        if (!id) return jsonRes({error:'Missing ID'},400);
        return await proxyDownload(id,request,env,null);
      }
      const base=await handleRoute(pathname,url,request,env,null,'both');
      return base||jsonRes({error:'Not found'},404);
    } catch(err) {
      console.error(LOG_PREFIX,err);
      return jsonRes({error:err.message||'Internal error'},500);
    }
  },
};
