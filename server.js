#!/usr/bin/env node
'use strict';
/**
 * AirLoom SFO — standalone 3D ADS-B viewer + thin /adsb/states proxy.
 * Sources (in order): adsb.lol → adsb.fi → OpenSky (optional).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 8767);
const PUBLIC_DIR = path.join(__dirname, 'public');
const ADSB_PRIMARY = (process.env.ADSB_PRIMARY || 'adsb.lol').toLowerCase();
const OSKY_ID = process.env.OSKY_ID || '';
const OSKY_SECRET = process.env.OSKY_SECRET || '';
const UA = 'AirLoomSFO/1.4 (+https://github.com/skyway4k/airloom-sfo; contact=skyway4k@users.noreply.github.com)';

const KSFO_DEFAULT = { lat: 37.62818, lon: -122.38487, dist: 360 }; // ~60–90 min jet cruise box
const ADSB_CACHE_FRESH_MS = 22000;
const ADSB_CACHE_STALE_MS = 10 * 60 * 1000;
const BG_REFRESH_MS = 20000;
const SOURCE_BACKOFF_MS = 45000;

function log(msg, level) {
  const tag = level === 'ERR' ? 'ERR' : level === 'WARN' ? 'WARN' : level === 'OK' ? 'OK' : 'INFO';
  console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`);
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ({
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp',
    '.glb': 'model/gltf-binary',
    '.gltf': 'model/gltf+json',
    '.md': 'text/markdown; charset=utf-8',
  })[ext] || 'application/octet-stream';
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType(filePath),
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': path.extname(filePath) === '.html' ? 'no-store' : 'public, max-age=3600',
    });
    res.end(data);
  });
}

function feetToMeters(ft) { return ft == null || ft === '' ? null : Number(ft) * 0.3048; }
function knotsToMs(kts) { return kts == null || kts === '' ? null : Number(kts) * 0.514444; }
function fpmToMs(fpm) { return fpm == null || fpm === '' ? null : Number(fpm) * 0.00508; }
function padCallsign(cs) {
  let s = (cs == null ? '' : String(cs)).trim().toUpperCase();
  if (!s) return '        ';
  if (s.length >= 8) return s.slice(0, 8);
  return s + ' '.repeat(8 - s.length);
}

function adsbAcToState(ac) {
  const hex = String(ac.hex || '').toLowerCase();
  const onGround = ac.alt_baro === 'ground' || ac.alt_baro === 'GROUND';
  let altBaroM = onGround ? 0 : feetToMeters(typeof ac.alt_baro === 'number' ? ac.alt_baro : parseFloat(ac.alt_baro));
  if (altBaroM != null && isNaN(altBaroM)) altBaroM = null;
  let altGeomM = feetToMeters(typeof ac.alt_geom === 'number' ? ac.alt_geom : parseFloat(ac.alt_geom));
  if (altGeomM != null && isNaN(altGeomM)) altGeomM = null;
  let vel = knotsToMs(ac.gs);
  if (vel != null && isNaN(vel)) vel = null;
  let vr = null;
  if (ac.geom_rate != null) vr = fpmToMs(ac.geom_rate);
  else if (ac.baro_rate != null) vr = fpmToMs(ac.baro_rate);
  if (vr != null && isNaN(vr)) vr = null;
  const track = (typeof ac.track === 'number' && !isNaN(ac.track)) ? ac.track : null;
  const lat = (typeof ac.lat === 'number') ? ac.lat : null;
  const lon = (typeof ac.lon === 'number') ? ac.lon : null;
  const squawk = ac.squawk != null ? String(ac.squawk) : null;
  return [
    hex, padCallsign(ac.flight), '', null, null, lon, lat, altBaroM, !!onGround,
    vel, track, vr, null, altGeomM, squawk, false, 0, 0,
  ];
}

function centerDistToBbox(lat, lon, distNm) {
  const dLat = distNm / 60;
  const cosLat = Math.cos(lat * Math.PI / 180);
  const dLon = distNm / (60 * Math.max(0.2, Math.abs(cosLat)));
  return {
    lamin: (lat - dLat).toFixed(4),
    lamax: (lat + dLat).toFixed(4),
    lomin: (lon - dLon).toFixed(4),
    lomax: (lon + dLon).toFixed(4),
  };
}

function buildAdsbPayload(list, sourceName) {
  const states = [];
  const acMeta = [];
  for (const ac of list) {
    if (!ac || ac.lat == null || ac.lon == null || !ac.hex) continue;
    states.push(adsbAcToState(ac));
    acMeta.push({
      hex: String(ac.hex || '').toLowerCase(),
      reg: ac.r || null,
      type: ac.t || null,
      desc: ac.desc || null,
      flight: (ac.flight || '').trim() || null,
      lat: typeof ac.lat === 'number' ? ac.lat : null,
      lon: typeof ac.lon === 'number' ? ac.lon : null,
      alt_baro: ac.alt_baro,
      gs: ac.gs,
      track: ac.track,
      source: sourceName,
    });
  }
  return {
    states,
    ac: acMeta,
    source: sourceName,
    n_states: states.length,
    time: Math.floor(Date.now() / 1000),
  };
}

function extractAcList(data) {
  if (!data || typeof data !== 'object') return [];
  if (Array.isArray(data.ac)) return data.ac;
  if (Array.isArray(data.aircraft)) return data.aircraft;
  return [];
}

// adsb.fi rejects some large radii (HTTP 400 around 360nm); keep it ≤250 like Skyway.
const ADSB_FI_MAX_DIST_NM = 250;
const SOURCES = [
  {
    id: 'adsb.lol',
    maxDist: 400,
    url: (lat, lon, dist) =>
      `https://api.adsb.lol/v2/lat/${encodeURIComponent(lat)}/lon/${encodeURIComponent(lon)}/dist/${dist}`,
  },
  {
    id: 'adsb.fi',
    maxDist: ADSB_FI_MAX_DIST_NM,
    url: (lat, lon, dist) =>
      `https://opendata.adsb.fi/api/v2/lat/${encodeURIComponent(lat)}/lon/${encodeURIComponent(lon)}/dist/${dist}`,
  },
];

const sourceStatus = Object.fromEntries(SOURCES.map((s) => [s.id, {
  ok: false,
  lastFetchAt: 0,
  lastCount: 0,
  lastError: '',
  backoffUntil: 0,
}]));
sourceStatus.opensky = { ok: false, lastFetchAt: 0, lastCount: 0, lastError: '', backoffUntil: 0 };

/** Shared cache keyed by lat,lon,dist — single-flight per key. */
const cacheByKey = new Map(); // key -> { at, data, inflight, source }

function adsbCacheKey(lat, lon, dist) {
  return Number(lat).toFixed(2) + ',' + Number(lon).toFixed(2) + ',' + dist;
}

function statusSnapshot(id) {
  const s = sourceStatus[id] || {};
  return {
    ok: !!s.ok,
    lastFetchAgo: s.lastFetchAt ? Math.round((Date.now() - s.lastFetchAt) / 1000) : null,
    lastCount: s.lastCount || 0,
    lastError: s.lastError || null,
    backoffSec: s.backoffUntil && s.backoffUntil > Date.now()
      ? Math.round((s.backoffUntil - Date.now()) / 1000) : 0,
  };
}

async function fetchOneSource(src, lat, lon, dist) {
  const st = sourceStatus[src.id];
  const now = Date.now();
  if (now < st.backoffUntil) {
    return { ok: false, error: 'backoff', payload: null };
  }
  const cappedDist = Math.max(1, Math.min(Number(src.maxDist) || dist, dist));
  const url = src.url(lat, lon, cappedDist);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': UA,
      },
    });
    clearTimeout(timer);
    st.lastFetchAt = Date.now();
    if (!r.ok) {
      st.ok = false;
      st.lastError = 'HTTP ' + r.status;
      st.lastCount = 0;
      if (r.status === 429 || r.status === 503) {
        st.backoffUntil = Date.now() + SOURCE_BACKOFF_MS;
        log(src.id + ' HTTP ' + r.status + ' — backoff ' + (SOURCE_BACKOFF_MS / 1000) + 's', 'WARN');
      }
      return { ok: false, error: st.lastError, payload: null };
    }
    const data = await r.json();
    const list = extractAcList(data);
    const payload = buildAdsbPayload(list, src.id);
    st.lastCount = payload.states.length;
    if (payload.states.length === 0) {
      st.ok = false;
      st.lastError = 'empty';
      return { ok: false, error: 'empty', payload: null };
    }
    st.ok = true;
    st.lastError = '';
    st.backoffUntil = 0;
    return { ok: true, error: null, payload };
  } catch (e) {
    clearTimeout(timer);
    st.ok = false;
    st.lastError = e.name === 'AbortError' ? 'timeout' : (e.message || String(e));
    st.lastFetchAt = Date.now();
    st.lastCount = 0;
    log(src.id + ' ' + st.lastError, 'WARN');
    return { ok: false, error: st.lastError, payload: null };
  }
}

function orderedSources() {
  if (ADSB_PRIMARY === 'adsb.fi') {
    return [SOURCES[1], SOURCES[0]];
  }
  return SOURCES.slice();
}

async function fetchAdsbMulti(lat, lon, distNm) {
  const dist = Math.max(1, Math.min(400, Math.round(Number(distNm) || 360)));
  const key = adsbCacheKey(lat, lon, dist);
  const now = Date.now();
  let entry = cacheByKey.get(key);

  if (entry && entry.data && (now - entry.at) < ADSB_CACHE_FRESH_MS) {
    return entry.data;
  }
  if (entry && entry.inflight) {
    try { return await entry.inflight; } catch (_) { /* fall through */ }
  }

  const run = (async () => {
    const sources = orderedSources();
    let lastError = null;
    for (const src of sources) {
      const result = await fetchOneSource(src, lat, lon, dist);
      if (result.ok && result.payload) {
        const fresh = {
          at: Date.now(),
          data: result.payload,
          inflight: null,
          source: src.id,
        };
        cacheByKey.set(key, fresh);
        log(src.id + ' ok n=' + result.payload.n_states + ' key=' + key, 'OK');
        return result.payload;
      }
      lastError = result.error || lastError;
      // immediately try next on 429/503/empty/error
    }

    // Serve stale on total failure
    entry = cacheByKey.get(key);
    if (entry && entry.data && (Date.now() - entry.at) < ADSB_CACHE_STALE_MS) {
      log('all ADS-B sources failed (' + lastError + ') — serving stale from ' + entry.source, 'WARN');
      return entry.data;
    }
    return null;
  })();

  cacheByKey.set(key, {
    at: (entry && entry.at) || 0,
    data: (entry && entry.data) || null,
    source: (entry && entry.source) || null,
    inflight: run,
  });

  try {
    return await run;
  } finally {
    const cur = cacheByKey.get(key);
    if (cur && cur.inflight === run) cur.inflight = null;
  }
}

let oskyToken = null;
let oskyTokenExp = 0;
async function getOpenSkyToken() {
  if (!OSKY_ID || !OSKY_SECRET) return null;
  if (oskyToken && Date.now() < oskyTokenExp - 60000) return oskyToken;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: OSKY_ID,
    client_secret: OSKY_SECRET,
  });
  const r = await fetch('https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
    body,
  });
  if (!r.ok) throw new Error('OpenSky token HTTP ' + r.status);
  const j = await r.json();
  oskyToken = j.access_token;
  oskyTokenExp = Date.now() + (Number(j.expires_in) || 1800) * 1000;
  return oskyToken;
}

async function fetchOpenSkyStates(bboxPath) {
  const st = sourceStatus.opensky;
  try {
    const headers = { Accept: 'application/json', 'User-Agent': UA };
    try {
      const tk = await getOpenSkyToken();
      if (tk) headers.Authorization = 'Bearer ' + tk;
    } catch (e) {
      log('OpenSky auth: ' + e.message, 'WARN');
      st.lastError = 'auth: ' + e.message;
    }
    const r = await fetch('https://opensky-network.org/api' + bboxPath, { headers });
    st.lastFetchAt = Date.now();
    if (!r.ok) {
      st.ok = false;
      st.lastError = 'HTTP ' + r.status;
      st.lastCount = 0;
      log('OpenSky HTTP ' + r.status, 'WARN');
      return null;
    }
    const data = await r.json();
    const n = Array.isArray(data.states) ? data.states.length : 0;
    st.lastCount = n;
    st.ok = n > 0;
    st.lastError = n ? '' : 'empty';
    return data;
  } catch (e) {
    st.ok = false;
    st.lastError = e.message || String(e);
    st.lastFetchAt = Date.now();
    st.lastCount = 0;
    log('OpenSky ' + e.message, 'ERR');
    return null;
  }
}

async function handleAdsbStates(query, res) {
  let lat, lon, dist, bboxPath;
  if (query.lat != null && query.lon != null) {
    lat = parseFloat(query.lat);
    lon = parseFloat(query.lon);
    dist = parseFloat(query.dist != null ? query.dist : 360);
    if ([lat, lon, dist].some(Number.isNaN)) {
      sendJSON(res, 400, { error: 'invalid lat/lon/dist' });
      return;
    }
    const bb = centerDistToBbox(lat, lon, dist);
    bboxPath = `/states/all?extended=1&lamin=${bb.lamin}&lomin=${bb.lomin}&lamax=${bb.lamax}&lomax=${bb.lomax}`;
  } else {
    sendJSON(res, 400, { error: 'provide lat,lon,dist' });
    return;
  }

  const preferAdsb = ADSB_PRIMARY !== 'opensky' && dist <= 400;
  if (preferAdsb) {
    const adsb = await fetchAdsbMulti(lat, lon, dist);
    if (adsb && adsb.states && adsb.states.length) {
      sendJSON(res, 200, adsb);
      return;
    }
  }
  const osky = await fetchOpenSkyStates(bboxPath);
  const states = (osky && Array.isArray(osky.states)) ? osky.states : [];
  sendJSON(res, 200, {
    states,
    source: 'opensky',
    n_states: states.length,
    time: osky && osky.time ? osky.time : null,
  });
}

async function backgroundRefresh() {
  try {
    const payload = await fetchAdsbMulti(KSFO_DEFAULT.lat, KSFO_DEFAULT.lon, KSFO_DEFAULT.dist);
    if (payload && payload.n_states) {
      log('bg refresh KSFO n=' + payload.n_states + ' via ' + payload.source, 'OK');
    } else {
      log('bg refresh KSFO got empty', 'WARN');
    }
  } catch (e) {
    log('bg refresh ' + (e.message || e), 'WARN');
  }
}


/** Same-origin basemap proxies — Safari often fails mass cross-origin
 *  Image loads (esp. USGS ACAO * + credentials). Server fetch has no CORS.
 *  orbit  = World Dark Gray Base
 *  relief = World Hillshade Dark (Orbit terrain)
 *  sat    = ESRI World Imagery (Follow primary; z19; keyless)
 *  usgs   = USGS ImageryOnly (Follow fallback; max ~z16; pale near SFO)
 *  hill   = World Hillshade light (Follow relief composite) */
const TILE_UPSTREAMS = {
  orbit: [
    (z, y, x) => `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/${z}/${y}/${x}`,
    (z, y, x) => `https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/${z}/${y}/${x}`,
  ],
  relief: [
    (z, y, x) => `https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade_Dark/MapServer/tile/${z}/${y}/${x}`,
    (z, y, x) => `https://services.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade_Dark/MapServer/tile/${z}/${y}/${x}`,
    (z, y, x) => `https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/${z}/${y}/${x}`,
  ],
  sat: [
    (z, y, x) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
    (z, y, x) => `https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
  ],
  usgs: [
    (z, y, x) => `https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/${z}/${y}/${x}`,
    (z, y, x) => `https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/${z}/${y}/${x}`,
  ],
  hill: [
    (z, y, x) => `https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/${z}/${y}/${x}`,
    (z, y, x) => `https://services.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/${z}/${y}/${x}`,
  ],
};
const ORBIT_UPSTREAMS = TILE_UPSTREAMS.orbit; // back-compat alias
const tileProxyCache = new Map(); // key -> { buf, ct, at }
const TILE_CACHE_MAX = 4800;
const TILE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function fetchUpstreamTile(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? require('https') : require('http');
    const req = lib.get(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      },
      timeout: 12000,
    }, (r) => {
      if (r.statusCode && r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        r.resume();
        fetchUpstreamTile(r.headers.location).then(resolve, reject);
        return;
      }
      if (r.statusCode !== 200) {
        r.resume();
        reject(new Error('upstream ' + r.statusCode));
        return;
      }
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => resolve({
        buf: Buffer.concat(chunks),
        ct: r.headers['content-type'] || 'image/jpeg',
      }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function handleProxiedTile(kind, z, y, x, res) {
  const upstreams = TILE_UPSTREAMS[kind];
  if (!upstreams) {
    res.writeHead(404).end('unknown tile kind');
    return;
  }
  const key = kind + ':' + z + '/' + y + '/' + x;
  const cached = tileProxyCache.get(key);
  if (cached && (Date.now() - cached.at) < TILE_CACHE_TTL_MS) {
    res.writeHead(200, {
      'Content-Type': cached.ct,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=86400',
      'X-AirLoom-Tile': 'cache',
      'X-AirLoom-Kind': kind,
    });
    res.end(cached.buf);
    return;
  }
  let lastErr = null;
  for (const mk of upstreams) {
    try {
      const { buf, ct } = await fetchUpstreamTile(mk(z, y, x));
      if (!buf || buf.length < 64) throw new Error('short');
      if (tileProxyCache.size >= TILE_CACHE_MAX) {
        // drop oldest ~10%
        let i = 0;
        for (const k of tileProxyCache.keys()) {
          tileProxyCache.delete(k);
          if (++i > TILE_CACHE_MAX * 0.1) break;
        }
      }
      tileProxyCache.set(key, { buf, ct, at: Date.now() });
      res.writeHead(200, {
        'Content-Type': ct,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=86400',
        'X-AirLoom-Tile': 'miss',
        'X-AirLoom-Kind': kind,
      });
      res.end(buf);
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  log(kind + ' tile fail ' + z + '/' + y + '/' + x + ' ' + (lastErr && lastErr.message), 'WARN');
  res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('tile upstream failed');
}

async function handleOrbitTile(z, y, x, res) {
  return handleProxiedTile('orbit', z, y, x, res);
}


const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    const pathname = u.pathname;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    if (pathname === '/status') {
      const cacheKey = adsbCacheKey(KSFO_DEFAULT.lat, KSFO_DEFAULT.lon, KSFO_DEFAULT.dist);
      const cached = cacheByKey.get(cacheKey);
      const anyOk = SOURCES.some((s) => sourceStatus[s.id] && sourceStatus[s.id].ok)
        || !!(cached && cached.data && cached.data.n_states > 0);
      sendJSON(res, 200, {
        name: 'AirLoom SFO',
        ok: true,
        healthy: anyOk,
        sources: {
          'adsb.lol': statusSnapshot('adsb.lol'),
          'adsb.fi': statusSnapshot('adsb.fi'),
          opensky: statusSnapshot('opensky'),
        },
        // back-compat
        adsbLol: statusSnapshot('adsb.lol'),
        openskyConfigured: !!(OSKY_ID && OSKY_SECRET),
        primary: ADSB_PRIMARY,
        cache: {
          key: cacheKey,
          ageSec: cached && cached.at ? Math.round((Date.now() - cached.at) / 1000) : null,
          n_states: cached && cached.data ? cached.data.n_states : 0,
          source: cached && cached.data ? cached.data.source : null,
        },
      });
      return;
    }

    if (pathname === '/adsb/states') {
      const q = Object.fromEntries(u.searchParams.entries());
      await handleAdsbStates(q, res);
      return;
    }


    // Same-origin Orbit / relief / sat / usgs / hill tiles (z/y/x ArcGIS) — Safari CORS-safe
    {
      const m = pathname.match(/^\/tiles\/(orbit|relief|sat|usgs|hill)\/(\d+)\/(\d+)\/(\d+)(?:\.jpe?g|\.png)?$/);
      if (m) {
        const kind = m[1];
        const z = Number(m[2]), y = Number(m[3]), x = Number(m[4]);
        const zMax = (kind === 'sat' || kind === 'hill') ? 19 : (kind === 'usgs' ? 16 : 18);
        if (!Number.isFinite(z) || !Number.isFinite(y) || !Number.isFinite(x)
            || z < 0 || z > zMax || x < 0 || y < 0 || x >= (1 << z) || y >= (1 << z)) {
          res.writeHead(400).end('bad tile');
          return;
        }
        await handleProxiedTile(kind, z, y, x, res);
        return;
      }
    }

    if (pathname === '/' || pathname === '/airloom' || pathname === '/airloom.html' || pathname === '/index.html') {
      serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
      return;
    }

    if (pathname.startsWith('/vendor/')) {
      const rel = pathname.slice('/vendor/'.length);
      if (rel.includes('..')) {
        res.writeHead(400).end('bad path');
        return;
      }
      serveFile(res, path.join(PUBLIC_DIR, 'vendor', rel));
      return;
    }

    if (pathname.startsWith('/models/')) {
      const rel = pathname.slice('/models/'.length);
      if (!rel || rel.includes('..') || path.isAbsolute(rel)) {
        res.writeHead(400).end('bad path');
        return;
      }
      serveFile(res, path.join(PUBLIC_DIR, 'models', rel));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  } catch (e) {
    log(e.message || String(e), 'ERR');
    if (!res.headersSent) sendJSON(res, 500, { error: 'internal' });
  }
});

server.listen(PORT, () => {
  log(`AirLoom listening on :${PORT}`, 'OK');
  log('Views: /  /airloom', 'OK');
  log('Feed: /adsb/states (adsb.lol → adsb.fi' + (OSKY_ID ? ' → OpenSky)' : ')'), 'OK');
  // Warm cache immediately, then every ~20s
  backgroundRefresh();
  setInterval(backgroundRefresh, BG_REFRESH_MS);
});
