/* @8spine-meta
 * type: MODULE
 * category: modules
 * featured: true
 * trusted: false
 * nsfw: false
 */
/**
 * YouTube Music Module for 8SPINE v3.2.0
 * Fixes: duration on artist top tracks, album loading (multiple content paths),
 *        playlist 0-track bug (musicPlaylistShelfRenderer vs musicShelfRenderer)
 */

const LOG_PREFIX = '[YTMusic]';

const YTM_BASE = 'https://music.youtube.com';
const YTM_API_KEY = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30';

// --- visitorData cache with TTL ---
const VISITOR_DATA_TTL_MS = 20 * 60 * 1000; // 20 minutes
let _visitorData = null;
let _visitorDataFetchedAt = 0;

function isVisitorDataFresh() {
    return _visitorData !== null && (Date.now() - _visitorDataFetchedAt) < VISITOR_DATA_TTL_MS;
}

// --- Client contexts ---
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

// --- Quality ---
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseDuration(text) {
    if (!text) return 0;
    const parts = text.split(':').map(Number);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return parts[0] || 0;
}

function bestThumbnail(thumbnails) {
    if (!thumbnails || !thumbnails.length) return '';
    return thumbnails.reduce((best, t) =>
        (t.width || 0) > (best.width || 0) ? t : best
    ).url;
}

/**
 * Parse subtitle runs into artist/album/durationText.
 *
 * FIX v3.2.0: duration is now CAPTURED before being stripped so callers
 * can use it as a fallback when fixedColumns has no duration text.
 * This is what caused artist top tracks to always show 0:00 — their
 * duration lived only in the subtitle runs, never in fixedColumns.
 */
function parseInfoRuns(runs) {
    if (!runs || !runs.length) return { artist: '', album: '', durationText: '' };
    const parts = [];
    let current = '';
    for (const run of runs) {
        if (run.text === ' \u2022 ') {
            if (current) parts.push(current.trim());
            current = '';
        } else {
            current += run.text;
        }
    }
    if (current) parts.push(current.trim());

    // Capture the duration string BEFORE removing it from parts
    let durationText = '';
    while (parts.length > 1 && /^\d+:\d{2}(:\d{2})?$/.test(parts[parts.length - 1])) {
        durationText = parts.pop();
    }

    const typeLabels = ['Song', 'Video', 'EP', 'Single', 'Podcast'];
    let idx = 0;
    if (parts.length > 1 && typeLabels.includes(parts[0])) idx = 1;
    return { artist: parts[idx] || '', album: parts[idx + 1] || '', durationText };
}

function buildIosContext(visitorData) {
    const ctx = Object.assign({}, IOS_CLIENT_BASE);
    if (visitorData) ctx.visitorData = visitorData;
    return ctx;
}

/**
 * Unified duration extractor with three fallback levels:
 *   1. fixedColumns[0] text  (album/search tracks — most reliable)
 *   2. durationText from parseInfoRuns  (artist top tracks — subtitle runs)
 *   3. lengthMs field directly on the renderer  (rare but present in some responses)
 */
function extractDuration(r, durationTextFallback) {
    const fixedText =
        r?.fixedColumns?.[0]
            ?.musicResponsiveListItemFixedColumnRenderer?.text?.runs?.[0]?.text || '';
    if (fixedText && /\d:\d{2}/.test(fixedText)) return parseDuration(fixedText);

    if (durationTextFallback) return parseDuration(durationTextFallback);

    if (r?.lengthMs) return Math.round(parseInt(r.lengthMs, 10) / 1000);

    return 0;
}

// ---------------------------------------------------------------------------
// visitorData — proactive init + TTL refresh
// ---------------------------------------------------------------------------

async function fetchFreshVisitorData() {
    try {
        const resp = await fetch(YTM_BASE + '/youtubei/v1/visitor_id?key=' + YTM_API_KEY, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ context: { client: WEB_REMIX_CONTEXT } }),
        });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const d = await resp.json();
        if (d?.responseContext?.visitorData) {
            _visitorData = d.responseContext.visitorData;
            _visitorDataFetchedAt = Date.now();
            console.log(LOG_PREFIX, 'visitorData refreshed');
        }
    } catch (e) {
        console.log(LOG_PREFIX, 'visitorData fetch failed:', e.message);
    }
}

async function getVisitorData() {
    if (!isVisitorDataFresh()) await fetchFreshVisitorData();
    return _visitorData;
}

// Proactively warm the cache on load
fetchFreshVisitorData();

// ---------------------------------------------------------------------------
// Shared browse helper — deduplicates headers + visitorData refresh
// ---------------------------------------------------------------------------

function getWebRemixHeaders() {
    return {
        'Content-Type': 'application/json',
        'Origin': YTM_BASE,
        'Referer': YTM_BASE + '/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    };
}

async function ytmBrowse(browseId, extra = {}) {
    const response = await fetch(YTM_BASE + '/youtubei/v1/browse?key=' + YTM_API_KEY, {
        method: 'POST',
        headers: getWebRemixHeaders(),
        body: JSON.stringify({
            context: { client: WEB_REMIX_CONTEXT },
            browseId,
            ...extra,
        }),
    });
    if (!response.ok) throw new Error(LOG_PREFIX + ' Browse HTTP ' + response.status + ' for ' + browseId);
    const data = await response.json();
    // Opportunistically refresh visitorData
    if (data?.responseContext?.visitorData) {
        _visitorData = data.responseContext.visitorData;
        _visitorDataFetchedAt = Date.now();
    }
    return data;
}

// ---------------------------------------------------------------------------
// Search — tracks
// ---------------------------------------------------------------------------

async function searchTracks(query, limit = 20) {
    const response = await fetch(YTM_BASE + '/youtubei/v1/search?key=' + YTM_API_KEY, {
        method: 'POST',
        headers: getWebRemixHeaders(),
        body: JSON.stringify({
            context: { client: WEB_REMIX_CONTEXT },
            query,
            params: 'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D', // Songs filter
        }),
    });

    if (!response.ok) throw new Error(LOG_PREFIX + ' Search failed: HTTP ' + response.status);
    const data = await response.json();

    if (data?.responseContext?.visitorData) {
        _visitorData = data.responseContext.visitorData;
        _visitorDataFetchedAt = Date.now();
    }

    const tracks = [];
    const sections =
        data?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]
            ?.tabRenderer?.content?.sectionListRenderer?.contents || [];

    for (const section of sections) {
        const shelf = section.musicShelfRenderer;
        if (!shelf) continue;
        for (const item of (shelf.contents || [])) {
            if (tracks.length >= limit) break;
            const r = item.musicResponsiveListItemRenderer;
            if (!r) continue;

            const videoId =
                r.playlistItemData?.videoId ||
                r.overlay?.musicItemThumbnailOverlayRenderer?.content
                    ?.musicPlayButtonRenderer?.playNavigationEndpoint
                    ?.watchEndpoint?.videoId;
            if (!videoId) continue;

            const title =
                r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer
                    ?.text?.runs?.map(t => t.text).join('') || '';
            const infoRuns =
                r.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer
                    ?.text?.runs || [];
            const info = parseInfoRuns(infoRuns);
            const thumbs =
                r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];

            tracks.push({
                id: videoId,
                title,
                artist: info.artist,
                album: info.album,
                duration: extractDuration(r, info.durationText),
                albumCover: bestThumbnail(thumbs),
            });
        }
    }

    return { tracks, total: tracks.length };
}

// ---------------------------------------------------------------------------
// Search — albums
// ---------------------------------------------------------------------------

async function searchAlbums(query, limit = 20) {
    const response = await fetch(YTM_BASE + '/youtubei/v1/search?key=' + YTM_API_KEY, {
        method: 'POST',
        headers: getWebRemixHeaders(),
        body: JSON.stringify({
            context: { client: WEB_REMIX_CONTEXT },
            query,
            params: 'EgWKAQIYAWoKEAkQBRAKEAMQBA%3D%3D', // Albums filter
        }),
    });

    if (!response.ok) throw new Error(LOG_PREFIX + ' Album search failed: HTTP ' + response.status);
    const data = await response.json();

    const albums = [];
    const sections =
        data?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]
            ?.tabRenderer?.content?.sectionListRenderer?.contents || [];

    for (const section of sections) {
        const shelf = section.musicShelfRenderer;
        if (!shelf) continue;
        for (const item of (shelf.contents || [])) {
            if (albums.length >= limit) break;
            const r = item.musicResponsiveListItemRenderer;
            if (!r) continue;

            // Album items have a browseEndpoint, not a videoId
            const browseId =
                r.navigationEndpoint?.browseEndpoint?.browseId ||
                r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer
                    ?.text?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId;
            if (!browseId) continue;

            const title =
                r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer
                    ?.text?.runs?.map(t => t.text).join('') || '';
            const infoRuns =
                r.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer
                    ?.text?.runs || [];
            const info = parseInfoRuns(infoRuns);
            const thumbs =
                r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];

            albums.push({
                id: browseId,
                title,
                artist: info.artist,
                albumCover: bestThumbnail(thumbs),
                type: 'album',
            });
        }
    }

    return { albums, total: albums.length };
}

// ---------------------------------------------------------------------------
// Player — fetch fresh at play-time, never pre-cached
// ---------------------------------------------------------------------------

async function fetchPlayerData(trackId) {
    const visitorData = await getVisitorData();
    const clientContext = buildIosContext(visitorData);

    const response = await fetch(YTM_BASE + '/youtubei/v1/player?prettyPrint=false', {
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

    if (!response.ok) throw new Error(LOG_PREFIX + ' Player HTTP error: ' + response.status);
    const data = await response.json();

    const status = data?.playabilityStatus?.status;
    console.log(LOG_PREFIX, 'Player status:', status, 'for', trackId);

    if (status !== 'OK') {
        _visitorData = null;
        _visitorDataFetchedAt = 0;
        throw new Error(
            LOG_PREFIX + ' Playback blocked: ' +
            (data?.playabilityStatus?.reason || status || 'unknown')
        );
    }

    return data.streamingData;
}

function pickMp4Url(sd, quality) {
    const mp4Formats = (sd.adaptiveFormats || [])
        .filter(f => f.mimeType?.startsWith('audio/mp4') && f.url);
    if (!mp4Formats.length) return null;
    mp4Formats.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    return quality === QUALITY.LOW
        ? mp4Formats[mp4Formats.length - 1].url
        : mp4Formats[0].url;
}

async function getTrackStreamUrl(trackId, preferredQuality, context, forceDirectMp4 = false) {
    const quality = context?.settings?.quality?.value || preferredQuality || QUALITY.HIGH;
    console.log(LOG_PREFIX, 'Getting stream for', trackId, '| quality:', quality, '| forceDirectMp4:', forceDirectMp4);

    const sd = await fetchPlayerData(trackId);
    if (!sd) throw new Error(LOG_PREFIX + ' No streaming data returned');

    if (!forceDirectMp4 && sd.hlsManifestUrl) {
        console.log(LOG_PREFIX, 'Using HLS for', trackId);
        return {
            streamUrl: sd.hlsManifestUrl,
            streamType: 'hls',
            onHlsError: () => getTrackStreamUrl(trackId, quality, context, true),
            track: { id: trackId, audioQuality: quality },
        };
    }

    const mp4Url = pickMp4Url(sd, quality);
    if (mp4Url) {
        console.log(LOG_PREFIX, 'Using direct mp4 for', trackId);
        return {
            streamUrl: mp4Url,
            streamType: 'mp4',
            track: { id: trackId, audioQuality: quality },
        };
    }

    throw new Error(LOG_PREFIX + ' No playable audio found for ' + trackId);
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

async function getTrackDownloadUrl(trackId, quality, context) {
    const dlQuality = context?.settings?.downloadQuality?.value || quality || '128';
    console.log(LOG_PREFIX, 'Getting download URL for', trackId, '| quality label:', dlQuality);

    const response = await fetch(DOWNLOAD_API_BASE + trackId + '?s=5');
    if (!response.ok) {
        throw new Error(LOG_PREFIX + ' Download API error: HTTP ' + response.status);
    }

    const data = await response.json();
    if (!data.downloadUrl) {
        throw new Error(LOG_PREFIX + ' No download URL returned for ' + trackId);
    }

    return {
        streamUrl: data.downloadUrl,
        track: {
            id: trackId,
            audioQuality: dlQuality === '320' ? QUALITY.HIGH : QUALITY.LOW,
        },
    };
}

// ---------------------------------------------------------------------------
// Album browsing
// ---------------------------------------------------------------------------

/**
 * Try every known content path for album track lists.
 *
 * FIX v3.2.0: YTM uses three different structures depending on album type.
 * The original code only checked path 1 and silently returned [] for paths 2/3.
 */
function extractAlbumTracks(data, albumTitle, albumArtist, albumCover) {
    // Path 1: singleColumnBrowseResultsRenderer (most common)
    let contents =
        data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]
            ?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]
            ?.musicShelfRenderer?.contents;

    // Path 2: twoColumnBrowseResultsRenderer secondary column (newer album layout)
    if (!contents?.length) {
        contents =
            data?.contents?.twoColumnBrowseResultsRenderer
                ?.secondaryContents?.sectionListRenderer?.contents?.[0]
                ?.musicShelfRenderer?.contents;
    }

    // Path 3: scan all sectionList entries for first musicShelfRenderer (EPs/Singles)
    if (!contents?.length) {
        const allContents =
            data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]
                ?.tabRenderer?.content?.sectionListRenderer?.contents || [];
        for (const c of allContents) {
            if (c.musicShelfRenderer?.contents?.length) {
                contents = c.musicShelfRenderer.contents;
                break;
            }
        }
    }

    if (!contents?.length) return [];

    return contents
        .map(c => {
            const r = c.musicResponsiveListItemRenderer;
            if (!r) return null;
            const videoId =
                r.playlistItemData?.videoId ||
                r.overlay?.musicItemThumbnailOverlayRenderer?.content
                    ?.musicPlayButtonRenderer?.playNavigationEndpoint
                    ?.watchEndpoint?.videoId;
            if (!videoId) return null;

            const title =
                r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer
                    ?.text?.runs?.[0]?.text || '';
            const infoRuns =
                r.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer
                    ?.text?.runs || [];
            const info = parseInfoRuns(infoRuns);

            return {
                id: videoId,
                title,
                artist: albumArtist || info.artist,
                album: albumTitle,
                duration: extractDuration(r, info.durationText),
                albumCover,
            };
        })
        .filter(Boolean);
}

async function getAlbum(albumId) {
    const data = await ytmBrowse(albumId);

    // Handle all known header renderer variants
    const header =
        data?.header?.musicImmersiveHeaderRenderer ||
        data?.header?.musicDetailHeaderRenderer ||
        data?.header?.musicEditableEntryPointHeaderRenderer
            ?.header?.musicDetailHeaderRenderer ||
        {};

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
    const albumCover = bestThumbnail(
        header?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails ||
        header?.thumbnail?.croppedSquareThumbnailRenderer?.thumbnail?.thumbnails || []
    );

    const tracks = extractAlbumTracks(data, albumTitle, albumArtist, albumCover);

    return {
        album: { id: albumId, title: albumTitle, artist: albumArtist, albumCover },
        tracks,
    };
}

// ---------------------------------------------------------------------------
// Playlist browsing
// ---------------------------------------------------------------------------

/**
 * Extract tracks from a playlist browse response.
 *
 * FIX v3.2.0: Playlists return musicPlaylistShelfRenderer, NOT musicShelfRenderer.
 * The original getAlbum path looked for musicShelfRenderer and found nothing,
 * so playlist track count was always 0. Now we check both renderer types.
 */
function extractPlaylistTracks(data) {
    // Scan all sectionList entries — check musicPlaylistShelfRenderer first, then musicShelfRenderer
    const allContents =
        data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]
            ?.tabRenderer?.content?.sectionListRenderer?.contents || [];

    let contents = null;
    for (const c of allContents) {
        if (c.musicPlaylistShelfRenderer?.contents?.length) {
            contents = c.musicPlaylistShelfRenderer.contents;
            break;
        }
        if (c.musicShelfRenderer?.contents?.length) {
            contents = c.musicShelfRenderer.contents;
            break;
        }
    }

    if (!contents?.length) return [];

    const tracks = [];
    for (const item of contents) {
        const r = item.musicResponsiveListItemRenderer;
        if (!r) continue;

        const videoId =
            r.playlistItemData?.videoId ||
            r.overlay?.musicItemThumbnailOverlayRenderer?.content
                ?.musicPlayButtonRenderer?.playNavigationEndpoint
                ?.watchEndpoint?.videoId;
        if (!videoId) continue;

        const title =
            r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer
                ?.text?.runs?.map(t => t.text).join('') || '';
        const infoRuns =
            r.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer
                ?.text?.runs || [];
        const info = parseInfoRuns(infoRuns);
        const thumbs =
            r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];

        tracks.push({
            id: videoId,
            title,
            artist: info.artist,
            album: info.album,
            duration: extractDuration(r, info.durationText),
            albumCover: bestThumbnail(thumbs),
        });
    }
    return tracks;
}

async function getPlaylist(playlistId) {
    // YTM playlists need a VL-prefixed browseId
    const browseId = playlistId.startsWith('VL') ? playlistId : 'VL' + playlistId;
    const data = await ytmBrowse(browseId);

    const header =
        data?.header?.musicDetailHeaderRenderer ||
        data?.header?.musicEditableEntryPointHeaderRenderer
            ?.header?.musicDetailHeaderRenderer ||
        data?.header?.musicImmersiveHeaderRenderer ||
        {};

    const title = header?.title?.runs?.[0]?.text || '';
    const thumbs =
        header?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails ||
        header?.thumbnail?.croppedSquareThumbnailRenderer?.thumbnail?.thumbnails || [];

    const tracks = extractPlaylistTracks(data);

    return {
        playlist: { id: playlistId, title, albumCover: bestThumbnail(thumbs) },
        tracks,
        total: tracks.length,
    };
}

// ---------------------------------------------------------------------------
// Artist browsing
// ---------------------------------------------------------------------------

async function getArtist(artistId) {
    const data = await ytmBrowse(artistId);

    const header =
        data?.header?.musicImmersiveHeaderRenderer ||
        data?.header?.musicVisualHeaderRenderer ||
        {};

    const artistName = header?.title?.runs?.[0]?.text || '';
    const artistImage = bestThumbnail(
        header?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails ||
        header?.foregroundThumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || []
    );

    const sections =
        data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]
            ?.tabRenderer?.content?.sectionListRenderer?.contents || [];

    const topTracks = [];
    const albums = [];

    for (const section of sections) {
        // Top tracks come in a musicShelfRenderer
        const shelf = section.musicShelfRenderer;
        if (shelf) {
            for (const item of (shelf.contents || [])) {
                const r = item.musicResponsiveListItemRenderer;
                if (!r) continue;

                const videoId =
                    r.playlistItemData?.videoId ||
                    r.overlay?.musicItemThumbnailOverlayRenderer?.content
                        ?.musicPlayButtonRenderer?.playNavigationEndpoint
                        ?.watchEndpoint?.videoId;
                if (!videoId) continue;

                const title =
                    r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer
                        ?.text?.runs?.map(t => t.text).join('') || '';
                // FIX: subtitle runs for artist top tracks contain the duration —
                // parseInfoRuns now captures it in durationText before stripping.
                const infoRuns =
                    r.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer
                        ?.text?.runs || [];
                const info = parseInfoRuns(infoRuns);
                const thumbs =
                    r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];

                topTracks.push({
                    id: videoId,
                    title,
                    artist: artistName || info.artist,
                    album: info.album,
                    duration: extractDuration(r, info.durationText),
                    albumCover: bestThumbnail(thumbs),
                });
            }
            continue;
        }

        // Albums / Singles / EPs come in musicCarouselShelfRenderer
        const carousel = section.musicCarouselShelfRenderer;
        if (carousel) {
            for (const item of (carousel.contents || [])) {
                const r = item.musicTwoRowItemRenderer;
                if (!r) continue;
                const browseId = r.navigationEndpoint?.browseEndpoint?.browseId;
                if (!browseId) continue;

                const albumTitle = r.title?.runs?.[0]?.text || '';
                const subtitle = r.subtitle?.runs?.map(s => s.text).join('') || '';
                const thumbs =
                    r.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];

                albums.push({
                    id: browseId,
                    title: albumTitle,
                    artist: artistName,
                    subtitle,
                    albumCover: bestThumbnail(thumbs),
                    type: 'album',
                });
            }
        }
    }

    return {
        artist: { id: artistId, name: artistName, image: artistImage },
        topTracks,
        albums,
    };
}

// ---------------------------------------------------------------------------
// Module export
// ---------------------------------------------------------------------------

return {
    id: 'youtube-music',
    name: 'YouTube Music',
    author: 'nvmindl',
    version: '3.2.0',
    labels: ['YT Music', 'Audio', 'Download', 'Settings'],
    description: 'Stream and download from YouTube Music. HLS preferred with automatic mp4 fallback.',

    // YouTube stream URLs expire quickly
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

    searchTracks,
    searchAlbums,
    getTrackStreamUrl,
    getTrackDownloadUrl,
    getAlbum,
    getPlaylist,
    getArtist,
};
