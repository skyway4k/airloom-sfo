'use strict';
/** Shared tile-schedule math (server + bake script). */
const fs = require('fs');
const path = require('path');
const NM_M = 1852;
function loadSchedule(p) {
  return JSON.parse(fs.readFileSync(p || path.join(__dirname, '..', 'tiles-schedule.json'), 'utf8'));
}
function lon2x(lon, z) { return (lon + 180) / 360 * (2 ** z); }
function lat2y(lat, z) {
  const r = lat * Math.PI / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * (2 ** z);
}
function x2lon(x, z) { return x / (2 ** z) * 360 - 180; }
function y2lat(y, z) { const n = Math.PI - 2 * Math.PI * y / (2 ** z); return 180 / Math.PI * Math.atan(Math.sinh(n)); }
/** Tiles whose centre lies within radiusNm (plus half a tile) of centre. */
function tilesInRadius(center, z, radiusNm) {
  const out = [];
  const cosLat = Math.cos(center.lat * Math.PI / 180);
  const dLat = radiusNm / 60, dLon = radiusNm / (60 * cosLat);
  const x0 = Math.floor(lon2x(center.lon - dLon, z)), x1 = Math.floor(lon2x(center.lon + dLon, z));
  const y0 = Math.floor(lat2y(center.lat + dLat, z)), y1 = Math.floor(lat2y(center.lat - dLat, z));
  const tileNm = 360 / (2 ** z) * 60 * cosLat;
  const lim = radiusNm + tileNm * 0.71;
  for (let y = y0; y <= y1; y++) {
    const lat = y2lat(y + 0.5, z);
    for (let x = x0; x <= x1; x++) {
      const lon = x2lon(x + 0.5, z);
      const dn = (lat - center.lat) * 60, de = (lon - center.lon) * 60 * cosLat;
      if (dn * dn + de * de <= lim * lim) out.push([z, y, x]);
    }
  }
  return out;
}
function inSchedule(sched, kind, z, y, x) {
  const L = sched.layers[kind];
  if (!L || L[z] == null) return false;
  const c = sched.center;
  const cosLat = Math.cos(c.lat * Math.PI / 180);
  const lat = y2lat(y + 0.5, z), lon = x2lon(x + 0.5, z);
  const dn = (lat - c.lat) * 60, de = (lon - c.lon) * 60 * cosLat;
  const tileNm = 360 / (2 ** z) * 60 * cosLat;
  const lim = L[z] + tileNm * 0.71;
  return dn * dn + de * de <= lim * lim;
}
module.exports = { loadSchedule, tilesInRadius, inSchedule, NM_M };
