# AirLoom SFO

Standalone browser 3D ADS-B view of **KSFO** airspace — **defaults to KSFO-associated private / GA** (inspired by [Air Loom](https://objectiveunclear.com/airloom)).

- Live positions via **adsb.lol** (OpenSky optional fallback)
- Vendored Three.js (works on Safari / iPhone without CDN)
- Routes: `/`, `/airloom`, `/adsb/states`, `/arrivals/schedule`, `/status`
- Live: [sfo3d.onrender.com](https://sfo3d.onrender.com/) (`BUILD_MARK` airloom-v28.2)

## airloom-v28.2 — zoomed-out context view (how far is it from SFO?)

- **Default Follow view is now a context view**: the camera sits beyond the tracked/closest inbound, pitched ~36°, looking plane → KSFO, and solves its distance so the plane *and* the KSFO bullseye (plus labels and a ≥3.5 nm margin) fit inside the free band between the HUD and the soon bar/mode pills (measured live, re-centred vertically). Planes > 70 nm out frame the plane + 40 nm toward SFO. Pinch/wheel in tightens onto the plane (classic chase); out widens; drag yaw/pitch still works.
- **Range rings** at 10 / 20 / 40 nm around KSFO with labels (kept on the screen-right side).
- **Plane → KSFO line** with a "NN nm to KSFO · ETA h:mm PM PT" label (ETA from the arrival scorer, else distance/groundspeed). Follow: tracked plane; Orbit: focused plane.
- Plane icons scale with camera distance in Follow (≈ constant on-screen size, ×1–34) so they stay readable; KSFO label stays a constant pixel size; the tracked/selected plane's label is no longer hidden by distance.
- Tiles: unchanged engine — the quadtree LOD + leaf/texture caps pick coarser tiles automatically for the wider view (WebKit 390×844: 60 s soak + 4 view switches, no crash, max gpuTex 253 / iOS cap 320).
- Server: the Skyway clean endpoint `/api/swim/arrivals?airport=KSFO` is now tried even when Skyway `/status` fails (health comes from its `feed.swim`), so a `/status` blip no longer blocks the SWIM merge.
- Test hook: `window.__AIRLOOM_CTX()` (camera distance, insets, plane/KSFO screen positions).

## airloom-v28.1 — tighter ADS-B-only arrival filter (lists + soon bar only)

- **Other-field veto** for targets without a filed KSFO destination: on a KNUQ / KSJC / KPAO / KSQL / KHAF / KOAK final corridor (≤15 nm, ≤20° track-to-threshold, ~3° profile to that field) and pointing at it better than at SFO — or on the same line as SFO but far below any SFO profile — or closer to, pointing at and still able to land at that field. Tight SFO finals (≤0.35 nm, ≤7 nm) always win. Jets are never assigned to PAO/SQL/HAF.
- **Small aircraft** (light pistons / wake-L piston types, ADS-B emitter A1 non-jets) are listed only when Skyway FAA SWIM (or another filed source) confirms KSFO; single-engine turboprops (C208, PC12, TBM, P46T, Kodiak…) need SWIM or a tight SFO short final. Light jets (C510/C525/CJ/E50P/SF50/HDJT) are not "small".
- Destination-confirmed (SWIM) targets always win. The 3D map keeps the v28 decision (`legacy`), so BLOCKED/PIA/other traffic stays visible as before.
- Soon-bar "On base" times are explicitly Pacific (`America/Los_Angeles`), header "On base PT".
- Test hook: `window.__AIRLOOM_DECIDE({type, lat, lon, altFt, track, vrFpm, gsKt, adsbCat, dest}, {allowAirline})` → strict vs legacy.

## airloom-v28 — FAA SWIM filed flight plans (via Skyway public GETs)

- Server polls Skyway (`SKYWAY_BASE`, default `https://skyway-sfo.onrender.com`; `SKYWAY_SWIM_ENABLED`, default 1) every 60 s with a 10 s timeout, **only while AirLoom has a viewer** (15-min idle stop). `GET /status` first (swim.connected), then `GET /api/swim/arrivals?airport=KSFO` (clean SWIM-only endpoint, used when it returns rows) else `GET /api/arrivals` filtered to SWIM rows (`source` starts `swim` or `timeSource==='swim'`, to KSFO or divertTo set; adsb-inbound guesses dropped). Ramp fields (spot, pax, flags, towNotes) are never copied. Last good result kept 5 min.
- Rows map into the v26 `/arrivals/schedule` shape (`source: 'skyway-swim'`), priority over AeroAPI (still optional/off). ADS-B merge: reg → callsign (EJA### ↔ N###QS, LXJ### ↔ N###FX) → sticky hex / N-number-derived hex. PIA/LADD/BLOCKED targets never receive a SWIM ident. SWIM confirms destinations but is not used as negative evidence (v26 behaviour kept).
- LADD: `LADD_FILE` / `LADD_URL` (tails + callsigns). **TODO: FAA Industry LADD list not supplied yet** → `/status` shows `ladd: "not loaded"`. Matching rows show as BLOCKED (time/type/origin kept).
- `/status.skywaySwim {ok, connected, msgs, fetchedAgoSec, n, state, endpoint, …}`; UI "FAA feed down" badge when stale/down; "Filed · FAA flight plan" rail section (tail · ICAO · origin · ETA PT); ≤30 min filings enter the soon bar; "Not for safety-critical use" in About.
- Mobile: bottom stack now sits just above the browser bar (visualViewport `--chrome-bottom` + safe-area + 8px gap, 10px iOS Safari tab) instead of the 64/78px floors.

## airloom-v26

- **Destination-first KSFO arrivals**: an aircraft is listed as a KSFO arrival only if (a) a schedule source confirms destination KSFO (AeroAPI, optional), or (b) its geometry is strong: on/joining a KSFO final for the active flow (28L/R, 19L/R, 10L/R, 01L/R, using **true** runway headings — v25 used magnetic headings as true, ~14° off), or converging and descending toward SFO with SFO clearly the best-fitting field.
- **Satellite-field rejection**: OAK, HWD, SJC, NUQ, PAO, SQL, HAF, CCR, LVK (incl. OAK/SJC/HWD/NUQ final corridors) — if another field fits the track/profile better, it is not an SFO arrival. Jets are never assigned to short-runway fields (PAO/SQL/HAF).
- **Light pistons / trainers** (C150–C210, PA-28, SR20/22, DA40, etc.) only count when on a tight SFO short final (≤6 nm, ≤0.45 nm off centerline, ≤2300 ft).
- **Airliners off the GA/FBO list** (rail, soon bar, drawer in GA mode). Airliners still appear in Arrivals / All modes. BLOCKED / PIA ADS-B targets keep their labels.
- **Scheduled inbounds beyond ADS-B range** (when `AEROAPI_KEY` is set): FlightAware AeroAPI `/airports/KSFO/flights/scheduled_arrivals?type=General_Aviation` (filed + en route, next 12 h) is merged with ADS-B by tail → callsign → sticky hex. Unmatched filings appear under "Filed · beyond ADS-B (FlightAware)" in the rail, and in the soon bar when ≤30 min. Blocked filings are folded into an ADS-B BLOCKED target of the same type/ETA.
- **No flightaware.com scraping**: FA's Terms of Use forbid automated retrieval of site pages; the enroute/arrivals pages also require login. Use AeroAPI (or a SWIM feed) instead.
- UI from v24/v25 unchanged (30-min soon bar, green progress, mobile/CT47 layout).

### AeroAPI (optional, OFF by default, hard-capped)

Set only in the Render dashboard (never commit a key). Without `AEROAPI_KEY` no FlightAware call is ever made.

| Env | Default | Meaning |
| --- | --- | --- |
| `AEROAPI_KEY` | *(unset → off)* | AeroAPI v4 key (`x-apikey`) |
| `AEROAPI_AIRPORT` | `KSFO` | Airport for `scheduled_arrivals` |
| `AEROAPI_POLL_SEC` | `600` (min 120) | Poll interval, only while someone is viewing (stops after 15 min idle) |
| `AEROAPI_MAX_PAGES` | `3` (1–10) | Max 15-record pages per call |
| `AEROAPI_WINDOW_H` | `12` | Look-ahead window (hours) |
| `AEROAPI_DAILY_MAX_CALLS` | `48` | Hard cap on billable calls per UTC day |
| `AEROAPI_DAILY_MAX_USD` | `0.50` | Hard cap on spend per UTC day |
| `AEROAPI_MONTHLY_MAX_USD` | `5` | Hard cap on spend per UTC month |
| `AEROAPI_COST_PER_PAGE` | `0.005` | Used for the pessimistic local ledger |
| `AEROAPI_REQUIRE_USAGE_CHECK` | `1` | Fail closed unless FA `/account/usage` (free, `all_keys=true`) succeeded within 60 min |

Spend is reconciled against FlightAware's own account usage for **all keys** on the account (survives restarts / free-tier sleeps), and every call is charged pessimistically (max pages) before it is made. Caps and live spend are shown in `/status` → `aeroapi`.

## airloom-v25

- **iOS Safari / Chrome / CT47 chrome lift**: `#camStack` (soon bar + mode pills) sits above browser bottom chrome via `env(safe-area-inset-bottom)` + `visualViewport` `--chrome-bottom` + generous `--mobile-chrome-floor` (56px) so collapsed↔expanded Safari bars never bury the soon bar.
- **Soon bar primary on mobile**: ≤800px / CT47 — Tail·ICAO·ETA·On base + thick green progress + large `~N min` remain; left **FBO · NEXT ~60 MIN** rail closed by default (Arrivals chip to open; much smaller when open).
- **Plane detail card**: on narrow screens tucked top-right under HUD (compact type, secondary fields hidden) — no longer blocks map center or sits under browser chrome.
- **Touch / layout**: ≥44px taps, no horizontal scroll, `100dvh` + overflow-x clip, portrait 480–800px friendly.

## airloom-v24

- **Soon bar (≤30 min)**: Compact bottom strip above Air Loom / Follow pills. Rows: **Tail · ICAO type · ETA · time on base** only. Reuses KSFO inbound scoring; window ≤30 min (not 60). Soonest first; BLOCKED/PIA ok as tail.
- **Time on base**: approach / along-final ETA clock; on final near threshold → `on base` / `now`.
- **Visual ETA (mobile)**: large `~N min` countdown + **thick green progress bar** per row (fuller = sooner); Follow landing chip bar fattened too.
- **CT47 / iOS Safari / Android Chrome**: monospace-ish rows, ≥44px tap targets, `viewport-fit=cover` + safe-area (`constant()`/`env()`), no h-scroll, portrait ~480–800px.

## airloom-v23

- **Type truth**: Prefer ADS-B/FAA ICAO `t` over guessed labels. EJA930 / N930QS = **C68A Citation Latitude** (not CJ3). C25B→CJ3, C25C→CJ4, C68A→Latitude, C700→Longitude.
- **Safari Follow UHD**: same-origin `/tiles/sat` via `fetch`+ImageBitmap (not mass `Image`+CORS); iOS skips high-z relief doubling; hide muted earth disc once sat paints — fixes solid green ground.
- **Bizjet silhouettes**: Latitude/Longitude use TYPE_DIMS procedural (shared citation.glb looked like CJ3); Challengers→CRJ GLB; Phenoms→E-Jet GLB; span stretch.

## Local

```bash
cp .env.example .env   # optional OSKY_* for OpenSky fallback
npm start
# open http://127.0.0.1:8767/?airport=SFO
```

## Render

Push to GitHub; Blueprint `render.yaml` or create a Docker web service pointed at this repo.
Set `OSKY_ID` / `OSKY_SECRET` in the dashboard if you want OpenSky fallback.
Optionally set `AEROAPI_KEY` (+ caps above) for confirmed destinations and filed inbounds beyond ADS-B range.

## Aircraft models

Detailed GLB airframes live in `public/models/` (see `ATTRIBUTION.md` + `icao-map.json`).
ICAO type codes map to family models (e.g. B752 → 757 family, B738 → 737, E75L → E-Jet).
Licenses: amvlab CC BY 4.0 + Flightradar24/FlightGear GPLv2. No payware.

## Traffic modes

Default **Private / GA** shows only aircraft **clearly associated with KSFO**:
inbound to KSFO, on approach/final (runway extended centerline + descending + toward field),
or inside the SFO Class B pattern. SQL / HAF / PAO / SJC-primary Bay GA is hidden.

Switch to **Arrivals** (KSFO arrivals) or **All traffic** in the drawer.

## Camera & visual modes

- **Follow** (default when ≤1 on final in the dual band): rear 3rd-person chase
  (lower elevation, more behind — not cockpit / not overhead) on the **soonest
  arriving** clear KSFO inbound / final private/GA. Wheel/pinch zoom + drag orbit
  around the target.
  Basemap is **ESRI World Imagery** via same-origin `/tiles/sat` (Safari-safe,
  keyless, z19) with stronger **World_Hillshade** topo composite. Always-resident
  **~100 mi / 87 nm** stack **z8 / z10–z19** (Safari-safe spans + dense Bay patches:
  z17≈62 nm, z18≈48 nm, z19≈28 nm) plus chase inset **z15–z19** look-ahead.
  Soft mips disabled from z10+ to cut LOD seams. USGS ImageryOnly remains fallback.
- **Air Loom** (Orbit): dark high-contrast **ESRI World Dark Gray Base** +
  **World_Hillshade_Dark** topography (keyless; z8 / z10–z15, ~100 mi resident)
  via same-origin `/tiles/orbit` + `/tiles/relief` proxies.
  Framed on the **cluster of KSFO arrivals in the next ~60–90 minutes** (soonest +
  pack), not a max-wide empty Class B scenic shot. Compact **arrivals sidebar**
  (closed by default; **Arrivals** chip / ✕ / Escape; persists via localStorage)
  lists callsign/type, mi, ETA — GA-first. **Hover a row** for a temporary
  top-down map peek (plane↔KSFO distance); mouse leave restores prior framing.
  Clear airline inbounds/finals + ADS-B enroute still shown. Translucent Class B /
  Bay shells, altitude-colored glow dots + thin trails with tick labels,
  drop-lines, city labels — stylized dark (not satellite). Controls drawer also
  starts **closed** (☰ to open; localStorage).
- **Dual-final Orbit** (auto): when **≥2** aircraft are on a KSFO final **~5–7 mi
  out** (along-final band ≤ ~6.5 nm), camera switches to a **wide Orbit** framing
  both (airport kept in view). Drops back to Follow when fewer than two remain in
  that band. Manual Follow/Orbit clicks lock out auto-switch for ~90s.
- **Landing target** (airloom-v6): clear KSFO beacon + approach funnels + runway
  threshold markers; Follow shows **distance-to-landing** on a tiny bottom chip
  (nm + ETA; “ON FINAL / AT THRESHOLD” under 0.2 nm — no 0.0 mi spam).
- **Orbit keyless dark basemap** (airloom-v8): Carto dark_all → ESRI World
  Dark Gray Base (no API key). Follow USGS ImageryOnly unchanged.
- **Stable exclusive basemaps** (airloom-v9): only one stack visible per mode
  (no Orbit dark + Follow sat fighting); depth-stable LOD overlays; chase inset
  double-buffered with 2-cell hysteresis so sharpness stays consistent.
- **Strict KSFO final + active flow** (airloom-v10): Follow chase and landing
  chip only for genuine KSFO inbound/approach/final (centerline + track-to-field
  + descent/closing gates). Runway label prefers inferred active flow (default
  28s west ops); opposite/closed runways (e.g. 10R) are not invented. “AT
  THRESHOLD” requires real final proximity — past-threshold geometry no longer
  collapses remaining distance to 0.
- **Orbit map + primary label** (airloom-v12): Air Loom / Orbit dark basemap
  loads via same-origin `/tiles/orbit/{z}/{y}/{x}` proxy (ESRI World Dark Gray
  Base upstream) so Safari iOS no longer ends up with a black/empty ground when
  mass cross-origin tile Images fail. Concurrent tile pool + midtone lift keep
  coastline/roads discernible; direct ESRI + stylized imagery remain fallbacks.
  Follow/selected `.ac-label` soft-clamps into the HUD/chip safe area and flips
  below the plane under overhead tilt instead of clipping out of frame.
- **Closed arrivals sidebar + hover top-down** (airloom-v17): App no longer
  forces an undismissable sidebar open. Controls drawer and Orbit ~60 min
  arrivals list start **closed** (toggle / ✕ / Escape); open state persists in
  localStorage. Arrivals rows show ident / type / mi / ETA (existing Orbit
  scoring). Hovering a row temporarily frames a **top-down** view of that plane
  vs KSFO; leave restores prior Orbit/Follow framing unless the row was clicked
  to select. Follow chase, dual-final, strict final, tiles, Safari Orbit proxy
  unchanged.
- **Orbit FA-match enroute + Follow ETA label** (airloom-v16): Orbit arrivals
  board includes ADS-B GA/bizjet (and near airline) inbounds out to ~360 nm /
  ~60–110 min ETA when track is clearly toward KSFO — better overlap with
  FlightAware “en route to SFO” when positions exist. No invented scheduled
  flights (ADS-B only). GA/private ranked above airline cruise; strict final /
  dual-final / Follow false-final rules unchanged. Follow primary plane tag shows
  compact `tail · type · mi · ~min` (v11 in-frame clamp kept).
- **Orbit arrivals HUD + cluster frame** (airloom-v15): Air Loom frames the
  ~60 min KSFO arrivals pack (or soonest + neighbors) with a compact soonest-first
  list (callsign/type, nm/mi, ETA, runway). Empty Class-B scenic overview retired.
  Follow behind-chase, soonest focus, dual-final 5–7 mi, Orbit tile proxy, strict
  KSFO, and declutter kept from v10–v14.
- **Behind chase + trail ETA + soonest focus** (airloom-v14): Follow chase sits
  farther behind / lower (rear 3rd-person). Flight-path trail ticks and remaining-
  path markers show distance-to-landing (nm/mi) + ETA minutes from speed. Focus
  always picks the soonest ETA / nearest-to-landing clear KSFO inbound. Dual-final
  Orbit triggers when ≥2 are on final in the ~5–7 mi band.
- **Stable landing ETA chip** (airloom-v13): Follow bottom chip shows distance +
  ETA only for clear KSFO approach/final (hides low-confidence “To KSFO” spam).
  ETA is groundspeed-based with GS/nm smoothing and minute hysteresis (no jump
  on ADS-B noise); hidden when GS unknown. AT THRESHOLD / ON FINAL latched.
  Active-flow runway labeling kept. Compact single-row chip + thin approach
  progress fill — readable on iPhone without restoring big panels.
- **Follow FOV declutter** (airloom-v7 / v14): top-right info panel removed in
  Follow; single plane tag (callsign/alt/gs) + bottom chip only. Sparse trail /
  remaining-path **ETA ticks** (mi + minutes) allowed in Follow for the primary;
  Orbit keeps screen-constant ticks on finals (never giant blurry walls).

Coverage fetch ≈ 250 mi around KSFO; default display filter is KSFO-associated only.

### airloom-v18
- Chrome no-overlap (HUD / camBar / ☰)
- Slim left ~60m FBO arrivals rail (default open on Orbit; NEXT + ETA to SFO)
- Bigger planes (SIZE_MULT 4.5)
- KSFO bullseye destination marker
- Rainbow altitude trails thick at nose / thin wake
- Clearer ETA chip (“~12 min to SFO”)
- Always focus closest KSFO inbound (Orbit); restore after hover
- Darker richer Orbit/Follow basemap (less whitewash)

### airloom-v19
- Always-resident ultra-HD tiles within ~100 mi (≈87 nm) of KSFO (Orbit + Follow)
- Higher zoom/LOD/sampling in that ring; sharper overlays (no soft far mips)
- Stronger local contrast/saturation after v18 darkening (detail without pale wash)
- Prominent topography: World_Hillshade_Dark (Orbit, `/tiles/relief`) + World_Hillshade (Follow)
- Safari Orbit proxy kept; exclusive basemap / arrivals rail / bullseye / trails unchanged

### airloom-v22
- **Privacy / BLOCKED / PIA visible**: ADS-B track, position, type kept for LADD
  (`dbFlags & 8`), PIA (`dbFlags & 4`), `ownOp` privacy hints, and FA-style
  no-reg inbound jets. Ident shows **BLOCKED** or **PIA** — never invent a
  civil N-number. Hex stays internal for tracking only.
- Registry redacted server-side in `/adsb/states` meta when privacy-flagged.
- Orbit ~60 min board + Follow still include clear KSFO-inbound privacy traffic.
- Fractional CS (EJA/LXJ/TWY/…) preferred for FA Ident overlap when public.
- `PRIVACY_OVERRIDES` hex→mode table hook for tomorrow’s explicit list
  (`PIA` | `BLOCKED` | `public`).
- Caveat: schedule-only FA rows (no ADS-B position yet) still need a schedule
  source for 95%+ list parity; ADS-B completeness covers airborne matches.


## airloom-v27 — basemap engine
- **AirTiles** quadtree LOD: per-tile 256px textures (mipmapped, max anisotropy, sRGB, `toneMapped:false`), frustum-culled, nearest-first priority queue, parent/child fallback while the exact tile streams. Only the active mode's basemap holds textures; the other is released on switch. GPU texture LRU cap (iOS 320 ≈ 112 MB, Android/CT47 420, desktop 1000). Pixel ratio capped at 2 on phones.
- **Baked Bay tile cache**: `tools/bake-tiles.js` downloads `tiles-schedule.json` (~40k ESRI tiles, ~350 MB, sat z8–19 / hill / orbit / relief within ≤160 nm of KSFO) into the Docker image at build time. Server tiers: RAM LRU → baked image → `/tmp` → upstream (keep-alive, single-flight). Tiles served `public, max-age=31536000, immutable` + ETag/304. `/tiles/manifest` shows bake/warm stats.
- Loading gate until the visible set is sharp (≤12 s); service worker (`/sw.js`) persists tiles across visits; idle fetch-only prefetch (never decoded).
- Gesture-aware throttling (≤2 GPU uploads/frame while dragging, no prefetch), WebGL context lost/restored handling, auto-follow target held while the user interacts.
