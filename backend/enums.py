from enum import IntEnum


class FuelType(IntEnum):
    GRASS = 0
    BRUSH = 1
    CANOPY = 2


class CellState(IntEnum):
    UNBURNED = 0
    IGNITED = 1
    ACTIVE_FIRE = 2
    ASH = 3


class DroneState(IntEnum):
    AUTONOMOUS_SWARM = 0
    MANUAL_WAYPOINT = 1
    EMERGENCY_RETREAT = 2
