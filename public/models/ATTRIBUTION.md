# Aircraft 3D model attribution

AirLoom SFO vendors free/redistributable GLB models only. No commercial Flight Simulator
payware or pirated packs.

## amvlab / aircraft-models (CC BY 4.0)

- Source: https://github.com/amvlab/aircraft-models
- License: Creative Commons Attribution 4.0 International
- License text: `LICENSE-amvlab-CC-BY-4.0.txt`
- Files (logo-free variants, adapted filename only):
  - `a320.glb` ← A320_nologo.glb
  - `a350.glb` ← A350_nologo.glb
  - `a380.glb` ← A380_nologo.glb
  - `b737.glb` ← B737_nologo.glb
  - `b787.glb` ← B787_nologo.glb
- Changes: renamed for AirLoom family keys; no mesh edits.

## Flightradar24 / fr24-3d-models (GPLv2)

- Source: https://github.com/Flightradar24/fr24-3d-models
- Upstream credits: FlightGear / FGMEMBERS contributors (see upstream README)
- License: GNU General Public License v2.0
- License text: `LICENSE-fr24-GPLv2.txt`
- These model files remain GPLv2. Source blends are in the upstream repo.
- Files (converted glTF 1 → glTF 2 via Assimp for Three.js r160; filenames remapped to families):
  - `b757.glb` ← models/b752.glb
  - `b767.glb` ← models/b763.glb
  - `b777.glb` ← models/b772.glb
  - `b747.glb` ← models/b744.glb
  - `a330.glb` ← models/a332.glb
  - `a220.glb` ← models/cs100.glb
  - `ejet.glb` ← models/e170.glb
  - `crj.glb` ← models/crj700.glb
  - `q400.glb` ← models/q400.glb
  - `atr.glb` ← models/atr42.glb
  - `bae146.glb` ← models/bae146.glb
  - `heli.glb` ← models/heli.glb (Eurocopter EC135 family)
  - `ga.glb` ← models/pa28.glb (Piper PA-28 / light GA stand-in)
  - `bizjet.glb` ← models/citation.glb (Cessna Citation / bizjet stand-in)

  - `turboprop.glb` ← models/atr42.glb (ATR-42 mesh stand-in for PC-12 / TBM / King Air)
  - `lightjet.glb` ← models/citation.glb (light jets: CJ / Lear / Phenom)
  - `midjet.glb` ← models/citation.glb (super-mid: Challenger 300/350, Latitude, Falcon 2000)
  - `largecabin.glb` ← models/citation.glb (large cabin: Gulfstream / Global / Falcon 7X/8X)
- Changes: glTF 1.0 binary → glTF 2.0 GLB (Assimp); renamed to AirLoom family keys.

## Runtime fallback

If a GLB is missing or fails to load, the viewer keeps the richer procedural mesh
(per-ICAO dimensions from `TYPE_DIMS`) until / unless a GLB succeeds.

## GA / private scale notes (ga-focus-v1)

Family `refLen` values track real-world length so a C172 (~8.3 m) stays clearly
smaller than a G650 / Global (~30 m) even when they share a Citation-derived mesh
for mid/large cabin stand-ins. Prefer unique redistributable GA meshes when available;
ATR-42 is the turboprop stand-in until a dedicated PC-12/King Air GLB is vendored.
