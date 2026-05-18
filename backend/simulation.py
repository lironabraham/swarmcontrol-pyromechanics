import asyncio
import json
import struct
import time

import numpy as np

from .agent_logic import Fleet
from .enums import CellState
from .world import World


class Simulation:
    """Owns the world, fleet, command queue and broadcast fan-out."""

    def __init__(self, config_path):
        with open(config_path, "r", encoding="utf-8") as f:
            self.cfg = json.load(f)
        self.rng = np.random.default_rng(int(self.cfg["world"]["seed"]))
        self.world = World(self.cfg, self.rng)
        self.fleet = Fleet(self.cfg, self.world)
        self.tick = 0
        self.command_queue: asyncio.Queue = asyncio.Queue()
        self.subscribers: set = set()
        self._stopped = False

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

            self.world.step()
            self.fleet.step(self.world.dt)
            self.tick += 1

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
        state_bytes, intensity_bytes = self.world.serialize_grid()
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
        }
        meta_bytes = json.dumps(meta, separators=(",", ":")).encode("utf-8")
        header = struct.pack("<IHH", self.tick, self.world.size, len(meta_bytes))
        return header + state_bytes + intensity_bytes + meta_bytes
