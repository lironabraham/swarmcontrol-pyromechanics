# SwarmControl: PyroMechanics — CLAUDE.md

Offline deterministic wildfire-suppression RTS. FastAPI + NumPy backend, vanilla JS Canvas
frontend, local WebSocket at 30 Hz. No build step, no external services.

**Run:** `py run.py` → http://127.0.0.1:8000  
**Windows note:** use `py` not `python`. Kill port with `netstat -ano | findstr :8000` + `taskkill /PID <n> /F`.

## Stack

```
config.json       seed, wind, fuel, ignitions, drone params
run.py            uvicorn entry point
backend/
  enums.py        FuelType, CellState, DroneState (all IntEnum)
  world.py        50x50 NumPy grid, fire propagation, douse()
  agent_logic.py  Fleet: sticky swarm allocator, safety override, state machine
  simulation.py   30 Hz asyncio loop, command queue, binary frame builder
  server.py       FastAPI, /ws/simulation, StaticFiles at / (route registered first)
frontend/
  index.html / styles.css / app.js   canvas render, rAF loop, SC2 hotkeys
```

## Wire Protocol

Binary frame (LE): `[tick u32][size u16][metaLen u16][2500B state][2500B intensity][2500B fuel][meta JSON]`  
Commands (JSON text): `{"cmd":"target"|"autonomous"|"recall"|"pause_toggle"|"restart"|"spawn_fire"|"buy_drone", ...}`

## Invariants — Never Break

- **RNG**: single `np.random.default_rng(seed)` in `Simulation.__init__`. No `import random`.
- **Route order**: `/ws/simulation` must be registered before `app.mount`.
- **Hit-test**: drone selection distance in `app.js` is in screen pixels, not grid coords.
- **Sticky allocator**: validate existing targets before reassigning. Never replace with pure per-tick greedy.
- **Frame layout**: `simulation.py:_build_payload` and `app.js:decodeFrame` are coupled. Change both together.

## Key Decisions Made (2026-05-19)

Previous implementation on another machine failed — rebuilt with these fixes:
binary frames over WS, rAF decoupled from onmessage, outgoing-direction fire propagation,
sticky swarm assignment, pixel-space hit-test, seeded RNG, pinned deps
(`websockets==12.0`, `uvicorn==0.30.6`, `starlette==0.38.6`), lifespan API over `@on_event`.

## Controls

`LMB` select / drag-box · `RMB` target cell · `Shift+RMB` spawn fire ·
`F2` select all · `Ctrl+1-5` bind group · `1-5` recall group ·
`A` autonomous · `R` retreat to base · `B` buy drone (10cr) ·
`Space` pause/resume · `Ctrl+R` restart

## Deployment (2026-05-19)

- **GitHub**: https://github.com/lironabraham/swarmcontrol-pyromechanics
- **Live URL**: https://lironabraham-swarmcontrol-pyromechanics.hf.space (Hugging Face Spaces, free, always-on)
- **CI**: GitHub Action (`.github/workflows/deploy.yml`) auto-pushes `master:main` to HF on every push to `master`
- **Port**: HF injects `PORT=7860`; `run.py` reads it from env. Local default is 8000.
- Push workflow: `git push origin master` → Action triggers → deploys to HF automatically

## Wire Protocol (updated 2026-05-19)

Binary frame (LE): `[tick u32][size u16][metaLen u16][2500B state][2500B intensity][2500B fuel][meta JSON]`

Meta JSON now includes: `paused: bool`, `credits: int` (in addition to existing fields).

## Economy

`CREDITS_PER_EXTINGUISH = 5` · `BUY_DRONE_COST = 10` · `max_drones = 20` (config override: `drones.max_drones`)

## Next Session — Features to Build

1. **Room system** — private rooms with 6-char codes + share links (foundation for multiplayer later)
