import math
from dataclasses import dataclass

from .enums import DroneState


@dataclass
class Drone:
    id: int
    x: float
    y: float
    battery: float
    water: float
    state: int = int(DroneState.AUTONOMOUS_SWARM)
    target_x: float = 0.0
    target_y: float = 0.0
    has_target: bool = False
    vx: float = 0.0
    vy: float = 0.0


class Fleet:
    """Owns 10 drones, runs the swarm allocator, and enforces the safety
    override (battery-to-base or water-empty -> EMERGENCY_RETREAT)."""

    def __init__(self, cfg, world):
        self.world = world
        d = cfg["drones"]
        self.speed = float(d["speed"])
        self.drain = float(d["battery_drain_per_sec"])
        self.dump_rate = float(d["water_dump_per_sec"])
        self.max_battery = float(d["max_battery"])
        self.max_water = float(d["max_water"])
        self.extinguish_radius = float(d["extinguish_radius"])
        self.safety = float(d["safety_factor"])
        self.base = (float(cfg["base"]["x"]), float(cfg["base"]["y"]))
        self.refill_r = float(cfg["base"]["refill_radius"])

        count = int(d["count"])
        self.max_drones = int(d.get("max_drones", 20))
        self.drones = []
        for i in range(count):
            angle = (i / max(1, count)) * (math.pi * 0.5)
            x = self.base[0] + math.cos(angle) * 1.4
            y = self.base[1] + math.sin(angle) * 1.4
            self.drones.append(
                Drone(
                    id=i,
                    x=x,
                    y=y,
                    battery=self.max_battery,
                    water=self.max_water,
                )
            )

    def cmd_target(self, drone_ids, x, y):
        for did in drone_ids:
            d = self._get(did)
            if d is None:
                continue
            d.state = int(DroneState.MANUAL_WAYPOINT)
            d.target_x = float(x)
            d.target_y = float(y)
            d.has_target = True

    def cmd_autonomous(self, drone_ids):
        for did in drone_ids:
            d = self._get(did)
            if d is None:
                continue
            d.state = int(DroneState.AUTONOMOUS_SWARM)
            d.has_target = False

    def cmd_recall(self, drone_ids):
        for did in drone_ids:
            d = self._get(did)
            if d is None:
                continue
            d.state = int(DroneState.EMERGENCY_RETREAT)
            d.target_x = self.base[0]
            d.target_y = self.base[1]
            d.has_target = True

    def _get(self, did):
        try:
            i = int(did)
        except (TypeError, ValueError):
            return None
        if 0 <= i < len(self.drones):
            return self.drones[i]
        return None

    def _battery_needed(self, d):
        dist = math.hypot(d.x - self.base[0], d.y - self.base[1])
        time_to_base = dist / max(self.speed, 0.01)
        return time_to_base * self.drain * self.safety + 1.0

    def buy_drone(self):
        if len(self.drones) >= self.max_drones:
            return False
        new_id = len(self.drones)
        angle = (new_id / max(1, 10)) * (math.pi * 0.5)
        x = self.base[0] + math.cos(angle) * 1.4
        y = self.base[1] + math.sin(angle) * 1.4
        self.drones.append(
            Drone(id=new_id, x=x, y=y, battery=self.max_battery, water=self.max_water)
        )
        return True

    def step(self, dt):
        self._assign_autonomous_targets()
        extinguished = 0
        for d in self.drones:
            extinguished += self._step_drone(d, dt)
        return extinguished

    def _assign_autonomous_targets(self):
        fire_ys, fire_xs = self.world.fire_cells()
        if len(fire_xs) == 0:
            for d in self.drones:
                if d.state == int(DroneState.AUTONOMOUS_SWARM):
                    d.has_target = False
            return

        claimed = set()

        for d in self.drones:
            if d.state != int(DroneState.AUTONOMOUS_SWARM) or not d.has_target:
                continue
            tx, ty = int(d.target_x), int(d.target_y)
            if self.world.is_burning(tx, ty):
                claimed.add((tx, ty))
            else:
                d.has_target = False

        fire_list = list(zip(fire_xs.tolist(), fire_ys.tolist()))

        for d in self.drones:
            if d.state != int(DroneState.AUTONOMOUS_SWARM) or d.has_target:
                continue
            best = None
            best_dist = float("inf")
            for (fx, fy) in fire_list:
                if (fx, fy) in claimed:
                    continue
                dist = (fx + 0.5 - d.x) ** 2 + (fy + 0.5 - d.y) ** 2
                if dist < best_dist:
                    best_dist = dist
                    best = (fx, fy)
            if best is not None:
                d.target_x = best[0] + 0.5
                d.target_y = best[1] + 0.5
                d.has_target = True
                claimed.add(best)

    def _step_drone(self, d, dt):
        if d.state != int(DroneState.EMERGENCY_RETREAT):
            if d.water <= 0.0 or d.battery <= self._battery_needed(d):
                d.state = int(DroneState.EMERGENCY_RETREAT)
                d.target_x = self.base[0]
                d.target_y = self.base[1]
                d.has_target = True

        if d.has_target:
            ddx = d.target_x - d.x
            ddy = d.target_y - d.y
            dist = math.hypot(ddx, ddy)
            if dist > 1e-4:
                d.vx = (ddx / dist) * self.speed
                d.vy = (ddy / dist) * self.speed
                step = min(self.speed * dt, dist)
                d.x += (ddx / dist) * step
                d.y += (ddy / dist) * step
            else:
                d.vx = 0.0
                d.vy = 0.0
        else:
            d.vx *= 0.5
            d.vy *= 0.5

        if d.has_target or d.state == int(DroneState.EMERGENCY_RETREAT):
            d.battery = max(0.0, d.battery - self.drain * dt)

        if d.state == int(DroneState.EMERGENCY_RETREAT):
            if math.hypot(d.x - self.base[0], d.y - self.base[1]) <= self.refill_r:
                d.battery = self.max_battery
                d.water = self.max_water
                d.state = int(DroneState.AUTONOMOUS_SWARM)
                d.has_target = False
                d.vx = 0.0
                d.vy = 0.0
            return 0

        extinguished = 0
        if d.has_target and d.water > 0.0:
            if math.hypot(d.x - d.target_x, d.y - d.target_y) <= self.extinguish_radius:
                used = min(self.dump_rate * dt, d.water)
                result = self.world.douse(d.x, d.y, used)
                if result == 1:
                    extinguished = 1
                d.water -= used
                tx, ty = int(d.target_x), int(d.target_y)
                if not self.world.is_burning(tx, ty):
                    d.has_target = False
                    if d.state == int(DroneState.MANUAL_WAYPOINT):
                        d.state = int(DroneState.AUTONOMOUS_SWARM)
        return extinguished

    def serialize(self):
        out = []
        for d in self.drones:
            out.append({
                "id": d.id,
                "x": round(d.x, 3),
                "y": round(d.y, 3),
                "vx": round(d.vx, 3),
                "vy": round(d.vy, 3),
                "battery": round(d.battery, 1),
                "water": round(d.water, 1),
                "state": int(d.state),
                "tx": round(d.target_x, 3) if d.has_target else None,
                "ty": round(d.target_y, 3) if d.has_target else None,
            })
        return out
