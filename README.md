# AirLoom SFO

Standalone browser 3D ADS-B view of **KSFO** airspace — **defaults to KSFO-associated private / GA** (inspired by [Air Loom](https://objectiveunclear.com/airloom)).

- Live positions via **adsb.lol** (OpenSky optional fallback)
- Vendored Three.js (works on Safari / iPhone without CDN)
- Routes: `/`, `/airloom`, `/adsb/states`, `/status`
- Live: [sfo3d.onrender.com](https://sfo3d.onrender.com/) (`BUILD_MARK` airloom-v19)

## Local

```bash
cp .env.example .env   # optional OSKY_* for OpenSky fallback
npm start
# open http://127.0.0.1:8767/?airport=SFO
```

## Render

Push to GitHub; Blueprint `render.yaml` or create a Docker web service pointed at this repo.
Set `OSKY_ID` / `OSKY_SECRET` in the dashboard if you want OpenSky fallback.

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
  Basemap is **USGS ImageryOnly** ultra-HD (keyless, CORS-ok NAIP-class; ESRI World
  Imagery fallback) with **World_Hillshade** relief composite. Always-resident
  **~100 mi / 87 nm** stack **z8 / z10–z16** (Safari-safe spans + z12 patch ring)
  around KSFO plus denser **z13–z16 chase inset** with look-ahead prefetch.
  Template:
  `https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}`
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
