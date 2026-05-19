import asyncio
import json
import struct
import time

import numpy as np

from .agent_logic import Fleet
from .enums import CellState
from .world import World

BUY_DRONE_COST = 10
CREDITS_PER_EXTINGUISH = 5

LEVELS = [
    {
        "label": "Smoldering",
        "ignitions": [{"x": 8, "y": 8}],
        "world_overrides": {"wind": {"dx": 0.5, "dy": -0.3}, "base_ignition_rate": 0.25},
        "fuel_overrides": {"moisture": 0.15},
        "drone_count": 10,
        "lose_ash_threshold": 800,
    },
    {
        "label": "Rising Heat",
        "ignitions": [{"x": 25, "y": 25}, {"x": 15, "y": 15}],
        "world_overrides": {"wind": {"dx": 1.2, "dy": -0.8}, "base_ignition_rate": 0.40},
        "fuel_overrides": {"moisture": 0.08},
        "drone_count": 10,
        "lose_ash_threshold": 600,
    },
    {
        "label": "Inferno",
        "ignitions": [{"x": 25, "y": 25}, {"x": 15, "y": 15}, {"x": 35, "y": 35}],
        "world_overrides": {"wind": {"dx": 2.0, "dy": -1.5}, "base_ignition_rate": 0.75},
        "fuel_overrides": {"moisture": 0.04},
        "drone_count": 12,
        "lose_ash_threshold": 450,
    },
    {
        "label": "Wildfire",
        "ignitions": [
            {"x": 25, "y": 25}, {"x": 10, "y": 10},
            {"x": 40, "y": 40}, {"x": 15, "y": 40},
        ],
        "world_overrides": {"wind": {"dx": 2.5, "dy": -2.0}, "base_ignition_rate": 1.1},
        "fuel_overrides": {"moisture": 0.02},
        "drone_count": 14,
        "lose_ash_threshold": 350,
    },
]


class Simulation:
    """Owns the world, fleet, command queue and broadcast fan-out."""

    def __init__(self, config_path):
        with open(config_path, "r", encoding="utf-8") as f:
            self.cfg = json.load(f)
        self.level_idx = 0
        self.game_status = "playing"
        self.lose_ash_threshold = LEVELS[0]["lose_ash_threshold"]
        level_cfg = self._build_level_cfg(0)
        self.rng = np.random.default_rng(int(level_cfg["world"]["seed"]))
        self.world = World(level_cfg, self.rng)
        self.fleet = Fleet(level_cfg, self.world)
        self.tick = 0
        self.credits = 0
        self.paused = False
        self.command_queue: asyncio.Queue = asyncio.Queue()
        self.subscribers: set = set()
        self._stopped = False

    def _build_level_cfg(self, level_idx: int) -> dict:
        level = LEVELS[level_idx]
        cfg = json.loads(json.dumps(self.cfg))
        for k, v in level["world_overrides"].items():
            if k == "wind" and isinstance(v, dict):
                cfg["world"]["wind"].update(v)
            else:
                cfg["world"][k] = v
        for k, v in level["fuel_overrides"].items():
            cfg["fuel"][k] = v
        cfg["ignitions"] = list(level["ignitions"])
        cfg["drones"]["count"] = level["drone_count"]
        return cfg

    def _reset(self, level_idx=None):
        if level_idx is not None:
            self.level_idx = level_idx
        self.game_status = "playing"
        self.lose_ash_threshold = LEVELS[self.level_idx]["lose_ash_threshold"]
        level_cfg = self._build_level_cfg(self.level_idx)
        self.rng = np.random.default_rng(int(level_cfg["world"]["seed"]))
        self.world = World(level_cfg, self.rng)
        self.fleet = Fleet(level_cfg, self.world)
        self.tick = 0
        self.credits = 0
        self.paused = False
        while not self.command_queue.empty():
            try:
                self.command_queue.get_nowait()
            except asyncio.QueueEmpty:
                break

    async def submit_command(self, cmd):
        await self.command_queue.put(cmd)

    def add_subscriber(self, q):
        self.subscribers.add(q)

    def remove_subscriber(self, q):
        self.subscribers.discard(q)

    def stop(self):
        self._stopped = True

    def _apply_command(self, cmd):
        if not isinstance(cmd, dict):
            return
        kind = cmd.get("cmd")
        ids = cmd.get("drone_ids", [])
        if not isinstance(ids, list):
            return
        try:
            if kind == "target":
                self.fleet.cmd_target(ids, float(cmd.get("x", 0)), float(cmd.get("y", 0)))
            elif kind == "autonomous":
                self.fleet.cmd_autonomous(ids)
            elif kind == "recall":
                self.fleet.cmd_recall(ids)
            elif kind == "pause_toggle":
                if self.game_status == "playing":
                    self.paused = not self.paused
            elif kind == "restart":
                self._reset()
            elif kind == "next_level":
                next_idx = self.level_idx + 1
                if self.game_status == "won" and next_idx < len(LEVELS):
                    self._reset(next_idx)
            elif kind == "spawn_fire":
                self.world._ignite_cell(int(cmd.get("x", 0)), int(cmd.get("y", 0)))
            elif kind == "buy_drone":
                if self.credits >= BUY_DRONE_COST and self.fleet.buy_drone():
                    self.credits -= BUY_DRONE_COST
        except (KeyError, TypeError, ValueError):
            return

    async def run(self):
        period = self.world.dt
        next_tick = time.perf_counter()
        while not self._stopped:
            now = time.perf_counter()
            sleep_for = next_tick - now
            if sleep_for > 0:
                await asyncio.sleep(sleep_for)
            next_tick += period
            if next_tick < now - period * 5:
                next_tick = now + period

            while not self.command_queue.empty():
                try:
                    self._apply_command(self.command_queue.get_nowait())
                except asyncio.QueueEmpty:
                    break

            if not self.paused:
                self.world.step()
                extinguished = self.fleet.step(self.world.dt)
                self.credits += extinguished * CREDITS_PER_EXTINGUISH
                self.tick += 1

                if self.game_status == "playing":
                    active = int((self.world.state == CellState.ACTIVE_FIRE).sum())
                    ignited = int((self.world.state == CellState.IGNITED).sum())
                    ash = int((self.world.state == CellState.ASH).sum())

                    if active == 0 and ignited == 0:
                        self.game_status = "won"
                        self.paused = True
                    elif ash >= self.lose_ash_threshold:
                        self.game_status = "lost"
                        self.paused = True
                    else:
                        bx, by = int(self.fleet.base[0]), int(self.fleet.base[1])
                        N = self.world.size
                        for dy in range(-2, 3):
                            for dx in range(-2, 3):
                                nx, ny = bx + dx, by + dy
                                if 0 <= nx < N and 0 <= ny < N:
                                    if self.world.state[ny, nx] in (
                                        CellState.ACTIVE_FIRE, CellState.IGNITED
                                    ):
                                        self.game_status = "lost"
                                        self.paused = True
                                        break
                            if self.game_status == "lost":
                                break

            payload = self._build_payload()
            for q in list(self.subscribers):
                if q.full():
                    try:
                        q.get_nowait()
                    except asyncio.QueueEmpty:
                        pass
                try:
                    q.put_nowait(payload)
                except asyncio.QueueFull:
                    pass

    def _build_payload(self):
        state_bytes, intensity_bytes, fuel_bytes = self.world.serialize_grid()
        meta = {
            "wind": {
                "dx": float(self.world.wind[0]),
                "dy": float(self.world.wind[1]),
            },
            "drones": self.fleet.serialize(),
            "active_fires": int((self.world.state == CellState.ACTIVE_FIRE).sum()),
            "ignited": int((self.world.state == CellState.IGNITED).sum()),
            "ash": int((self.world.state == CellState.ASH).sum()),
            "base": {"x": self.fleet.base[0], "y": self.fleet.base[1]},
            "paused": self.paused,
            "credits": self.credits,
            "level": self.level_idx,
            "level_label": LEVELS[self.level_idx]["label"],
            "game_status": self.game_status,
            "lose_ash_threshold": self.lose_ash_threshold,
        }
        meta_bytes = json.dumps(meta, separators=(",", ":")).encode("utf-8")
        header = struct.pack("<IHH", self.tick, self.world.size, len(meta_bytes))
        return header + state_bytes + intensity_bytes + fuel_bytes + meta_bytes
