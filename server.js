#!/usr/bin/env node
'use strict';
/**
 * AirLoom SFO — standalone 3D ADS-B viewer + thin /adsb/states proxy.
 * Primary: adsb.lol. Optional fallback: OpenSky (OSKY_ID / OSKY_SECRET).
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
const UA = 'Mozilla/5.0 (compatible; AirLoomSFO/1.0; +https://github.com/skyway4k/airloom-sfo)';

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

function buildAdsbPayload(list) {
  const states = [];
  const acMeta = [];
  for (const ac of list) {
    if (!ac || ac.lat == null || ac.lon == null || !ac.hex) continue;
    states.push(adsbAcToState(ac));
    acMeta.push({
      hex: String(ac.hex || '').toLowerCase(),
      reg: ac.r || null,
      type: ac.t || null,
      flight: (ac.flight || '').trim() || null,
      lat: typeof ac.lat === 'number' ? ac.lat : null,
      lon: typeof ac.lon === 'number' ? ac.lon : null,
      alt_baro: ac.alt_baro,
      gs: ac.gs,
      track: ac.track,
      source: 'adsb.lol',
    });
  }
  return { states, ac: acMeta, source: 'adsb.lol', time: Math.floor(Date.now() / 1000) };
}

const adsbLolStatus = { ok: false, lastFetchAt: 0, lastCount: 0, lastError: '' };
let adsbLolCache = { key: '', at: 0, data: null, inflight: null };
let adsbLolBackoffUntil = 0;
const ADSB_CACHE_FRESH_MS = 25000;
const ADSB_CACHE_STALE_MS = 10 * 60 * 1000;

function adsbCacheKey(lat, lon, dist) {
  return Number(lat).toFixed(2) + ',' + Number(lon).toFixed(2) + ',' + dist;
}

async function fetchAdsbLol(lat, lon, distNm) {
  const dist = Math.max(1, Math.min(250, Math.round(Number(distNm) || 50)));
  const key = adsbCacheKey(lat, lon, dist);
  const now = Date.now();
  if (adsbLolCache.data && adsbLolCache.key === key && (now - adsbLolCache.at) < ADSB_CACHE_FRESH_MS) {
    return adsbLolCache.data;
  }
  if (now < adsbLolBackoffUntil && adsbLolCache.data && (now - adsbLolCache.at) < ADSB_CACHE_STALE_MS) {
    return adsbLolCache.data;
  }
  if (adsbLolCache.inflight && adsbLolCache.key === key) {
    try { return await adsbLolCache.inflight; } catch (_) { /* fall through */ }
  }
  const run = (async () => {
    if (Date.now() < adsbLolBackoffUntil) {
      if (adsbLolCache.data && (Date.now() - adsbLolCache.at) < ADSB_CACHE_STALE_MS) return adsbLolCache.data;
      return null;
    }
    const url = `https://api.adsb.lol/v2/lat/${encodeURIComponent(lat)}/lon/${encodeURIComponent(lon)}/dist/${dist}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
      const r = await fetch(url, {
        signal: ctrl.signal,
        headers: { Accept: 'application/json', 'User-Agent': UA },
      });
      clearTimeout(timer);
      if (!r.ok) {
        adsbLolStatus.ok = false;
        adsbLolStatus.lastError = 'HTTP ' + r.status;
        adsbLolStatus.lastFetchAt = Date.now();
        if (r.status === 429 || r.status === 503) {
          adsbLolBackoffUntil = Date.now() + 60000;
          log('adsb.lol HTTP ' + r.status + ' — backoff 60s', 'WARN');
        }
        if (adsbLolCache.data && (Date.now() - adsbLolCache.at) < ADSB_CACHE_STALE_MS) return adsbLolCache.data;
        return null;
      }
      const data = await r.json();
      const list = Array.isArray(data.ac) ? data.ac : [];
      const payload = buildAdsbPayload(list);
      adsbLolStatus.ok = payload.states.length > 0;
      adsbLolStatus.lastCount = payload.states.length;
      adsbLolStatus.lastError = payload.states.length ? '' : 'empty';
      adsbLolStatus.lastFetchAt = Date.now();
      adsbLolCache = { key, at: Date.now(), data: payload, inflight: null };
      return payload;
    } catch (e) {
      clearTimeout(timer);
      adsbLolStatus.ok = false;
      adsbLolStatus.lastError = e.name === 'AbortError' ? 'timeout' : (e.message || String(e));
      adsbLolStatus.lastFetchAt = Date.now();
      log('adsb.lol ' + adsbLolStatus.lastError, 'WARN');
      if (adsbLolCache.data && (Date.now() - adsbLolCache.at) < ADSB_CACHE_STALE_MS) return adsbLolCache.data;
      return null;
    }
  })();
  adsbLolCache.key = key;
  adsbLolCache.inflight = run;
  try {
    return await run;
  } finally {
    if (adsbLolCache.inflight === run) adsbLolCache.inflight = null;
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
  try {
    const headers = { Accept: 'application/json', 'User-Agent': UA };
    try {
      const tk = await getOpenSkyToken();
      if (tk) headers.Authorization = 'Bearer ' + tk;
    } catch (e) {
      log('OpenSky auth: ' + e.message, 'WARN');
    }
    const r = await fetch('https://opensky-network.org/api' + bboxPath, { headers });
    if (!r.ok) {
      log('OpenSky HTTP ' + r.status, 'WARN');
      return null;
    }
    return await r.json();
  } catch (e) {
    log('OpenSky ' + e.message, 'ERR');
    return null;
  }
}

async function handleAdsbStates(query, res) {
  let lat, lon, dist, bboxPath;
  if (query.lat != null && query.lon != null) {
    lat = parseFloat(query.lat);
    lon = parseFloat(query.lon);
    dist = parseFloat(query.dist != null ? query.dist : 50);
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

  const preferAdsb = ADSB_PRIMARY !== 'opensky' && dist <= 250;
  if (preferAdsb) {
    const adsb = await fetchAdsbLol(lat, lon, dist);
    if (adsb && adsb.states && adsb.states.length) {
      sendJSON(res, 200, adsb);
      return;
    }
  }
  const osky = await fetchOpenSkyStates(bboxPath);
  const states = (osky && Array.isArray(osky.states)) ? osky.states : [];
  sendJSON(res, 200, { states, source: 'opensky', time: osky && osky.time ? osky.time : null });
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
      sendJSON(res, 200, {
        name: 'AirLoom SFO',
        ok: true,
        adsbLol: {
          ok: !!adsbLolStatus.ok,
          lastFetchAgo: adsbLolStatus.lastFetchAt ? Math.round((Date.now() - adsbLolStatus.lastFetchAt) / 1000) : null,
          lastCount: adsbLolStatus.lastCount || 0,
          lastError: adsbLolStatus.lastError || null,
        },
        openskyConfigured: !!(OSKY_ID && OSKY_SECRET),
        primary: ADSB_PRIMARY,
      });
      return;
    }

    if (pathname === '/adsb/states') {
      const q = Object.fromEntries(u.searchParams.entries());
      await handleAdsbStates(q, res);
      return;
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
  log('Feed: /adsb/states (adsb.lol' + (OSKY_ID ? ' + OpenSky fallback)' : ')'), 'OK');
});
