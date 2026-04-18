// Cloudflare Worker — Start 3ทุ่ม Live Status API
// Checks YouTube /live pages + Twitch API for live status
// Deploy: wrangler deploy (or add to existing CF Worker)

const CHANNELS = {
  louis: { platform: 'youtube', handle: 'saytanaa' },
  job:   { platform: 'youtube', handle: 'j3chachannel' },
  geng:  { platform: 'youtube', handle: 'GenghisKhanz' },
  kk:    { platform: 'twitch',  handle: 'thiskk' },
};

// Cache live status for 30 seconds to avoid hammering YouTube
const CACHE_TTL = 30;

async function checkYouTubeLive(handle) {
  try {
    const res = await fetch(`https://www.youtube.com/@${handle}/live`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Start3thumBot/1.0)' },
      redirect: 'follow',
    });
    const html = await res.text();
    const isLive = html.includes('"isLive":true');
    const vidMatch = html.match(/"videoId":"([^"]+)"/);
    const videoId = vidMatch ? vidMatch[1] : null;
    const titleMatch = html.match(/"title":"([^"]+)"/);
    const title = titleMatch ? titleMatch[1] : '';
    return { live: isLive, videoId: isLive ? videoId : null, title: isLive ? title : null };
  } catch {
    return { live: false, videoId: null, title: null };
  }
}

async function checkTwitchLive(handle) {
  // Twitch embed handles live/offline automatically
  // But we can check via the page for status indicator
  try {
    const res = await fetch(`https://www.twitch.tv/${handle}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Start3thumBot/1.0)' },
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

      // Check all channels in parallel
      const results = {};
      await Promise.all(Object.entries(CHANNELS).map(async ([key, ch]) => {
        if (ch.platform === 'youtube') {
          results[key] = { ...await checkYouTubeLive(ch.handle), platform: 'youtube', handle: ch.handle };
        } else {
          results[key] = { ...await checkTwitchLive(ch.handle), platform: 'twitch', handle: ch.handle };
        }
      }));

      const anyLive = Object.values(results).some(r => r.live);

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
