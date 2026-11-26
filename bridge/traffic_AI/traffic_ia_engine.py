"""Moteur métier Traffic IA FlyFranceVFR — étape de fondation.

Ce module est indépendant de l'interface et de SimConnect. Il gère la flotte
fictive, la densité, les limites géographiques, la visibilité cartographique,
la temporisation de matérialisation et les alertes transitoires.
Il ne pilote PAS encore les objets physiques MSFS : cette liaison nécessite
une étape Bridge dédiée et des essais en simulateur.
"""
from __future__ import annotations

from dataclasses import dataclass, asdict
from datetime import datetime
from pathlib import Path
from typing import Any, Optional
import json, math, random, time

EARTH_RADIUS_KM = 6371.0088


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(min(1.0, math.sqrt(a)))


def bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


@dataclass
class AircraftTrack:
    pilot_id: str
    callsign: str
    voice: str
    aircraft: str
    lat: float
    lon: float
    altitude_ft: float
    heading: float
    speed_kt: float
    on_ground: bool = False
    parked: bool = False
    physical_object_id: Optional[int] = None
    visible_on_map: bool = False
    previous_distance_km: Optional[float] = None
    last_alert_level: str = "none"


class TrafficIAEngine:
    """Gestion déterministe de la flotte et calculs métier, sans dépendance MSFS."""
    def __init__(self, config_path: str | Path, *, rng: Optional[random.Random] = None):
        self.config_path = Path(config_path)
        self.config = json.loads(self.config_path.read_text(encoding="utf-8"))
        self.rng = rng or random.Random()
        self.enabled = False  # toujours OFF au lancement
        self.density_mode = "auto"  # les réglages ne sont pas persistés
        self.volume_radio = 1.0
        self.volume_alerts = 1.0
        self.followed_pilot_id: Optional[str] = None
        self.tracks: dict[str, AircraftTrack] = {}
        self.physical_ids: set[int] = set()
        self.last_simconnect_seen = time.monotonic()
        self.disconnect_started: Optional[float] = None
        self.pending_spawn_at: Optional[float] = None
        self.alerts: list[dict[str, Any]] = []  # mémoire vive uniquement, jamais de journal
        self._previous_own_position: Optional[tuple[float, float]] = None
        self._last_own_heading: Optional[float] = None

    @property
    def regional_radius_km(self) -> float: return int(self.config["regional_radius_km"])
    @property
    def map_visible_radius_km(self) -> float: return int(self.config["map_visible_radius_km"])
    @property
    def map_hysteresis_radius_km(self) -> float: return int(self.config["map_hysteresis_radius_km"])
    @property
    def max_physical(self) -> int: return int(self.config["max_physical_msfs_aircraft"])

    def set_enabled(self, enabled: bool) -> None:
        self.enabled = bool(enabled)
        if not self.enabled:
            self.followed_pilot_id = None
            self.pending_spawn_at = None
            self.alerts.clear()
            # Les identifiants physiques sont renvoyés à l'adaptateur Bridge
            # via take_objects_to_remove(); aucun appel SimConnect ici.

    def set_density(self, mode: str) -> None:
        if mode not in {"auto", "low", "normal", "high"}:
            raise ValueError("Densité inconnue : choisir auto, low, normal ou high")
        self.density_mode = mode

    def effective_density(self, sim_time: datetime, *, weekday: Optional[int] = None,
                           airport_activity: float = 0.5, weather_factor: float = 1.0) -> str:
        if self.density_mode != "auto": return self.density_mode
        day = sim_time.weekday() if weekday is None else weekday
        hour = sim_time.hour + sim_time.minute / 60
        # Activité de loisir VFR : creux nocturne, hausse week-end et journée.
        score = 0.35 + max(0.0, 1 - abs(hour - 15) / 9) * 0.35
        score += (0.12 if day >= 5 else 0.0)
        score += max(0.0, min(1.0, airport_activity)) * 0.22
        score *= max(0.25, min(1.0, weather_factor))
        return "high" if score >= 0.78 else "normal" if score >= 0.48 else "low"

    def target_aircraft_count(self, density: str) -> int:
        return min(self.max_physical, {"low": 3, "normal": 6, "high": 8}.get(density, 6))

    def note_simconnect(self, connected: bool, now: Optional[float] = None) -> str:
        now = time.monotonic() if now is None else now
        if connected:
            self.last_simconnect_seen = now
            self.disconnect_started = None
            return "connected"
        if self.disconnect_started is None:
            self.disconnect_started = now
            return "grace_period"
        if now - self.disconnect_started >= int(self.config["simconnect_loss_grace_seconds"]):
            self.set_enabled(False)
            return "traffic_stopped"
        return "grace_period"

    def update_ownship(self, lat: float, lon: float, altitude_ft: float, heading: float,
                       ground_speed_kt: float, on_ground: bool, sim_time: Optional[datetime] = None) -> None:
        """Actualise la référence avion joueur et le délai de prochaine matérialisation."""
        self._own = {"lat": lat, "lon": lon, "altitude_ft": altitude_ft,
                     "heading": heading % 360, "ground_speed_kt": ground_speed_kt,
                     "on_ground": bool(on_ground), "sim_time": sim_time or datetime.now()}
        if self.enabled and self.pending_spawn_at is None:
            lo, hi = self.config["spawn_interval_seconds"]["min"], self.config["spawn_interval_seconds"]["max"]
            self.pending_spawn_at = time.monotonic() + self.rng.uniform(lo, hi)

    def update_track(self, pilot_id: str, *, lat: float, lon: float, altitude_ft: float,
                     heading: float, speed_kt: float, on_ground: bool = False,
                     parked: bool = False, physical_object_id: Optional[int] = None) -> AircraftTrack:
        pilot = next((p for p in self.config["pilots"] if p["id"] == pilot_id), None)
        if pilot is None: raise KeyError(f"Pilote inconnu : {pilot_id}")
        track = self.tracks.get(pilot_id) or AircraftTrack(
            pilot_id=pilot_id, callsign=pilot["callsign"],
            voice=pilot["voice"], aircraft=pilot["aircraft"],
            lat=lat, lon=lon, altitude_ft=altitude_ft, heading=heading % 360,
            speed_kt=speed_kt)
        track.lat, track.lon, track.altitude_ft = lat, lon, altitude_ft
        track.heading, track.speed_kt = heading % 360, speed_kt
        track.on_ground, track.parked = bool(on_ground), bool(parked)
        track.physical_object_id = physical_object_id
        self.tracks[pilot_id] = track
        if physical_object_id is not None: self.physical_ids.add(int(physical_object_id))
        return track

    def refresh_visibility(self, own_lat: float, own_lon: float) -> list[dict[str, Any]]:
        """Applique 15 km / hystérésis 17 km. Les avions garés restent visibles."""
        visible = []
        for track in self.tracks.values():
            distance = haversine_km(own_lat, own_lon, track.lat, track.lon)
            if track.parked:
                track.visible_on_map = distance <= self.map_hysteresis_radius_km
            elif track.visible_on_map:
                track.visible_on_map = distance <= self.map_hysteresis_radius_km
            else:
                track.visible_on_map = distance <= self.map_visible_radius_km
            if track.visible_on_map:
                item = asdict(track); item["distance_km"] = round(distance, 2); visible.append(item)
        return visible

    def select_follow(self, pilot_id: Optional[str]) -> None:
        if pilot_id is not None and pilot_id not in self.tracks:
            raise KeyError(f"Avion absent du trafic : {pilot_id}")
        self.followed_pilot_id = pilot_id

    def physical_slot_available(self) -> bool:
        return len(self.physical_ids) < self.max_physical

    def spawn_due(self, now: Optional[float] = None) -> bool:
        now = time.monotonic() if now is None else now
        if not self.enabled or self.pending_spawn_at is None or now < self.pending_spawn_at:
            return False
        self.pending_spawn_at = None
        return self.physical_slot_available()

    def take_objects_to_remove(self) -> list[int]:
        """L'adaptateur SimConnect doit consommer ces IDs et appeler AIRemoveObject."""
        ids = sorted(self.physical_ids)
        self.physical_ids.clear()
        for track in self.tracks.values(): track.physical_object_id = None
        return ids

    def proximity_alerts(self, own_lat: float, own_lon: float, own_alt_ft: float,
                         own_heading: float, *, horizontal_km: float = 5.0,
                         vertical_ft: float = 1000.0) -> list[dict[str, Any]]:
        """Retourne les alertes courantes; aucune persistance/historique."""
        current = []
        for track in self.tracks.values():
            d = haversine_km(own_lat, own_lon, track.lat, track.lon)
            vertical = abs(own_alt_ft - track.altitude_ft)
            if d > horizontal_km or vertical > vertical_ft: continue
            previous = track.previous_distance_km
            trend = "stable" if previous is None or abs(d - previous) < 0.03 else ("rapprochement" if d < previous else "éloignement")
            relative_bearing = bearing_deg(own_lat, own_lon, track.lat, track.lon)
            diff = abs((relative_bearing - own_heading + 180) % 360 - 180)
            converging = trend == "rapprochement" and diff < 60
            level = "danger" if d < 1.0 and vertical < 500 else "warning" if d < 3.0 and converging else "info"
            alert = {"pilot_id": track.pilot_id, "callsign": track.callsign,
                     "distance_km": round(d, 2), "vertical_ft": round(vertical),
                     "trend": "trajectoires_convergentes" if converging else trend,
                     "level": level, "heading": track.heading}
            current.append(alert)
            track.previous_distance_km = d
            track.last_alert_level = level
        self.alerts = current
        return current

    def fleet_manifest(self) -> list[dict[str, Any]]:
        return [dict(p) for p in self.config["pilots"]]

    def status(self) -> dict[str, Any]:
        return {"enabled": self.enabled, "density": self.density_mode,
                "regional_radius_km": self.regional_radius_km,
                "map_visible_radius_km": self.map_visible_radius_km,
                "map_hysteresis_radius_km": self.map_hysteresis_radius_km,
                "physical_aircraft": len(self.physical_ids),
                "max_physical_aircraft": self.max_physical,
                "fleet_size": len(self.config["pilots"]),
                "followed_pilot_id": self.followed_pilot_id,
                "alerts": list(self.alerts)}
