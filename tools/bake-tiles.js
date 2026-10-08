#!/usr/bin/env node
'use strict';
/**
 * airloom-v27 build-time tile bake.
 * Downloads the Bay Area basemap set (tiles-schedule.json) into <outDir>/<kind>/<z>/<y>/<x>.jpg
 * so the Render image boots with every high-res Bay tile already on local disk
 * (free plan has no persistent disk and its runtime FS is wiped on every sleep/deploy).
 * Never fails the build: partial bakes are fine — the server proxies anything missing.
 *
 * usage: node tools/bake-tiles.js <outDir> [concurrency]
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { loadSchedule, tilesInRadius } = require('./tile-schedule');

const OUT = path.resolve(process.argv[2] || 'tilecache');
const CONC = Math.max(1, Number(process.argv[3] || process.env.BAKE_CONC || 32));
const MAX_MIN = Number(process.env.BAKE_MAX_MIN || 14); // hard stop so a slow upstream never hangs the build
const SVC = {
  sat: 'World_Imagery',
  hill: 'Elevation/World_Hillshade',
  orbit: 'Canvas/World_Dark_Gray_Base',
  relief: 'Elevation/World_Hillshade_Dark',
};
const HOSTS = ['server.arcgisonline.com', 'services.arcgisonline.com'];
const agent = new https.Agent({ keepAlive: true, maxSockets: CONC, maxFreeSockets: CONC });

function get(host, p) {
  return new Promise((resolve, reject) => {
    const req = https.get({ host, path: p, agent, timeout: 20000,
      headers: { 'User-Agent': 'AirLoomSFO-bake/27 (+https://sfo3d.onrender.com)', Referer: 'https://sfo3d.onrender.com/' } }, (r) => {
      if (r.statusCode !== 200) { r.resume(); reject(new Error('HTTP ' + r.statusCode)); return; }
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => resolve(Buffer.concat(chunks)));
      r.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function main() {
  const t0 = Date.now();
  const sched = loadSchedule();
  const jobs = [];
  // Coarse → fine so a time-capped bake still has complete low/mid zooms
  const zs = new Set();
  for (const k of Object.keys(sched.layers)) for (const z of Object.keys(sched.layers[k])) zs.add(+z);
  for (const z of [...zs].sort((a, b) => a - b)) {
    for (const kind of Object.keys(sched.layers)) {
      const r = sched.layers[kind][z];
      if (r == null) continue;
      for (const t of tilesInRadius(sched.center, z, r)) jobs.push([kind, ...t]);
    }
  }
  const stats = { total: jobs.length, ok: 0, skipped: 0, failed: 0, bytes: 0, perKind: {}, perZoom: {} };
  let i = 0, lastLog = 0;
  async function worker(w) {
    while (i < jobs.length) {
      if ((Date.now() - t0) / 60000 > MAX_MIN) return;
      const [kind, z, y, x] = jobs[i++];
      const f = path.join(OUT, kind, String(z), String(y), x + '.jpg');
      const pk = stats.perKind[kind] || (stats.perKind[kind] = { n: 0, bytes: 0 });
      const pz = stats.perZoom[kind + 'z' + z] || (stats.perZoom[kind + 'z' + z] = { n: 0, bytes: 0 });
      try {
        const st = fs.statSync(f);
        stats.skipped++; stats.bytes += st.size; pk.n++; pk.bytes += st.size; pz.n++; pz.bytes += st.size;
        continue;
      } catch (_) {}
      let buf = null;
      for (let a = 0; a < 4 && !buf; a++) {
        try {
          const b = await get(HOSTS[(a + w) % HOSTS.length], `/ArcGIS/rest/services/${SVC[kind]}/MapServer/tile/${z}/${y}/${x}`);
          if (b.length >= 64) buf = b;
          else break;
        } catch (e) {
          if (/HTTP 404/.test(e.message)) break;
          await new Promise((r) => setTimeout(r, 250 * (a + 1)));
        }
      }
      if (!buf) { stats.failed++; continue; }
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, buf);
      stats.ok++; stats.bytes += buf.length; pk.n++; pk.bytes += buf.length; pz.n++; pz.bytes += buf.length;
      if (Date.now() - lastLog > 10000) {
        lastLog = Date.now();
        console.log(`[bake] ${i}/${jobs.length} ok=${stats.ok} skip=${stats.skipped} fail=${stats.failed} ${(stats.bytes / 1048576).toFixed(1)}MB ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONC }, (_, w) => worker(w)));
  stats.seconds = Math.round((Date.now() - t0) / 1000);
  stats.mb = +(stats.bytes / 1048576).toFixed(1);
  stats.complete = (stats.ok + stats.skipped) >= stats.total * 0.98;
  stats.bakedAt = new Date().toISOString();
  stats.scheduleVersion = sched.version;
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'bake.json'), JSON.stringify(stats, null, 1));
  console.log(`[bake] done ${stats.ok + stats.skipped}/${stats.total} tiles, ${stats.mb} MB, ${stats.failed} failed, ${stats.seconds}s`);
  agent.destroy();
}
main().catch((e) => { console.error('[bake] fatal (ignored)', e); process.exit(0); });
