// Cloudflare Worker — Start 3ทุ่ม Live Status API
// Checks YouTube /live pages + Twitch API for live status
// Deploy: wrangler deploy (or add to existing CF Worker)
//
// FIX: Multiple signals used to detect live status, not just "isLive":true
// YouTube's /live page can keep "isLive":true for hours after a stream ends.
// We now require MULTIPLE confirming signals before declaring a stream live.

const CHANNELS = {
  louis: { platform: 'youtube', handle: 'saytanaa' },
  job:   { platform: 'youtube', handle: 'j3chachannel' },
  geng:  { platform: 'youtube', handle: 'GenghisKhanz' },
  kk:    { platform: 'twitch',  handle: 'thiskk' },
};

// Cache live status for 60 seconds — short enough to catch stream start/end,
// long enough to avoid hammering YouTube. (Previously 30s on-disk, 300s deployed.)
const CACHE_TTL = 60;

/**
 * Check if a YouTube channel is currently live by scraping the /live page.
 *
 * Uses multiple signals to avoid false positives from stale pages:
 * 1. "isLive":true in videoDetails (basic signal, but can be stale)
 * 2. liveStreamabilityRenderer present (only in active live player)
 * 3. No endTimestamp (endTimestamp means stream has ended)
 * 4. lengthSeconds is "0" (live streams report 0 duration)
 * 5. Extract videoId from the player's videoDetails, not from random page elements
 */
async function checkYouTubeLive(handle) {
  try {
    const res = await fetch(`https://www.youtube.com/@${handle}/live`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    });
    const html = await res.text();

    // Signal 1: "isLive":true anywhere in videoDetails
    const hasIsLive = html.includes('"isLive":true');

    // Signal 2: liveStreamabilityRenderer present (strong signal for active live)
    const hasLiveStreamability = html.includes('"liveStreamability"');

    // Signal 3: No endTimestamp (endTimestamp = stream ended definitively)
    const hasEndTimestamp = html.includes('"endTimestamp"');

    // Signal 4: videoDetails with lengthSeconds "0" (live streams have 0 duration)
    const lengthMatch = html.match(/"videoDetails":\{[^}]*"lengthSeconds":"(\d+)"/);
    const lengthSeconds = lengthMatch ? parseInt(lengthMatch[1], 10) : -1;
    const hasZeroLength = lengthSeconds === 0;

    // A stream is live ONLY when:
    // - isLive is true AND
    // - liveStreamability is present AND
    // - there is no endTimestamp AND
    // - lengthSeconds is 0 (live streams always report 0)
    const isLive = hasIsLive && hasLiveStreamability && !hasEndTimestamp && hasZeroLength;

    // Extract videoId from videoDetails (the player's video), not from random page elements.
    // This is more specific than matching the first "videoId" which could be from recommendations.
    let videoId = null;
    const playerVidMatch = html.match(/"videoDetails":\{"videoId":"([^"]+)"/);
    if (playerVidMatch) {
      videoId = playerVidMatch[1];
    } else {
      // Fallback: try liveStreamabilityRenderer
      const liveVidMatch = html.match(/"liveStreamabilityRenderer":\{"videoId":"([^"]+)"/);
      if (liveVidMatch) {
        videoId = liveVidMatch[1];
      }
    }

    const titleMatch = html.match(/"title":"([^"]+)"/);
    const title = titleMatch ? titleMatch[1] : '';

    // Extract startTimestamp for debugging
    const startMatch = html.match(/"startTimestamp":"([^"]+)"/);
    const startedAt = startMatch ? startMatch[1] : null;

    return {
      live: isLive,
      videoId: isLive ? videoId : null,
      title: isLive ? title : null,
      startedAt: isLive ? startedAt : null,
      source: 'scrape',
      // Debug info (helps diagnose false positives/negatives)
      _debug: {
        hasIsLive,
        hasLiveStreamability,
        hasEndTimestamp,
        lengthSeconds,
        rawVideoId: videoId,
      },
    };
  } catch (err) {
    return { live: false, videoId: null, title: null, startedAt: null, source: 'scrape', error: err.message };
  }
}

/**
 * Optional: Use YouTube Data API v3 for more reliable detection.
 * Requires YOUTUBE_API_KEY in Cloudflare Worker secrets.
 * Falls back to scraping if API key is not set or API call fails.
 */
async function checkYouTubeLiveAPI(handle, apiKey) {
  if (!apiKey) return null; // No API key, skip

  try {
    // Step 1: Search for live broadcasts on this channel
    const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=&q=&type=video&eventType=live&maxResults=1&key=${apiKey}`;
    // We need the channel ID, but we only have the handle. Use the channels endpoint first.
    const chRes = await fetch(
      `https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=${handle}&key=${apiKey}`
    );
    if (!chRes.ok) return null;
    const chData = await chRes.json();
    const channelId = chData.items?.[0]?.id;
    if (!channelId) return null;

    // Step 2: Search for active live streams on this channel
    const searchRes = await fetch(
      `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&type=video&eventType=live&maxResults=1&key=${apiKey}`
    );
    if (!searchRes.ok) return null;
    const searchData = await searchRes.json();

    if (!searchData.items || searchData.items.length === 0) {
      return { live: false, videoId: null, title: null, startedAt: null, source: 'api' };
    }

    const item = searchData.items[0];
    const videoId = item.id?.videoId;

    // Step 3: Double-check with videos endpoint to confirm liveStreamingDetails
    if (videoId) {
      const vidRes = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails,snippet&id=${videoId}&key=${apiKey}`
      );
      if (vidRes.ok) {
        const vidData = await vidRes.json();
        const details = vidData.items?.[0]?.liveStreamingDetails;
        // If actualEndTime exists, the stream has ENDED — not live
        if (details?.actualEndTime) {
          return { live: false, videoId: null, title: null, startedAt: null, source: 'api' };
        }
        return {
          live: true,
          videoId,
          title: vidData.items[0]?.snippet?.title || '',
          startedAt: details?.actualStartTime || null,
          source: 'api',
        };
      }
    }

    return {
      live: true,
      videoId,
      title: item.snippet?.title || '',
      startedAt: null,
      source: 'api',
    };
  } catch {
    return null; // Fall back to scraping
  }
}

async function checkTwitchLive(handle) {
  try {
    const res = await fetch(`https://www.twitch.tv/${handle}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
    });
    const html = await res.text();
    const isLive = html.includes('"isLiveBroadcast":true') || html.includes('"stream":{"id"');
    return { live: isLive, twitchUser: handle };
  } catch {
    return { live: false, twitchUser: handle };
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET',
      'Access-Control-Max-Age': '86400',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (url.pathname === '/api/live' || url.pathname === '/') {
      // Check cache
      const cache = caches.default;
      const cacheKey = new Request(url.toString(), request);
      let cached = await cache.match(cacheKey);
      if (cached) return cached;

      const apiKey = env?.YOUTUBE_API_KEY || null;

      // Check all channels in parallel
      const results = {};
      await Promise.all(Object.entries(CHANNELS).map(async ([key, ch]) => {
        if (ch.platform === 'youtube') {
          // Try YouTube Data API first (if API key is configured)
          let result = await checkYouTubeLiveAPI(ch.handle, apiKey);
          if (!result) {
            // Fallback to scraping
            result = await checkYouTubeLive(ch.handle);
          }
          results[key] = { ...result, platform: 'youtube', handle: ch.handle };
        } else {
          results[key] = { ...await checkTwitchLive(ch.handle), platform: 'twitch', handle: ch.handle };
        }
      }));

      const anyLive = Object.values(results).some(r => r.live);

      // Strip debug info from production response (add ?debug=1 to include)
      const includeDebug = url.searchParams.has('debug');
      if (!includeDebug) {
        for (const r of Object.values(results)) {
          delete r._debug;
        }
      }

      const response = new Response(JSON.stringify({
        channels: results,
        anyLive,
        checked: new Date().toISOString(),
        ttl: CACHE_TTL,
      }), {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
          'Cache-Control': `public, max-age=${CACHE_TTL}`,
        },
      });

      ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    }

    return new Response('Start 3ทุ่ม Live API — GET /api/live', {
      headers: { ...corsHeaders, 'Content-Type': 'text/plain' },
    });
  },
};
