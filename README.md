# AirLoom SFO

Standalone browser 3D ADS-B view of **KSFO** airspace — **defaults to KSFO-associated private / GA** (inspired by [Air Loom](https://objectiveunclear.com/airloom)).

- Live positions via **adsb.lol** (OpenSky optional fallback)
- Vendored Three.js (works on Safari / iPhone without CDN)
- Routes: `/`, `/airloom`, `/adsb/states`, `/status`
- Live: [sfo3d.onrender.com](https://sfo3d.onrender.com/) (`BUILD_MARK` airloom-v9)

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

- **Follow** (default when ≤1 on final): elevated chase on the best KSFO inbound /
  final private/GA. Wheel/pinch zoom + drag orbit around the target.
  Basemap is **USGS ImageryOnly** ultra-HD (keyless, CORS-ok NAIP-class; ESRI World
  Imagery fallback). Static stack **z8 / z10–z16** (wider spans) around KSFO plus a
  denser **z13–z16 chase inset** with **look-ahead prefetch** (~3.5 nm along track)
  so far-field terrain/cities stay sharp under Follow (USGS max useful zoom ≈
  **z16** over CONUS). Template:
  `https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}`
- **Air Loom** (Orbit): dark high-contrast **ESRI World Dark Gray Base** basemap
  (keyless / CORS-*; z8 / z10 / z12 / z14). Carto `dark_all` was dropped in
  airloom-v8 after it started serving "API KEY REQUIRED" watermark tiles.
  Template:
  `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`
  Translucent Class B / Bay airspace shells, altitude-colored glow dots + thin
  trails with **altitude/speed tick labels**, vertical drop-lines, and large
  floating city labels — modeled after the original Air Loom look.
  (Orbit is stylized dark, not satellite.)
- **Dual-final Orbit** (auto): when **2+** aircraft are on a KSFO final, camera
  switches to a **wide Orbit** framing both (airport kept in view). Drops back to
  Follow when fewer than two remain on final. Manual Follow/Orbit clicks lock out
  auto-switch for ~90s.
- **Landing target** (airloom-v6): clear KSFO beacon + approach funnels + runway
  threshold markers; Follow shows **distance-to-landing** on a tiny bottom chip
  (nm + ETA; “ON FINAL / AT THRESHOLD” under 0.2 nm — no 0.0 mi spam).
- **Orbit keyless dark basemap** (airloom-v8): Carto dark_all → ESRI World
  Dark Gray Base (no API key). Follow USGS ImageryOnly unchanged.
- **Stable exclusive basemaps** (airloom-v9): only one stack visible per mode
  (no Orbit dark + Follow sat fighting); depth-stable LOD overlays; chase inset
  double-buffered with 2-cell hysteresis so sharpness stays consistent.
- **Follow FOV declutter** (airloom-v7): top-right info panel removed in Follow;
  single plane tag (callsign/alt/gs) + bottom chip only. World-space trail
  altitude/speed billboards hidden in Follow chase; in Orbit they stay sparse
  and **screen-constant** (never giant blurry walls when the camera is close).

Coverage fetch ≈ 250 mi around KSFO; default display filter is KSFO-associated only.
