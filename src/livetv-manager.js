'use strict';

const axios = require('axios');

const PLEX_HOST        = process.env.LIVETV_PLEX_HOST || process.env.PLEX_URL || '';
const PLEX_TOKEN       = process.env.LIVETV_PLEX_TOKEN || process.env.PLEX_TOKEN || '';
const CLIENT_ID        = 'movienight-app';
const GUIDE_TTL_MS       = 300_000; // 5 min — channel lineup is stable
const NOW_PLAYING_TTL_MS = 120_000; // 2 min — refresh program info frequently

let channelsCache     = null;
let channelsFetchedAt = 0;
let cachedEpgId       = null;
let cachedDvrKey      = null;
let nowPlayingCache     = null;
let nowPlayingFetchedAt = 0;

// Mutex locks to prevent race conditions when cache expires
let dvrLockResolve = null;
let dvrLockPromise = null;
let channelsLockResolve = null;
let channelsLockPromise = null;
let nowPlayingLockResolve = null;
let nowPlayingLockPromise = null;

function buildHeaders() {
  const headers = { Accept: 'application/json' };
  if (PLEX_TOKEN) headers['X-Plex-Token'] = PLEX_TOKEN;
  return headers;
}

async function fetchDvrInfo(headers) {
  // If already fetching, wait for that promise to resolve
  if (dvrLockPromise) {
    await dvrLockPromise;
    return; // DVR info should now be populated
  }

  // Acquire lock
  dvrLockPromise = new Promise(resolve => { dvrLockResolve = resolve; });

  try {
    // Check again after acquiring lock (another request may have fetched)
    if (cachedEpgId && cachedDvrKey) return;

    const { data } = await axios.get(`${PLEX_HOST}/livetv/dvrs`, { headers, timeout: 10000 });
    const dvr = data?.MediaContainer?.Dvr?.[0];
    if (!dvr) throw new Error('No DVR found');
    cachedEpgId  = dvr.epgIdentifier;
    cachedDvrKey = dvr.key;
  } finally {
    dvrLockResolve();
    dvrLockPromise = null;
    dvrLockResolve = null;
  }
}

async function fetchChannels(headers) {
  if (!cachedEpgId || !cachedDvrKey) await fetchDvrInfo(headers);
  const { data } = await axios.get(`${PLEX_HOST}/${cachedEpgId}/lineups/dvr/channels`, { headers, timeout: 10000 });
  return (data?.MediaContainer?.Channel || []).map(ch => ({
    channelId: String(ch.id || ''),
    number:    ch.vcn || '',
    title:     ch.title || ch.callSign || '',
    thumb:     ch.thumb || null,
    callSign:  ch.callSign || ch.vcn || '',
  }));
}

async function fetchNowPlaying(headers) {
  if (!cachedEpgId) await fetchDvrInfo(headers);
  const nowSec = Math.floor(Date.now() / 1000);
  const { data } = await axios.get(`${PLEX_HOST}/${cachedEpgId}/grid`, {
    headers,
    params: { type: 1, begintime: nowSec, endtime: nowSec + 3600 },
    timeout: 10000,
  });
  const programs = {};
  for (const v of (data?.MediaContainer?.Metadata || [])) {
    const prog = v.grandparentTitle ? `${v.grandparentTitle}: ${v.title}` : (v.title || '');
    for (const ch of (v.Channel || [])) {
      // tag = "4.1 KOMODT (ABC)" — index by both vcn (4.1) and callSign (KOMODT)
      const parts = (ch.tag || '').split(' ');
      if (parts[0]) programs[parts[0]] = prog; // vcn
      if (parts[1]) programs[parts[1]] = prog; // callSign
    }
  }
  return programs;
}

// Stop a DVR subscription so the next tune creates a genuinely fresh session.
// Plex deduplicates tune calls — without deleting first, retune returns the
// same existing subscription (and its already-running expiry clock).
async function stopSubscription(subKey) {
  const headers = buildHeaders();
  await axios.delete(`${PLEX_HOST}/media/subscriptions/${subKey}`, {
    headers,
    params: { 'X-Plex-Client-Identifier': CLIENT_ID },
    timeout: 5000,
  });
  console.log(`[LiveTV] Stopped subscription ${subKey}`);
}

// Tune a live TV channel via Plex DVR — returns { ratingKey, subKey }
async function tuneChannel(channelId) {
  // Validate channelId is numeric
  if (!channelId || !/^\d+$/.test(String(channelId))) {
    throw new Error('Invalid channelId: must be a numeric string');
  }

  const headers = buildHeaders();
  if (!cachedDvrKey) await fetchDvrInfo(headers);

  const url = `${PLEX_HOST}/livetv/dvrs/${cachedDvrKey}/channels/${channelId}/tune`;
  const { data } = await axios.post(url, null, {
    headers,
    params: { 'X-Plex-Client-Identifier': CLIENT_ID },
    timeout: 15000,
  });

  // The tune response nests metadata under MediaSubscription[0].MediaGrabOperation[0].Metadata
  const sub  = data?.MediaContainer?.MediaSubscription?.[0];
  const meta = sub?.MediaGrabOperation?.[0]?.Metadata;
  if (!meta?.ratingKey) throw new Error('Tune response missing ratingKey');

  console.log(`[LiveTV] Tuned channel ${channelId} → ratingKey ${meta.ratingKey} (sub ${sub.key})`);
  return { ratingKey: meta.ratingKey, subKey: sub.key };
}

async function getGuide() {
  const now     = Date.now();
  const headers = buildHeaders();

  // Channels cache with lock to prevent duplicate fetches
  if (!channelsCache || now - channelsFetchedAt >= GUIDE_TTL_MS) {
    // Wait for any in-progress fetch
    if (channelsLockPromise) {
      await channelsLockPromise;
    } else if (!channelsCache) {
      // Acquire lock and fetch
      channelsLockPromise = new Promise(resolve => { channelsLockResolve = resolve; });
      try {
        // Check again after acquiring lock
        if (channelsCache && now - channelsFetchedAt < GUIDE_TTL_MS) return {
          channels: channelsCache.map(ch => {
            const prog   = nowPlayingCache?.[ch.callSign] || nowPlayingCache?.[ch.number];
            const result = { channelId: ch.channelId, number: ch.number, title: ch.title, thumb: ch.thumb };
            if (prog) result.nowPlaying = prog;
            return result;
          }),
        };

        channelsCache     = await fetchChannels(headers);
        channelsFetchedAt = now;
        nowPlayingCache   = null;
      } catch (err) {
        console.error('[LiveTV] guide fetch error:', err.message);
        if (!channelsCache) return { channels: [] };
      } finally {
        if (channelsLockResolve) {
          channelsLockResolve();
          channelsLockPromise = null;
          channelsLockResolve = null;
        }
      }
    }
  }

  // Now playing cache with lock to prevent duplicate fetches
  if (!nowPlayingCache || now - nowPlayingFetchedAt >= NOW_PLAYING_TTL_MS) {
    // Wait for any in-progress fetch
    if (nowPlayingLockPromise) {
      await nowPlayingLockPromise;
    } else if (!nowPlayingCache) {
      // Acquire lock and fetch
      nowPlayingLockPromise = new Promise(resolve => { nowPlayingLockResolve = resolve; });
      try {
        // Check again after acquiring lock
        if (nowPlayingCache && now - nowPlayingFetchedAt < NOW_PLAYING_TTL_MS) return {
          channels: channelsCache.map(ch => {
            const prog   = nowPlayingCache?.[ch.callSign] || nowPlayingCache?.[ch.number];
            const result = { channelId: ch.channelId, number: ch.number, title: ch.title, thumb: ch.thumb };
            if (prog) result.nowPlaying = prog;
            return result;
          }),
        };

        nowPlayingCache     = await fetchNowPlaying(headers);
        nowPlayingFetchedAt = now;
      } catch (err) {
        console.error('[LiveTV] now-playing fetch error:', err.message);
        nowPlayingCache = nowPlayingCache || {};
      } finally {
        if (nowPlayingLockResolve) {
          nowPlayingLockResolve();
          nowPlayingLockPromise = null;
          nowPlayingLockResolve = null;
        }
      }
    }
  }

  return {
    channels: channelsCache.map(ch => {
      const prog   = nowPlayingCache?.[ch.callSign] || nowPlayingCache?.[ch.number];
      const result = { channelId: ch.channelId, number: ch.number, title: ch.title, thumb: ch.thumb };
      if (prog) result.nowPlaying = prog;
      return result;
    }),
  };
}

module.exports = { getGuide, tuneChannel, stopSubscription };
