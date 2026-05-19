---
title: SwarmControl PyroMechanics
emoji: 🔥
colorFrom: red
colorTo: orange
sdk: docker
app_port: 7860
pinned: false
---

# SwarmControl: PyroMechanics

Offline, deterministic wildfire-suppression RTS simulation. Python backend (FastAPI + NumPy)
runs a 50x50 fire-propagation grid and a 10-drone fleet at 30 Hz; vanilla-JS HTML5 Canvas
frontend renders the field and routes StarCraft II-style hotkey commands over a local
WebSocket.

## Quickstart

```
pip install -r requirements.txt
python run.py
```

Open <http://127.0.0.1:8000>.

Hard-refresh the page (Ctrl+F5) after edits to `frontend/app.js` to bypass browser cache.

## Controls

| Input | Action |
| --- | --- |
| Left-click drone (within 10 px) | Select that single drone |
| Left-click empty space | Clear selection |
| Right-click cell | Order selected drones to that cell (MANUAL_WAYPOINT) |
| `F2` | Add all 10 drones to selection |
| `Ctrl` + `1`-`5` | Bind current selection to group N |
| `1`-`5` | Recall bound group N as current selection |
| `A` | Release selection back to AUTONOMOUS_SWARM |
| `R` | Force selection into EMERGENCY_RETREAT to base (0,0) |

No drag-box selection by design.

## Architecture

```
config.json            # World, wind, ignition, drone init
run.py                 # uvicorn launcher
backend/
  enums.py             # FuelType, CellState, DroneState
  world.py             # 50x50 NumPy fire model, Moore-neighborhood propagation
  agent_logic.py       # Drone fleet, state machine, swarm allocator, safety override
  simulation.py        # 30 Hz tick loop, command queue, binary frame serializer
  server.py            # FastAPI app, /ws/simulation WebSocket, static mount
frontend/
  index.html           # Canvas, HUD sidebar, selection card
  styles.css           # Dark RTS theme
  app.js               # WS client, rAF render loop, input
```

### Determinism

A single seeded `numpy.random.Generator` (seeded from `config.json:world.seed`) drives every
stochastic decision in the simulation. No bare `random` calls anywhere in `backend/`.
Replays from the same config + same command sequence produce identical state.

### Fire propagation

For each Moore-neighborhood direction `(dx,dy)`, the per-tick ignition probability of an
unburned neighbor cell is:

```
prob = base_ignition_rate * wind_multiplier[dir] * fuel_density * (1 - moisture) * dt
```

Wind multiplier is `clip(1 + dot(dir_unit, wind_unit), 0.3, 2.2)`, applied to *outgoing*
ignition from active-fire sources. NE wind (config default `dx=1, dy=-1` with y-down screen
coords) doubles spread toward NE neighbors and dampens spread to SW.

### Swarm allocator

Greedy + sticky: each autonomous drone keeps its assigned fire cell until the cell is no
longer burning. Unassigned drones pick the nearest unclaimed `ACTIVE_FIRE` cell on the next
tick. This prevents the target-thrash failure mode where two equidistant drones swap
targets every frame.

### Safety override

```
battery_needed_to_return = (distance_to_base / speed) * battery_drain_per_sec * safety_factor
```

If a drone's `battery <= battery_needed_to_return` OR `water <= 0`, it forcibly transitions
to `EMERGENCY_RETREAT` regardless of MANUAL_WAYPOINT orders. On reaching the base refill
radius it instantly refuels/refills and rejoins the autonomous swarm.

### Wire protocol

Binary frame, little-endian:

```
offset  bytes  field
0       4      tick (uint32)
4       2      grid_size (uint16, always 50)
6       2      meta_json_length (uint16)
8       2500   cell state (uint8 per cell, row-major y-major)
2508    2500   intensity (uint8, temperature/4 clipped to 0..255)
5008    N      meta JSON: {wind, drones[], active_fires, ignited, ash, base}
```

Outgoing client commands are JSON text:

```json
{"cmd": "target",     "drone_ids": [3,7], "x": 12.5, "y": 33.0}
{"cmd": "autonomous", "drone_ids": [3,7]}
{"cmd": "recall",     "drone_ids": [3,7]}
```
