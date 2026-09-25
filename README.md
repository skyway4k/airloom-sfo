# AirLoom SFO

Standalone browser 3D ADS-B view of KSFO airspace — **defaults to private / GA traffic** (inspired by [Air Loom](https://objectiveunclear.com/airloom)).

- Live positions via **adsb.lol** (OpenSky optional fallback)
- Vendored Three.js (works on Safari / iPhone without CDN)
- Routes: `/`, `/airloom`, `/adsb/states`, `/status`

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

Default **Private / GA** filters to light aircraft, turboprops, bizjets, and helicopters
(airliners hidden). Switch to **Arrivals** or **All traffic** in the drawer.

## Camera

Default **Cockpit** follows the nearest inbound private/GA toward KSFO / SQL / HAF / PAO / SJC.
If two inbound GA share an ETA within ~5 minutes, dual cockpit (split desktop / PiP mobile)
shows both. Switch to **Orbit** anytime from the top control bar.
