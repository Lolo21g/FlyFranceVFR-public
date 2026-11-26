"""Commande directe d'un avion IA via SimConnect AI WAYPOINT LIST.

Ce module ne choisit jamais lui-même une route au sol : les points doivent
provenir d'une route d'aérodrome vérifiée (taxiway/runway). Il ne doit pas être
utilisé avec des coordonnées approximatives autour d'un parking.
"""
from __future__ import annotations

import ctypes
from dataclasses import dataclass
from typing import Iterable

# Valeurs définies par SIMCONNECT_WAYPOINT_FLAGS (SDK MSFS).
WAYPOINT_SPEED_REQUESTED = 0x00000004
WAYPOINT_THROTTLE_REQUESTED = 0x00000008
WAYPOINT_COMPUTE_VERTICAL_SPEED = 0x00000010
WAYPOINT_ALTITUDE_IS_AGL = 0x00000020
WAYPOINT_ON_GROUND = 0x00100000
WAYPOINT_REVERSE = 0x00200000
WAYPOINT_WRAP_TO_FIRST = 0x00400000


class SimConnectWaypoint(ctypes.Structure):
    # SimConnect.h est compilé en #pragma pack(1) : SIMCONNECT_DATA_WAYPOINT fait
    # 44 octets, pas 48. Sans cela MSFS répond SIMCONNECT_EXCEPTION_INVALID_DATA_SIZE.
    _pack_ = 1
    _fields_ = [
        ("Latitude", ctypes.c_double),
        ("Longitude", ctypes.c_double),
        ("Altitude", ctypes.c_double),
        ("Flags", ctypes.c_uint32),
        ("ktsSpeed", ctypes.c_double),
        ("percentThrottle", ctypes.c_double),
    ]


@dataclass(frozen=True)
class RoutePoint:
    latitude: float
    longitude: float
    altitude_ft: float
    speed_kt: float
    on_ground: bool = False
    altitude_is_agl: bool = False
    compute_vertical_speed: bool = False


def validate_route(points: Iterable[RoutePoint]) -> tuple[RoutePoint, ...]:
    route = tuple(points)
    if len(route) < 2:
        raise ValueError("Une route IA doit contenir au moins deux points")
    for index, point in enumerate(route):
        if not (-90.0 <= float(point.latitude) <= 90.0):
            raise ValueError(f"Latitude invalide au point {index + 1}")
        if not (-180.0 <= float(point.longitude) <= 180.0):
            raise ValueError(f"Longitude invalide au point {index + 1}")
        if not (0.0 <= float(point.speed_kt) <= 200.0):
            raise ValueError(f"Vitesse invalide au point {index + 1} (0 à 200 kt)")
        if not (-1000.0 <= float(point.altitude_ft) <= 60000.0):
            raise ValueError(f"Altitude invalide au point {index + 1}")
    if not any(p.on_ground for p in route):
        raise ValueError("La route doit préciser au moins un point au sol")
    if not any(not p.on_ground for p in route):
        raise ValueError("La route doit préciser au moins un point en vol")
    return route


def build_waypoint_array(points: Iterable[RoutePoint]):
    route = validate_route(points)
    result = (SimConnectWaypoint * len(route))()
    for i, point in enumerate(route):
        flags = WAYPOINT_SPEED_REQUESTED
        if point.on_ground:
            flags |= WAYPOINT_ON_GROUND
        if point.altitude_is_agl:
            flags |= WAYPOINT_ALTITUDE_IS_AGL
        if point.compute_vertical_speed:
            flags |= WAYPOINT_COMPUTE_VERTICAL_SPEED
        result[i] = SimConnectWaypoint(
            float(point.latitude), float(point.longitude), float(point.altitude_ft),
            flags, float(point.speed_kt), 0.0,
        )
    return result


def send_waypoint_route(sm, object_id: int, points: Iterable[RoutePoint], *, release_atc: bool = True) -> dict:
    """Libère éventuellement l'ATC puis envoie une liste de waypoints à l'objet IA.

    À appeler exclusivement depuis le thread SimConnect du Bridge.
    La définition est dédiée à cet objet pour éviter de réutiliser un ID avec
    une structure différente.
    """
    object_id = int(object_id)
    if object_id <= 0:
        raise ValueError("ObjectID SimConnect invalide")
    route = validate_route(points)
    data = build_waypoint_array(route)
    definition_id = sm.new_def_id()
    definition_value = int(definition_id.value)

    if release_atc:
        request = sm.new_request_id()
        hr = sm.dll.AIReleaseControl(sm.hSimConnect, object_id, int(request.value))
        if not sm.IsHR(hr, 0):
            raise RuntimeError(
                f"AIReleaseControl refusé (HRESULT {int(hr) & 0xffffffff:#010x})"
            )

    datatype = getattr(sm, "_traffic_ai_waypoint_datatype", None)
    if datatype is None:
        # L'énumération est importée par le Bridge et passée ici pour rester
        # indépendant du wrapper Python dans les tests hors MSFS.
        raise RuntimeError("Type SimConnect WAYPOINT non fourni par le Bridge")

    hr = sm.dll.AddToDataDefinition(
        sm.hSimConnect, definition_value, b"AI WAYPOINT LIST", b"number",
        datatype, 0.0, getattr(sm, "_traffic_ai_unused", 0xFFFFFFFF),
    )
    if not sm.IsHR(hr, 0):
        raise RuntimeError(
            f"AddToDataDefinition AI WAYPOINT LIST refusé (HRESULT {int(hr) & 0xffffffff:#010x})"
        )

    hr = sm.dll.SetDataOnSimObject(
        sm.hSimConnect, definition_value, object_id, 0,
        len(route), ctypes.sizeof(SimConnectWaypoint), ctypes.cast(data, ctypes.c_void_p),
    )
    if not sm.IsHR(hr, 0):
        raise RuntimeError(
            f"SetDataOnSimObject AI WAYPOINT LIST refusé (HRESULT {int(hr) & 0xffffffff:#010x})"
        )
    return {
        "object_id": object_id,
        "definition_id": definition_value,
        "waypoint_count": len(route),
        "released_atc": bool(release_atc),
        "waypoint_size": ctypes.sizeof(SimConnectWaypoint),
    }


def _record_holding_anchor(sm, object_id: int, route: tuple[RoutePoint, ...]) -> str:
    """Enregistre le point d'attente (dernier waypoint) dans le tracker radio du Bridge.

    Le module est chargé par le Bridge (exe PyInstaller) : on retrouve ses
    variables via sys.modules (le Bridge s'exécute sous "__main__" ou
    "msfs_bridge_work"). Retourne une courte description de l'opération.
    """
    import sys

    try:
        bridge = None
        for name in ("msfs_bridge_work", "__main__"):
            module = sys.modules.get(name)
            if module is not None and hasattr(module, "_ai_object_records"):
                bridge = module
                break
        if bridge is None:
            return "module Bridge introuvable"
        records = bridge._ai_object_records
        lock = getattr(bridge, "_ai_pending_lock", None)
        holding = route[-1]
        if lock is not None:
            with lock:
                record = records.get(int(object_id))
                if record is None:
                    return "objet inconnu"
                record["taxi_holding_anchor"] = {
                    "lat": float(holding.latitude), "lon": float(holding.longitude)}
                record["taxi_source_phase_guided"] = True
                tracker = record.get("radio_tracker")
                if tracker is not None:
                    tracker.holding_position = (float(holding.latitude), float(holding.longitude))
                    return f"radio tracker renseigne (lat={holding.latitude:.6f}, lon={holding.longitude:.6f})"
                return "ancre enregistree (tracker absent)"
        return "verrou indisponible"
    except Exception as exc:
        return f"echec: {exc}"


def validate_ground_route(points: Iterable[RoutePoint]) -> tuple[RoutePoint, ...]:
    route = tuple(points)
    if len(route) < 2:
        raise ValueError("Un roulage IA doit contenir au moins deux points")
    for index, point in enumerate(route):
        if not (-90.0 <= float(point.latitude) <= 90.0):
            raise ValueError(f"Latitude invalide au point {index + 1}")
        if not (-180.0 <= float(point.longitude) <= 180.0):
            raise ValueError(f"Longitude invalide au point {index + 1}")
        if not point.on_ground:
            raise ValueError("Tous les points du parcours de roulage doivent être au sol")
        if not (0.5 <= float(point.speed_kt) <= 15.0):
            raise ValueError(f"Vitesse de roulage invalide au point {index + 1} (0,5 à 15 kt)")
    return route


def send_ground_route(sm, object_id: int, points: Iterable[RoutePoint], *, release_atc: bool = True) -> dict:
    """Envoie un chemin de roulage vérifié, limité au point d'attente."""
    object_id = int(object_id)
    if object_id <= 0:
        raise ValueError("ObjectID SimConnect invalide")
    route = validate_ground_route(points)
    # MSFS ignore AI WAYPOINT LIST au sol : après AIReleaseControl l'avion reste
    # figé (vitesse 0 kt) et ne roule jamais. On enregistre tout de même le point
    # d'attente pour la radio, puis on lève une erreur pour que le Bridge replie
    # sur le plan de vol ATC MSFS (AISetAircraftFlightPlan), seul mode qui fait
    # réellement rouler l'avion jusqu'au point d'attente.
    recording_status = _record_holding_anchor(sm, object_id, route)
    raise RuntimeError(
        "Roulage direct par waypoints désactivé (MSFS fige l'avion au sol) ; "
        "pilotage ATC MSFS ; ancrage point d'attente "
        f"{recording_status or 'non enregistré'}"
    )
    data = (SimConnectWaypoint * len(route))()
    for i, point in enumerate(route):
        data[i] = SimConnectWaypoint(float(point.latitude), float(point.longitude),
            float(point.altitude_ft), WAYPOINT_SPEED_REQUESTED | WAYPOINT_ON_GROUND,
            float(point.speed_kt), 0.0)
    definition_id = sm.new_def_id()
    definition_value = int(definition_id.value)
    if release_atc:
        request = sm.new_request_id()
        hr = sm.dll.AIReleaseControl(sm.hSimConnect, object_id, int(request.value))
        if not sm.IsHR(hr, 0):
            raise RuntimeError(f"AIReleaseControl refusé (HRESULT {int(hr) & 0xffffffff:#010x})")
    datatype = getattr(sm, "_traffic_ai_waypoint_datatype", None)
    if datatype is None:
        raise RuntimeError("Type SimConnect WAYPOINT non fourni par le Bridge")
    hr = sm.dll.AddToDataDefinition(sm.hSimConnect, definition_value, b"AI WAYPOINT LIST", b"number",
        datatype, 0.0, getattr(sm, "_traffic_ai_unused", 0xFFFFFFFF))
    if not sm.IsHR(hr, 0):
        raise RuntimeError(f"AddToDataDefinition AI WAYPOINT LIST refusé (HRESULT {int(hr) & 0xffffffff:#010x})")
    hr = sm.dll.SetDataOnSimObject(sm.hSimConnect, definition_value, object_id, 0,
        len(route), ctypes.sizeof(SimConnectWaypoint), ctypes.cast(data, ctypes.c_void_p))
    if not sm.IsHR(hr, 0):
        raise RuntimeError(f"SetDataOnSimObject AI WAYPOINT LIST refusé (HRESULT {int(hr) & 0xffffffff:#010x})")
    return {"object_id": object_id, "definition_id": definition_value,
            "waypoint_count": len(route), "released_atc": bool(release_atc),
            "waypoint_size": ctypes.sizeof(SimConnectWaypoint)}



def validate_airborne_route(points: Iterable[RoutePoint]) -> tuple[RoutePoint, ...]:
    """Route entièrement en vol (circuit, vol local) : aucun point au sol."""
    route = tuple(points)
    if len(route) < 2:
        raise ValueError("Une route aérienne IA doit contenir au moins deux points")
    for index, point in enumerate(route):
        if not (-90.0 <= float(point.latitude) <= 90.0):
            raise ValueError(f"Latitude invalide au point {index + 1}")
        if not (-180.0 <= float(point.longitude) <= 180.0):
            raise ValueError(f"Longitude invalide au point {index + 1}")
        if point.on_ground:
            raise ValueError("Tous les points d'une route aérienne doivent être en vol")
        if not (40.0 <= float(point.speed_kt) <= 160.0):
            raise ValueError(f"Vitesse invalide au point {index + 1} (40 à 160 kt)")
        if not (100.0 <= float(point.altitude_ft) <= 12000.0):
            raise ValueError(f"Hauteur invalide au point {index + 1} (100 à 12000 ft)")
    return route


def send_airborne_route(sm, object_id: int, points: Iterable[RoutePoint], *, release_atc: bool = True) -> dict:
    """Envoie une liste de waypoints à un avion IA déjà en l'air.

    Les altitudes sont interprétées en AGL (hauteur sol). À appeler depuis le
    thread SimConnect du Bridge, après avoir renseigné
    sm._traffic_ai_waypoint_datatype.
    """
    object_id = int(object_id)
    if object_id <= 0:
        raise ValueError("ObjectID SimConnect invalide")
    route = validate_airborne_route(points)
    data = (SimConnectWaypoint * len(route))()
    flags = WAYPOINT_SPEED_REQUESTED | WAYPOINT_ALTITUDE_IS_AGL | WAYPOINT_COMPUTE_VERTICAL_SPEED
    for i, point in enumerate(route):
        data[i] = SimConnectWaypoint(float(point.latitude), float(point.longitude),
            float(point.altitude_ft), flags, float(point.speed_kt), 0.0)
    definition_id = sm.new_def_id()
    definition_value = int(definition_id.value)
    if release_atc:
        request = sm.new_request_id()
        hr = sm.dll.AIReleaseControl(sm.hSimConnect, object_id, int(request.value))
        if not sm.IsHR(hr, 0):
            raise RuntimeError(f"AIReleaseControl refusé (HRESULT {int(hr) & 0xffffffff:#010x})")
    datatype = getattr(sm, "_traffic_ai_waypoint_datatype", None)
    if datatype is None:
        raise RuntimeError("Type SimConnect WAYPOINT non fourni par le Bridge")
    # SIMCONNECT_UNUSED (0xFFFFFFFF) si le Bridge n'a pas défini la valeur.
    unused = getattr(sm, "_traffic_ai_unused", 0xFFFFFFFF)
    hr = sm.dll.AddToDataDefinition(sm.hSimConnect, definition_value, b"AI WAYPOINT LIST", b"number",
        datatype, 0.0, unused)
    if not sm.IsHR(hr, 0):
        raise RuntimeError(f"AddToDataDefinition AI WAYPOINT LIST refusé (HRESULT {int(hr) & 0xffffffff:#010x})")
    hr = sm.dll.SetDataOnSimObject(sm.hSimConnect, definition_value, object_id, 0,
        len(route), ctypes.sizeof(SimConnectWaypoint), ctypes.cast(data, ctypes.c_void_p))
    if not sm.IsHR(hr, 0):
        raise RuntimeError(f"SetDataOnSimObject AI WAYPOINT LIST refusé (HRESULT {int(hr) & 0xffffffff:#010x})")
    return {"object_id": object_id, "definition_id": definition_value,
            "waypoint_count": len(route), "released_atc": bool(release_atc)}


def release_atc_control(sm, object_id: int) -> dict:
    """Libère le contrôle ATC sans envoyer de waypoints (à appeler depuis le thread SimConnect)."""
    object_id = int(object_id)
    if object_id <= 0:
        raise ValueError("ObjectID SimConnect invalide")
    request = sm.new_request_id()
    hr = sm.dll.AIReleaseControl(sm.hSimConnect, object_id, int(request.value))
    if not sm.IsHR(hr, 0):
        raise RuntimeError(f"AIReleaseControl refusé (HRESULT {int(hr) & 0xffffffff:#010x})")
    return {"object_id": object_id, "released": True}