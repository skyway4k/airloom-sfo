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
const UA = 'AirLoomSFO/1.7 (+https://sfo3d.onrender.com; airloom-sfo)';
// FlightAware AeroAPI (optional): destination truth + scheduled GA inbounds beyond ADS-B range.
// Off unless AEROAPI_KEY is set. Never scrape flightaware.com web pages (FA ToS §7 forbids robots).
const AEROAPI_KEY = process.env.AEROAPI_KEY || '';
const AEROAPI_BASE = (process.env.AEROAPI_BASE || 'https://aeroapi.flightaware.com/aeroapi').replace(/\/+$/, '');
const AEROAPI_AIRPORT = (process.env.AEROAPI_AIRPORT || 'KSFO').toUpperCase();
const AEROAPI_POLL_SEC = Math.max(120, Number(process.env.AEROAPI_POLL_SEC || 600));
const AEROAPI_MAX_PAGES = Math.max(1, Math.min(10, Number(process.env.AEROAPI_MAX_PAGES || 3)));
const AEROAPI_WINDOW_H = Math.max(1, Math.min(47, Number(process.env.AEROAPI_WINDOW_H || 12)));
// Only spend AeroAPI queries while someone is actually watching.
const AEROAPI_IDLE_STOP_MS = 15 * 60 * 1000;
// HARD spend caps (Skyway v249 lesson: an uncapped key ran up $580). All env-only.
// scheduled_arrivals bills $0.005 per result-set page (15 records) per FA's public price list.
const AEROAPI_COST_PER_PAGE = Number(process.env.AEROAPI_COST_PER_PAGE || 0.005);
const AEROAPI_DAILY_MAX_CALLS = Math.max(0, Number(process.env.AEROAPI_DAILY_MAX_CALLS || 48));
const AEROAPI_DAILY_MAX_USD = Math.max(0, Number(process.env.AEROAPI_DAILY_MAX_USD || 0.5));
const AEROAPI_MONTHLY_MAX_USD = Math.max(0, Number(process.env.AEROAPI_MONTHLY_MAX_USD || 5));
// Fail closed: billable calls only after FA's own /account/usage (free, all keys) confirmed
// month-to-date + today spend is under the caps within the last hour. Survives restarts.
const AEROAPI_REQUIRE_USAGE_CHECK = process.env.AEROAPI_REQUIRE_USAGE_CHECK !== '0';
const AEROAPI_USAGE_CHECK_MS = 20 * 60 * 1000;

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

/**
 * readsb/adsb.lol dbFlags bitmask:
 *   military=1, interesting=2, PIA=4, LADD=8
 * PIA and LADD stay in the feed (track/type/pos). Reg is redacted so the
 * client shows ident BLOCKED / PIA — never invent a real N-number.
 */
const BIZJET_TYPE_RE = /^(CL[236]0|CL35|GLF[2-6]|GL[567]T|GLEX|GA[567]C|C25[ABCM]|C500|C525|C550|C560|C56X|C680|C68A|C700|C750|FA[578]X?|FA20|FA10|F2TH|F900|LJ[34567][0-9]?|G150|G200|G280|GALX|BE40|HA4T|H25B|PC24|E50P|E55P|E545|E550|PRM1|HDJT|SF50)$/i;

function looksLikeUsTail(s) {
  const t = String(s || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^N[0-9][A-Z0-9]{0,5}$/.test(t);
}

function classifyPrivacy(ac) {
  const flags = Number(ac.dbFlags) || 0;
  const ownOp = (ac.ownOp != null ? String(ac.ownOp) : '').trim();
  const ownLower = ownOp.toLowerCase();
  const piaFlag = !!(flags & 4) || /\bpia\b/.test(ownLower);
  const laddFlag = !!(flags & 8) || /\b(ladd|barr|blocked)\b/.test(ownLower)
    || (/\bprivacy\b/.test(ownLower) && !piaFlag);
  const regRaw = (ac.r != null ? String(ac.r).trim() : '');
  const flightRaw = (ac.flight != null ? String(ac.flight).trim() : '');
  const typ = (ac.t != null ? String(ac.t).trim().toUpperCase() : '');
  const cat = ac.category != null ? String(ac.category).trim().toUpperCase() : '';
  const onGround = ac.alt_baro === 'ground' || ac.alt_baro === 'GROUND';
  const noReg = !regRaw;
  const jetish = !!(typ && BIZJET_TYPE_RE.test(typ)) || /^A[23]$/.test(cat);
  // FA-style blocked: airborne jet with no public reg (Mode-S hex still present)
  const faStyle = noReg && jetish && !onGround;
  const privacy = piaFlag || laddFlag || faStyle;
  return {
    flags,
    pia: piaFlag,
    ladd: laddFlag,
    blocked: privacy, // any privacy withholding of public reg/ident
    faStyle,
    regRaw,
    flightRaw,
    typ,
    ownOp: ownOp || null,
  };
}

function buildAdsbPayload(list, sourceName) {
  beginScheduleMatch();
  const states = [];
  const acMeta = [];
  for (const ac of list) {
    if (!ac || ac.lat == null || ac.lon == null || !ac.hex) continue;
    const priv = classifyPrivacy(ac);
    // Clone lightly so we can redact flight for OpenSky-style state row
    const acForState = priv.blocked
      ? Object.assign({}, ac, {
          // Keep operator CS when it is not a civil tail; blank US-tail flight
          flight: looksLikeUsTail(priv.flightRaw) ? '' : (priv.flightRaw || ''),
          r: null,
        })
      : ac;
    states.push(adsbAcToState(acForState));
    const flightOut = priv.blocked && looksLikeUsTail(priv.flightRaw)
      ? null
      : ((ac.flight || '').trim() || null);
    // Destination truth (AeroAPI scheduled_arrivals match by tail / callsign / hex).
    const dst = matchScheduleForAc(ac, priv);
    acMeta.push({
      hex: String(ac.hex || '').toLowerCase(),
      // Never leak registry for PIA / LADD / FA-style privacy aircraft
      reg: priv.blocked ? null : (priv.regRaw || null),
      // Prefer ADS-B/FAA ICAO type code (ac.t) — never invent labels server-side
      type: (ac.t != null && String(ac.t).trim()) ? String(ac.t).trim().toUpperCase() : null,
      desc: ac.desc || null,
      flight: flightOut,
      lat: typeof ac.lat === 'number' ? ac.lat : null,
      lon: typeof ac.lon === 'number' ? ac.lon : null,
      alt_baro: ac.alt_baro,
      gs: ac.gs,
      track: ac.track,
      category: ac.category != null ? String(ac.category) : null,
      dbFlags: priv.flags || 0,
      ownOp: priv.ownOp,
      pia: !!priv.pia,
      ladd: !!priv.ladd,
      blocked: !!priv.blocked,
      source: sourceName,
      dst: dst,
    });
  }
  return {
    states,
    ac: acMeta,
    sched: scheduleSummary(),
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

// adsb.fi rejects some large radii (HTTP 400 around 360nm); keep it ≤250.
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


/* ───────────────────────── FlightAware AeroAPI (optional) ─────────────────────────
 * GET /airports/{id}/flights/scheduled_arrivals?type=General_Aviation returns undeparted
 * AND en-route GA flights filed to the airport (ordered by estimated_on). We use it as
 * destination truth for ADS-B targets (match by tail / callsign; hex remembered after a
 * match) and to list filed inbounds still beyond ADS-B range.
 * Blocked (LADD/FA-blocked) flights are NOT visible in AeroAPI unless the owner grants
 * access — those stay ADS-B-only (BLOCKED/PIA geometry path in the client).
 */
const aeroState = {
  enabled: !!AEROAPI_KEY,
  ok: false,
  lastFetchAt: 0,
  lastError: AEROAPI_KEY ? '' : 'AEROAPI_KEY not set',
  flights: [],        // normalized scheduled/en-route arrivals
  byKey: new Map(),   // normalized tail/ident/callsign -> flight
  hexToId: new Map(), // icao24 hex -> fa_flight_id (sticky after a match)
  inflight: null,
  queries: 0,
  pagesBilled: 0,
  // spend ledger (local, reconciled with FA /account/usage)
  dayKey: '',
  monthKey: '',
  dayCalls: 0,
  dayUsd: 0,
  monthUsd: 0,
  usageCheckedAt: 0,
  usageError: '',
  capBlocked: '',
};
let lastClientAt = 0;
let buildMatches = new Map(); // fa_flight_id -> hex (per payload build)

function normIdent(s) {
  return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');
}
function isoNoMs(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
function toEpoch(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.round(t / 1000) : null;
}

function normalizeAeroFlight(f) {
  if (!f || f.cancelled) return null;
  const dest = f.destination || {};
  const orig = f.origin || {};
  const blocked = !!f.blocked;
  return {
    id: f.fa_flight_id || null,
    ident: blocked ? 'BLOCKED' : (f.ident || null),
    identIcao: blocked ? null : (f.ident_icao || null),
    atcIdent: blocked ? null : (f.atc_ident || null),
    reg: blocked ? null : (f.registration || null),
    type: f.aircraft_type || null,
    origin: orig.code_icao || orig.code || null,
    originName: orig.city || orig.name || null,
    dest: dest.code_icao || dest.code || AEROAPI_AIRPORT,
    schedOn: toEpoch(f.scheduled_on),
    etaOn: toEpoch(f.estimated_on) || toEpoch(f.scheduled_on),
    actualOff: toEpoch(f.actual_off),
    actualOn: toEpoch(f.actual_on),
    status: f.status || null,
    progress: f.progress_percent != null ? Number(f.progress_percent) : null,
    blocked,
    positionOnly: !!f.position_only,
    diverted: !!f.diverted,
  };
}

function rebuildAeroIndex(list) {
  const byKey = new Map();
  for (const fl of list) {
    if (fl.blocked) continue;
    for (const k of [fl.reg, fl.ident, fl.identIcao, fl.atcIdent]) {
      const n = normIdent(k);
      if (!n) continue;
      const prev = byKey.get(n);
      // Prefer the en-route leg (departed, not landed), else the soonest ETA
      const score = (x) => (x.actualOff && !x.actualOn ? 0 : 1e10) + (x.etaOn || 9e9);
      if (!prev || score(fl) < score(prev)) byKey.set(n, fl);
    }
  }
  aeroState.byKey = byKey;
}


function utcDayKey(ms) { return new Date(ms).toISOString().slice(0, 10); }
function utcMonthKey(ms) { return new Date(ms).toISOString().slice(0, 7); }

function rollLedger() {
  const now = Date.now();
  const d = utcDayKey(now), m = utcMonthKey(now);
  if (aeroState.dayKey !== d) { aeroState.dayKey = d; aeroState.dayCalls = 0; aeroState.dayUsd = 0; }
  if (aeroState.monthKey !== m) { aeroState.monthKey = m; aeroState.monthUsd = 0; }
}

async function aeroUsageQuery(startIso) {
  const qs = new URLSearchParams({ start: startIso, all_keys: 'true' });
  const r = await fetch(`${AEROAPI_BASE}/account/usage?${qs}`, {
    headers: { 'x-apikey': AEROAPI_KEY, Accept: 'application/json', 'User-Agent': UA },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error('usage HTTP ' + r.status);
  const j = await r.json();
  const cost = Number(j.total_cost);
  if (!Number.isFinite(cost)) throw new Error('usage: no total_cost');
  return { cost, calls: Number(j.total_calls) || 0 };
}

/** Reconcile local ledger with FlightAware's own account usage (free endpoint). */
async function refreshAeroUsage(force) {
  if (!AEROAPI_KEY) return;
  if (!force && Date.now() - aeroState.usageCheckedAt < AEROAPI_USAGE_CHECK_MS) return;
  rollLedger();
  try {
    const now = Date.now();
    const month = await aeroUsageQuery(utcMonthKey(now) + '-01');
    const day = await aeroUsageQuery(utcDayKey(now));
    aeroState.monthUsd = Math.max(aeroState.monthUsd, month.cost);
    aeroState.dayUsd = Math.max(aeroState.dayUsd, day.cost);
    aeroState.usageCheckedAt = Date.now();
    aeroState.usageError = '';
    log('AeroAPI usage (all keys) month $' + month.cost.toFixed(3) + ' today $' + day.cost.toFixed(3), 'OK');
  } catch (e) {
    aeroState.usageError = e.message || String(e);
    log('AeroAPI usage check failed: ' + aeroState.usageError, 'WARN');
  }
}

/** Returns '' when a billable call is allowed, else the reason it is blocked. */
function aeroCapReason() {
  rollLedger();
  const worst = AEROAPI_MAX_PAGES * AEROAPI_COST_PER_PAGE;
  if (AEROAPI_REQUIRE_USAGE_CHECK && (Date.now() - aeroState.usageCheckedAt) > 60 * 60 * 1000) {
    return 'usage check unavailable (' + (aeroState.usageError || 'pending') + ') — failing closed';
  }
  if (aeroState.dayCalls >= AEROAPI_DAILY_MAX_CALLS) return 'daily call cap ' + AEROAPI_DAILY_MAX_CALLS;
  if (aeroState.dayUsd + worst > AEROAPI_DAILY_MAX_USD) return 'daily $ cap ' + AEROAPI_DAILY_MAX_USD;
  if (aeroState.monthUsd + worst > AEROAPI_MONTHLY_MAX_USD) return 'monthly $ cap ' + AEROAPI_MONTHLY_MAX_USD;
  return '';
}

async function fetchAeroArrivals() {
  if (!AEROAPI_KEY) return null;
  if (aeroState.inflight) return aeroState.inflight;
  aeroState.inflight = (async () => {
    await refreshAeroUsage(false);
    const capWhy = aeroCapReason();
    if (capWhy) {
      if (aeroState.capBlocked !== capWhy) log('AeroAPI paused: ' + capWhy, 'WARN');
      aeroState.capBlocked = capWhy;
      aeroState.lastError = 'cap: ' + capWhy;
      aeroState.lastFetchAt = Date.now(); // back off a full poll interval
      return null;
    }
    aeroState.capBlocked = '';
    const now = Date.now();
    const qs = new URLSearchParams({
      type: 'General_Aviation',
      start: isoNoMs(now - 90 * 60 * 1000),
      end: isoNoMs(now + AEROAPI_WINDOW_H * 3600 * 1000),
      max_pages: String(AEROAPI_MAX_PAGES),
    });
    const url = `${AEROAPI_BASE}/airports/${encodeURIComponent(AEROAPI_AIRPORT)}/flights/scheduled_arrivals?${qs}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const r = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'x-apikey': AEROAPI_KEY, Accept: 'application/json', 'User-Agent': UA },
      });
      clearTimeout(timer);
      aeroState.lastFetchAt = Date.now();
      aeroState.queries++;
      aeroState.dayCalls++;
      // Pessimistic local charge until FA usage reconciles (failed calls may still bill)
      aeroState.dayUsd += AEROAPI_COST_PER_PAGE;
      aeroState.monthUsd += AEROAPI_COST_PER_PAGE;
      if (!r.ok) {
        aeroState.ok = false;
        aeroState.lastError = 'HTTP ' + r.status;
        log('AeroAPI HTTP ' + r.status, 'WARN');
        return null;
      }
      const j = await r.json();
      const pages = Math.max(1, Number(j.num_pages) || 1);
      aeroState.pagesBilled += pages;
      aeroState.dayUsd += (pages - 1) * AEROAPI_COST_PER_PAGE;
      aeroState.monthUsd += (pages - 1) * AEROAPI_COST_PER_PAGE;
      const raw = Array.isArray(j.scheduled_arrivals) ? j.scheduled_arrivals : [];
      const list = raw.map(normalizeAeroFlight).filter((f) => f && !f.actualOn);
      list.sort((a, b) => (a.etaOn || 9e12) - (b.etaOn || 9e12));
      aeroState.flights = list;
      rebuildAeroIndex(list);
      aeroState.ok = true;
      aeroState.lastError = '';
      log('AeroAPI ' + AEROAPI_AIRPORT + ' GA scheduled/en-route n=' + list.length + ' pages=' + (j.num_pages || 1), 'OK');
      return list;
    } catch (e) {
      clearTimeout(timer);
      aeroState.ok = false;
      aeroState.lastFetchAt = Date.now();
      aeroState.lastError = e.name === 'AbortError' ? 'timeout' : (e.message || String(e));
      log('AeroAPI ' + aeroState.lastError, 'WARN');
      return null;
    } finally {
      aeroState.inflight = null;
    }
  })();
  return aeroState.inflight;
}

function aeroFresh() {
  return aeroState.enabled && aeroState.ok
    && (Date.now() - aeroState.lastFetchAt) < (AEROAPI_POLL_SEC * 1000 * 2.5);
}

function maybeRefreshAero() {
  if (!AEROAPI_KEY) return;
  const now = Date.now();
  if (now - lastClientAt > AEROAPI_IDLE_STOP_MS && aeroState.lastFetchAt) return; // nobody watching
  if (now - aeroState.lastFetchAt < AEROAPI_POLL_SEC * 1000) return;
  fetchAeroArrivals().catch(() => {});
}

function beginScheduleMatch() { buildMatches = new Map(); }

/** Match one ADS-B aircraft to an AeroAPI arrival. Returns a compact dst object or null. */
function matchScheduleForAc(ac, priv) {
  if (!aeroFresh()) return null;
  const hex = String(ac.hex || '').toLowerCase();
  let fl = null;
  let via = null;
  const keys = [
    ['reg', ac.r],
    ['callsign', ac.flight],
  ];
  for (const [kind, v] of keys) {
    const n = normIdent(v);
    if (n && aeroState.byKey.has(n)) { fl = aeroState.byKey.get(n); via = kind; break; }
  }
  if (!fl && hex && aeroState.hexToId.has(hex)) {
    const id = aeroState.hexToId.get(hex);
    fl = aeroState.flights.find((x) => x.id === id) || null;
    if (fl) via = 'hex';
  }
  if (!fl) return null;
  if (hex && fl.id) {
    aeroState.hexToId.set(hex, fl.id);
    buildMatches.set(fl.id, hex);
  }
  return {
    icao: fl.dest || AEROAPI_AIRPORT,
    src: 'aeroapi',
    via,
    origin: fl.origin,
    eta: fl.etaOn,
    type: fl.type,
    // Never echo a schedule ident for privacy-masked ADS-B targets
    ident: priv && priv.blocked ? null : (fl.ident || null),
  };
}

/** Compact schedule list for the client (filed inbounds, incl. beyond ADS-B range). */
function scheduleSummary() {
  const base = {
    enabled: aeroState.enabled,
    authoritative: aeroFresh(),
    source: aeroState.enabled ? 'aeroapi' : null,
    airport: AEROAPI_AIRPORT,
    fetchedAgoSec: aeroState.lastFetchAt ? Math.round((Date.now() - aeroState.lastFetchAt) / 1000) : null,
    error: aeroState.lastError || null,
    flights: [],
  };
  if (!aeroFresh()) return base;
  base.flights = aeroState.flights.slice(0, 60).map((f) => ({
    id: f.id, ident: f.ident, reg: f.reg, type: f.type, origin: f.origin,
    eta: f.etaOn, sched: f.schedOn, off: f.actualOff, status: f.status,
    progress: f.progress, blocked: f.blocked,
    hex: (f.id && buildMatches.get(f.id)) || null,
  }));
  return base;
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

/** ─── airloom-v27 tile cache ────────────────────────────────────────────────
 *  Lookup order: memory LRU → baked image dir (/app/tilecache, built into the
 *  Docker image by tools/bake-tiles.js) → runtime disk (/tmp) → upstream ESRI
 *  (keep-alive agent + single-flight). All hits are served with a strong ETag and
 *  `public, max-age=31536000, immutable` (tile URLs are content-stable z/y/x). */
const crypto = require('crypto');
const https = require('https');
const { loadSchedule, tilesInRadius, inSchedule } = require('./tools/tile-schedule');
const TILE_SCHEDULE = (() => { try { return loadSchedule(path.join(__dirname, 'tiles-schedule.json')); } catch (_) { return null; } })();
const BAKED_DIR = process.env.TILE_BAKED_DIR || path.join(__dirname, 'tilecache');
const RUNTIME_DIR = process.env.TILE_RUNTIME_DIR || path.join(require('os').tmpdir(), 'airloom-tiles');
const TILE_MEM_MAX_BYTES = Number(process.env.TILE_MEM_MB || 72) * 1048576;
const TILE_IMMUTABLE = 'public, max-age=31536000, immutable';
const upstreamAgent = new https.Agent({ keepAlive: true, maxSockets: 24, maxFreeSockets: 24, keepAliveMsecs: 15000 });
const tileMem = new Map(); // key -> { buf, ct, etag, src }
let tileMemBytes = 0;
const tileInflight = new Map();
const tileStats = { mem: 0, baked: 0, disk: 0, miss: 0, fail: 0, n304: 0 };
let bakeInfo = null;
try { bakeInfo = JSON.parse(fs.readFileSync(path.join(BAKED_DIR, 'bake.json'), 'utf8')); } catch (_) {}
const tileWarm = { state: 'idle', total: 0, done: 0, startedAt: null, finishedAt: null, seconds: null, memTiles: 0, memMB: 0, source: null };

function memGet(key) {
  const e = tileMem.get(key);
  if (!e) return null;
  tileMem.delete(key); tileMem.set(key, e); // LRU touch
  return e;
}
function memPut(key, e) {
  if (tileMem.has(key)) { tileMemBytes -= tileMem.get(key).buf.length; tileMem.delete(key); }
  tileMem.set(key, e); tileMemBytes += e.buf.length;
  while (tileMemBytes > TILE_MEM_MAX_BYTES && tileMem.size) {
    const k = tileMem.keys().next().value;
    tileMemBytes -= tileMem.get(k).buf.length; tileMem.delete(k);
  }
}
function mkEntry(buf, ct, src) {
  return { buf, ct: ct || 'image/jpeg', src, etag: '"' + crypto.createHash('sha1').update(buf).digest('base64url').slice(0, 20) + '"' };
}
function tileFile(dir, kind, z, y, x) { return path.join(dir, kind, String(z), String(y), x + '.jpg'); }
function readFileOrNull(f) {
  return new Promise((resolve) => fs.readFile(f, (err, b) => resolve(err || !b || b.length < 64 ? null : b)));
}

function fetchUpstreamTile(url, depth) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      agent: upstreamAgent,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AirLoomSFO/27; +https://sfo3d.onrender.com)',
        Accept: 'image/avif,image/webp,image/apng,image/jpeg,image/*,*/*;q=0.8',
        Referer: 'https://sfo3d.onrender.com/',
      },
      timeout: 12000,
    }, (r) => {
      if (r.statusCode && r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && (depth || 0) < 3) {
        r.resume();
        fetchUpstreamTile(r.headers.location, (depth || 0) + 1).then(resolve, reject);
        return;
      }
      if (r.statusCode !== 200) { r.resume(); reject(new Error('upstream ' + r.statusCode)); return; }
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => resolve({ buf: Buffer.concat(chunks), ct: r.headers['content-type'] || 'image/jpeg' }));
      r.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/** Resolve a tile through every cache tier (single-flight per key). */
function getTile(kind, z, y, x) {
  const key = kind + ':' + z + '/' + y + '/' + x;
  const hit = memGet(key);
  if (hit) { tileStats.mem++; return Promise.resolve({ e: hit, tier: 'mem' }); }
  if (tileInflight.has(key)) return tileInflight.get(key);
  const p = (async () => {
    let b = await readFileOrNull(tileFile(BAKED_DIR, kind, z, y, x));
    if (b) { const e = mkEntry(b, 'image/jpeg', 'baked'); memPut(key, e); tileStats.baked++; return { e, tier: 'baked' }; }
    b = await readFileOrNull(tileFile(RUNTIME_DIR, kind, z, y, x));
    if (b) { const e = mkEntry(b, 'image/jpeg', 'disk'); memPut(key, e); tileStats.disk++; return { e, tier: 'disk' }; }
    const upstreams = TILE_UPSTREAMS[kind];
    let lastErr = null;
    for (const mk of upstreams) {
      try {
        const { buf, ct } = await fetchUpstreamTile(mk(z, y, x));
        if (!buf || buf.length < 64) throw new Error('short');
        const e = mkEntry(buf, ct, 'upstream');
        memPut(key, e);
        const f = tileFile(RUNTIME_DIR, kind, z, y, x);
        fs.mkdir(path.dirname(f), { recursive: true }, () => fs.writeFile(f, buf, () => {}));
        tileStats.miss++;
        return { e, tier: 'miss' };
      } catch (err) { lastErr = err; }
    }
    tileStats.fail++;
    throw lastErr || new Error('upstream failed');
  })();
  tileInflight.set(key, p);
  p.finally(() => tileInflight.delete(key)).catch(() => {});
  return p;
}

async function handleProxiedTile(kind, z, y, x, res, req) {
  if (!TILE_UPSTREAMS[kind]) { res.writeHead(404).end('unknown tile kind'); return; }
  try {
    const { e, tier } = await getTile(kind, z, y, x);
    const h = {
      'Content-Type': e.ct,
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Cache-Control': TILE_IMMUTABLE,
      ETag: e.etag,
      'X-AirLoom-Tile': tier,
      'X-AirLoom-Kind': kind,
    };
    if (req && req.headers['if-none-match'] === e.etag) { tileStats.n304++; res.writeHead(304, h); res.end(); return; }
    h['Content-Length'] = e.buf.length;
    res.writeHead(200, h);
    res.end(e.buf);
  } catch (err) {
    log(kind + ' tile fail ' + z + '/' + y + '/' + x + ' ' + (err && err.message), 'WARN');
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('tile upstream failed');
  }
}

/** Boot warm: preload the coarse Bay set into RAM; if the image has no bake
 *  (local dev / failed bake) fetch the whole schedule into /tmp in the background. */
async function warmTileCacheOnBoot() {
  if (!TILE_SCHEDULE) return;
  const t0 = Date.now();
  const baked = !!(bakeInfo && bakeInfo.ok + bakeInfo.skipped > 0);
  tileWarm.state = 'warming'; tileWarm.startedAt = new Date().toISOString();
  tileWarm.source = baked ? 'baked-image' : 'upstream→/tmp';
  const jobs = [];
  const zs = new Set();
  for (const k of Object.keys(TILE_SCHEDULE.layers)) for (const z of Object.keys(TILE_SCHEDULE.layers[k])) zs.add(+z);
  for (const z of [...zs].sort((a, b) => a - b)) {
    for (const kind of Object.keys(TILE_SCHEDULE.layers)) {
      const r = TILE_SCHEDULE.layers[kind][z];
      if (r == null) continue;
      // Baked: only pull coarse levels (z<=11) into RAM — the rest is already local disk.
      if (baked && z > 11) continue;
      for (const t of tilesInRadius(TILE_SCHEDULE.center, z, r)) jobs.push([kind, ...t]);
    }
  }
  tileWarm.total = jobs.length;
  let i = 0;
  const conc = baked ? 16 : 8;
  await Promise.all(Array.from({ length: conc }, async () => {
    while (i < jobs.length) {
      const [kind, z, y, x] = jobs[i++];
      try { await getTile(kind, z, y, x); } catch (_) {}
      tileWarm.done++;
    }
  }));
  tileWarm.state = 'ready';
  tileWarm.finishedAt = new Date().toISOString();
  tileWarm.seconds = +((Date.now() - t0) / 1000).toFixed(1);
  tileWarm.memTiles = tileMem.size;
  tileWarm.memMB = +(tileMemBytes / 1048576).toFixed(1);
  log(`tile warm ${tileWarm.source}: ${tileWarm.done} tiles in ${tileWarm.seconds}s, RAM ${tileWarm.memMB}MB (${tileMem.size} tiles)`, 'OK');
}

function tileManifest() {
  return {
    build: 'airloom-v27',
    schedule: TILE_SCHEDULE,
    baked: bakeInfo ? {
      tiles: bakeInfo.ok + bakeInfo.skipped, total: bakeInfo.total, mb: bakeInfo.mb, seconds: bakeInfo.seconds,
      complete: bakeInfo.complete, bakedAt: bakeInfo.bakedAt, perKind: bakeInfo.perKind,
    } : null,
    warm: tileWarm,
    mem: { tiles: tileMem.size, mb: +(tileMemBytes / 1048576).toFixed(1), capMB: TILE_MEM_MAX_BYTES / 1048576 },
    stats: tileStats,
    cacheControl: TILE_IMMUTABLE,
  };
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
        aeroapi: {
          enabled: aeroState.enabled,
          ok: aeroState.ok,
          authoritative: aeroFresh(),
          airport: AEROAPI_AIRPORT,
          lastFetchAgo: aeroState.lastFetchAt ? Math.round((Date.now() - aeroState.lastFetchAt) / 1000) : null,
          n: aeroState.flights.length,
          queries: aeroState.queries,
          pagesBilled: aeroState.pagesBilled,
          pollSec: AEROAPI_POLL_SEC,
          lastError: aeroState.lastError || null,
          caps: {
            dailyCalls: AEROAPI_DAILY_MAX_CALLS, dailyUsd: AEROAPI_DAILY_MAX_USD,
            monthlyUsd: AEROAPI_MONTHLY_MAX_USD, maxPagesPerCall: AEROAPI_MAX_PAGES,
          },
          spend: {
            dayCalls: aeroState.dayCalls,
            dayUsd: Number(aeroState.dayUsd.toFixed(4)),
            monthUsd: Number(aeroState.monthUsd.toFixed(4)),
            usageCheckedAgo: aeroState.usageCheckedAt ? Math.round((Date.now() - aeroState.usageCheckedAt) / 1000) : null,
            usageError: aeroState.usageError || null,
            pausedBy: aeroState.capBlocked || null,
          },
        },
        faWebScrape: 'disabled (FlightAware ToS forbids automated page retrieval; use AEROAPI_KEY)',
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

    if (pathname === '/arrivals/schedule') {
      lastClientAt = Date.now();
      maybeRefreshAero();
      sendJSON(res, 200, scheduleSummary());
      return;
    }

    if (pathname === '/adsb/states') {
      lastClientAt = Date.now();
      maybeRefreshAero();
      const q = Object.fromEntries(u.searchParams.entries());
      await handleAdsbStates(q, res);
      return;
    }


    if (pathname === '/tiles/manifest') {
      sendJSON(res, 200, tileManifest());
      return;
    }

    if (pathname === '/sw.js') {
      fs.readFile(path.join(PUBLIC_DIR, 'sw.js'), (err, data) => {
        if (err) { res.writeHead(404).end('Not found'); return; }
        res.writeHead(200, {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Service-Worker-Allowed': '/',
        });
        res.end(data);
      });
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
        await handleProxiedTile(kind, z, y, x, res, req);
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
  // airloom-v27: Bay tile cache warm (baked image → RAM, or upstream → /tmp)
  setTimeout(() => { warmTileCacheOnBoot().catch((e) => log('tile warm ' + (e.message || e), 'WARN')); }, 50);
  // Warm cache immediately, then every ~20s
  backgroundRefresh();
  setInterval(backgroundRefresh, BG_REFRESH_MS);
  if (AEROAPI_KEY) {
    log('AeroAPI enabled for ' + AEROAPI_AIRPORT + ' (GA scheduled_arrivals every ' + AEROAPI_POLL_SEC + 's while viewed)', 'OK');
    log('AeroAPI caps: ' + AEROAPI_DAILY_MAX_CALLS + ' calls/day, $' + AEROAPI_DAILY_MAX_USD + '/day, $' + AEROAPI_MONTHLY_MAX_USD + '/month (all keys, via /account/usage)', 'OK');
    refreshAeroUsage(true)
      .then(() => fetchAeroArrivals())
      .then(() => { cacheByKey.clear(); })
      .catch(() => {});
    setInterval(maybeRefreshAero, 30000);
  } else {
    log('AeroAPI off (set AEROAPI_KEY to enable destination truth + scheduled inbounds)', 'INFO');
  }
});
