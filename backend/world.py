import numpy as np

from .enums import CellState


class World:
    """50x50 deterministic fire-propagation grid.

    State is held in parallel NumPy arrays shaped (N, N) in (row=y, col=x)
    layout. All stochastic decisions consume the injected `rng`, so a fixed
    seed yields a fixed simulation given the same command sequence.
    """

    def __init__(self, cfg, rng):
        w = cfg["world"]
        f = cfg["fuel"]

        self.size = int(w["size"])
        self.tick_rate = int(w["tick_rate_hz"])
        self.dt = 1.0 / self.tick_rate
        self.wind = np.array([w["wind"]["dx"], w["wind"]["dy"]], dtype=np.float32)
        wnorm = float(np.linalg.norm(self.wind))
        self.wind_unit = (self.wind / wnorm) if wnorm > 0 else self.wind.copy()
        self.base_ignition = float(w["base_ignition_rate"])
        self.burn_rate = float(w["burn_rate"])
        self.ignition_threshold = float(w["ignition_threshold"])
        self.ambient_temp = float(f["temperature"])
        self.rng = rng

        N = self.size
        self.fuel_density = np.full((N, N), float(f["fuel_density"]), dtype=np.float32)
        self.fuel_type = np.full((N, N), int(f["fuel_type"]), dtype=np.uint8)
        self.moisture = np.full((N, N), float(f["moisture"]), dtype=np.float32)
        self.temperature = np.full((N, N), float(f["temperature"]), dtype=np.float32)
        self.state = np.full((N, N), CellState.UNBURNED, dtype=np.uint8)

        for ig in cfg.get("ignitions", []):
            self._ignite_cell(int(ig["x"]), int(ig["y"]))

        self._dirs = [
            (-1, -1), (0, -1), (1, -1),
            (-1,  0),          (1,  0),
            (-1,  1), (0,  1), (1,  1),
        ]
        self._dir_wind = []
        for dx, dy in self._dirs:
            v = np.array([dx, dy], dtype=np.float32)
            v = v / float(np.linalg.norm(v))
            align = float(np.dot(v, self.wind_unit))
            self._dir_wind.append(float(np.clip(1.0 + align, 0.3, 2.2)))

    def _ignite_cell(self, x, y):
        if 0 <= x < self.size and 0 <= y < self.size:
            if self.state[y, x] == CellState.UNBURNED:
                self.state[y, x] = CellState.ACTIVE_FIRE
                self.temperature[y, x] = self.ignition_threshold + 60.0

    def douse(self, x, y, amount):
        """Apply `amount` water at floating-point (x,y). Returns 1 if the cell
        was fully extinguished, 0 if hit but still burning, -1 if not burning."""
        ix, iy = int(x), int(y)
        if not (0 <= ix < self.size and 0 <= iy < self.size):
            return -1
        s = int(self.state[iy, ix])
        if s not in (CellState.IGNITED, CellState.ACTIVE_FIRE):
            return -1
        self.temperature[iy, ix] -= amount * 5.0
        self.moisture[iy, ix] = min(1.0, float(self.moisture[iy, ix]) + amount * 0.02)
        if self.temperature[iy, ix] < self.ignition_threshold * 0.5:
            self.state[iy, ix] = CellState.UNBURNED
            self.temperature[iy, ix] = self.ambient_temp
            return 1
        return 0

    def step(self):
        dt = self.dt
        N = self.size
        state = self.state

        ignited_mask = (state == CellState.IGNITED)
        active_mask = (state == CellState.ACTIVE_FIRE)

        if ignited_mask.any():
            self.temperature[ignited_mask] += 60.0 * dt
            promote = ignited_mask & (self.temperature >= self.ignition_threshold + 20.0)
            state[promote] = CellState.ACTIVE_FIRE
            active_mask = (state == CellState.ACTIVE_FIRE)

        if active_mask.any():
            self.fuel_density[active_mask] -= self.burn_rate * dt
            np.clip(self.fuel_density, 0.0, 1.0, out=self.fuel_density)
            self.temperature[active_mask] = np.minimum(
                self.temperature[active_mask] + 10.0 * dt, 800.0
            )
            burned_out = active_mask & (self.fuel_density < 0.05)
            state[burned_out] = CellState.ASH
            self.temperature[burned_out] = self.ambient_temp
            active_mask = (state == CellState.ACTIVE_FIRE)

        if active_mask.any():
            unburned = (state == CellState.UNBURNED)
            for (dx, dy), wind_mult in zip(self._dirs, self._dir_wind):
                shifted_src = np.zeros_like(active_mask)
                ys_dst = slice(max(0, dy), N + min(0, dy))
                ys_src = slice(max(0, -dy), N + min(0, -dy))
                xs_dst = slice(max(0, dx), N + min(0, dx))
                xs_src = slice(max(0, -dx), N + min(0, -dx))
                shifted_src[ys_dst, xs_dst] = active_mask[ys_src, xs_src]

                targets = shifted_src & unburned & (self.fuel_density > 0.1)
                if not targets.any():
                    continue
                prob = (
                    self.base_ignition
                    * wind_mult
                    * self.fuel_density
                    * (1.0 - self.moisture)
                    * dt
                )
                rolls = self.rng.random((N, N), dtype=np.float32)
                ignite = targets & (rolls < prob)
                if ignite.any():
                    state[ignite] = CellState.IGNITED
                    self.temperature[ignite] = self.ignition_threshold * 0.6
                    unburned = (state == CellState.UNBURNED)

    def fire_cells(self):
        return np.where(self.state == CellState.ACTIVE_FIRE)

    def is_burning(self, ix, iy):
        if not (0 <= ix < self.size and 0 <= iy < self.size):
            return False
        s = int(self.state[iy, ix])
        return s == CellState.IGNITED or s == CellState.ACTIVE_FIRE

    def serialize_grid(self):
        intensity = np.clip(self.temperature * 0.25, 0.0, 255.0).astype(np.uint8)
        fuel = np.clip(self.fuel_density * 255.0, 0.0, 255.0).astype(np.uint8)
        return self.state.tobytes(), intensity.tobytes(), fuel.tobytes()
