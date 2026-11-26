"""Détection des annonces radio A/A d'un avion IA en tour de piste.

Le module ne pilote pas l'avion : il observe uniquement sa télémétrie SimConnect
et émet une seule fois les jalons radio détectables.
"""
from __future__ import annotations
import math
import time


def _destination_point(lat: float, lon: float, bearing_deg: float, distance_nm: float) -> tuple[float, float]:
    radius_m = 6371008.8
    angular = float(distance_nm) * 1852.0 / radius_m
    bearing = math.radians(float(bearing_deg) % 360.0)
    lat1, lon1 = math.radians(lat), math.radians(lon)
    lat2 = math.asin(math.sin(lat1) * math.cos(angular) +
                     math.cos(lat1) * math.sin(angular) * math.cos(bearing))
    lon2 = lon1 + math.atan2(math.sin(bearing) * math.sin(angular) * math.cos(lat1),
                             math.cos(angular) - math.sin(lat1) * math.sin(lat2))
    return math.degrees(lat2), (math.degrees(lon2) + 540.0) % 360.0 - 180.0


def _distance_nm(a_lat: float, a_lon: float, b_lat: float, b_lon: float) -> float:
    r = 6371008.8
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp, dl = p2 - p1, math.radians(b_lon - a_lon)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(h))) / 1852.0


def _angle_diff(a: float, b: float) -> float:
    return abs((float(a) - float(b) + 180.0) % 360.0 - 180.0)


class AIRadioCircuitTracker:
    """Convertit les mouvements observés en identifiants de phrases AA."""
    def __init__(self, airport_lat: float, airport_lon: float, runway_heading: float,
                 direction: str = "left", now_fn=time.monotonic):
        self.airport_lat = float(airport_lat)
        self.airport_lon = float(airport_lon)
        self.runway_heading = float(runway_heading) % 360.0
        self.direction = "right" if str(direction).lower() == "right" else "left"
        self.side = 1.0 if self.direction == "right" else -1.0
        self.now_fn = now_fn
        # L'ATC de MSFS choisit la piste selon son propre vent : au décollage on
        # compare le cap réel au QFU prévu et on bascule sur la piste opposée si besoin.
        self.runway_flipped = False
        self.taxi_since: float | None = None
        self.prev_speed = 0.0
        self.axis_roll_samples = 0
        self.events: set[str] = set()
        self.phase = "parked"
        self.start_position: tuple[float, float] | None = None
        self.hold_since: float | None = None
        self.vacate_since: float | None = None
        self.parked_since: float | None = None
        self.touchdown_at: float | None = None
        self.holding_position: tuple[float, float] | None = None
        self.last_on_ground = True
        self.airborne = False
        self.last_event_at = 0.0

    def _emit(self, event_id: str, out: list[str]) -> None:
        if event_id not in self.events:
            self.events.add(event_id)
            out.append(event_id)
            self.last_event_at = self.now_fn()

    def _near_pattern_point(self, lat: float, lon: float, along_nm: float,
                             lateral_nm: float, radius_nm: float) -> bool:
        target_lat, target_lon = _destination_point(
            self.airport_lat, self.airport_lon, self.runway_heading, along_nm)
        if lateral_nm:
            target_lat, target_lon = _destination_point(
                target_lat, target_lon,
                self.runway_heading + (-90.0 if self.side < 0 else 90.0), abs(lateral_nm))
        return _distance_nm(lat, lon, target_lat, target_lon) <= radius_nm

    def _local_coordinates(self, lat: float, lon: float) -> tuple[float, float]:
        """Retourne (distance dans l'axe, distance latérale signée) en NM."""
        distance = _distance_nm(self.airport_lat, self.airport_lon, lat, lon)
        bearing = math.degrees(math.atan2(
            math.sin(math.radians(lon - self.airport_lon)) * math.cos(math.radians(lat)),
            math.cos(math.radians(self.airport_lat)) * math.sin(math.radians(lat)) -
            math.sin(math.radians(self.airport_lat)) * math.cos(math.radians(lat)) *
            math.cos(math.radians(lon - self.airport_lon)))) % 360.0
        delta = math.radians((bearing - self.runway_heading + 180.0) % 360.0 - 180.0)
        along = distance * math.cos(delta)
        lateral = distance * math.sin(delta)
        return along, lateral

    def update(self, *, lat: float, lon: float, heading: float, ground_speed: float,
               on_ground: bool, now: float | None = None) -> list[str]:
        now = self.now_fn() if now is None else float(now)
        lat, lon = float(lat), float(lon)
        heading, speed = float(heading) % 360.0, max(0.0, float(ground_speed))
        out: list[str] = []
        if self.start_position is None and on_ground:
            self.start_position = (lat, lon)

        along, lateral = self._local_coordinates(lat, lon)
        lateral_on_circuit_side = lateral * self.side

        # Départ du parking : annonce dès le début réel du roulage.
        if self.phase == "parked" and on_ground and speed >= 2.0:
            self._emit("aa-taxi-tdp", out)
            self.phase = "taxi"
            self.taxi_since = now

        # Axe de piste : l'ATC de MSFS peut utiliser l'un ou l'autre sens.
        if on_ground and self.phase in ("taxi", "holding"):
            moved_nm = (_distance_nm(*self.start_position, lat, lon)
                        if self.start_position else 0.0)
            axis_diff = min(_angle_diff(heading, self.runway_heading),
                            _angle_diff(heading, self.runway_heading + 180.0))
            aligned = axis_diff <= 40.0
            near_runway_axis = abs(lateral) <= 0.075 and abs(along) <= 0.65
            if self.holding_position is not None:
                holding_geometry_ok = _distance_nm(lat, lon, *self.holding_position) <= 0.012
            else:
                holding_geometry_ok = aligned and near_runway_axis
            taxi_elapsed = now - self.taxi_since if self.taxi_since is not None else 0.0

            # Prêt au départ : annonce UNIQUEMENT à l'arrêt effectif au point
            # d'attente (l'avion s'arrête bien sur le HOLD_SHORT). Ne pas
            # anticiper la phrase pendant le roulage : c'est elle qui est
            # prononcée trop tôt sinon. Repli générique (sans point d'attente
            # connu) conservé, mais également exigeant l'arrêt.
            stopped = speed <= 3.0
            # tolérance : la télémétrie est lente (~5 s), on garde l'échantillon
            # précédent pour ne pas rater un ralentissement bref au point
            # d'attente. L'ATC MSFS ne s'arrête pas toujours totalement au
            # HOLD_SHORT : il peut le franchir au pas (2 à 3 kt), et roule
            # ailleurs à 4,5 kt et plus.
            stopped_seen = stopped or (speed <= 6.0 and self.prev_speed <= 3.0)
            at_hold = (self.holding_position is not None and
                       # Rayon large (~92 m) : l'ATC MSFS roule par sa propre
                       # route et peut s'arrêter à quelques dizaines de mètres
                       # de l'ancre calculée. L'arrêt effectif reste exigé.
                       _distance_nm(lat, lon, *self.holding_position) <= 0.05 and
                       # Sur les petits aérodromes le parking est tout proche du
                       # HOLD_SHORT : exiger d'avoir réellement roulé (> 37 m)
                       # pour ne pas annoncer la phrase dès le départ du parking.
                       moved_nm >= 0.02)
            if self.phase == "taxi" and at_hold and stopped_seen:
                self._emit("aa-ready-tdp", out)
                self.phase = "holding"
                self.axis_roll_samples = 0
            elif (self.phase == "taxi" and self.holding_position is None and
                  moved_nm >= 0.03 and taxi_elapsed >= 10.0 and
                  holding_geometry_ok and stopped_seen):
                self._emit("aa-ready-tdp", out)
                self.phase = "holding"
                self.axis_roll_samples = 0
            elif self.phase == "holding" and "aa-takeoff-tdp" not in self.events:
                on_axis = abs(lateral) <= 0.04 and axis_diff <= 25.0
                accelerating = speed - self.prev_speed >= 3.0
                # Roulement de décollage : annoncé AVANT le décollage, au sol.
                if on_axis and ((speed >= 22.0 and accelerating) or speed >= 35.0):
                    if _angle_diff(heading, self.runway_heading) > 90.0:
                        self.runway_heading = (self.runway_heading + 180.0) % 360.0
                        self.runway_flipped = True
                    self._emit("aa-takeoff-tdp", out)
                elif on_axis and 8.0 <= speed < 30.0:
                    # Roule dans l'axe sans accélérer : remontée de piste.
                    self.axis_roll_samples += 1
                    if self.axis_roll_samples >= 2:
                        self._emit("aa-backtrack-tdp", out)
                elif on_axis and speed < 8.0 and "aa-backtrack-tdp" not in self.events:
                    if self.hold_since is None:
                        self.hold_since = now
                    elif now - self.hold_since >= 2.0:
                        self._emit("aa-lineup-tdp", out)
                else:
                    self.axis_roll_samples = 0
                    if speed >= 8.0:
                        self.hold_since = None
        self.prev_speed = speed

        if not on_ground:
            if not self.airborne and speed >= 18.0:
                self.airborne = True
                if "aa-takeoff-tdp" not in self.events and _angle_diff(heading, self.runway_heading) > 90.0:
                    self.runway_heading = (self.runway_heading + 180.0) % 360.0
                    self.runway_flipped = True
                self.phase = "airborne"
                self._emit("aa-takeoff-tdp", out)
            if self.phase == "airborne":
                # Géométrie relative au QFU et au sens du circuit, avec des
                # fenêtres plus larges que le seul rayon autour du waypoint.
                reciprocal = (self.runway_heading + 180.0) % 360.0
                base_heading = (self.runway_heading + self.side * 90.0) % 360.0
                if ("aa-downwind-tdp" not in self.events and
                    0.65 <= lateral_on_circuit_side <= 3.2 and
                    -0.8 <= along <= 1.5 and
                    _angle_diff(heading, reciprocal) <= 55.0):
                    self._emit("aa-downwind-tdp", out)
                if ("aa-base-tdp" not in self.events and
                    "aa-downwind-tdp" in self.events and
                    0.25 <= lateral_on_circuit_side <= 2.2 and
                    -2.0 <= along <= -0.25 and
                    _angle_diff(heading, base_heading) <= 60.0):
                    self._emit("aa-base-tdp", out)
                if ("aa-final-tdp-complet" not in self.events and
                    "aa-base-tdp" in self.events and
                    -3.0 <= along <= -0.65 and abs(lateral) <= 0.85 and
                    _angle_diff(heading, self.runway_heading) <= 40.0):
                    self._emit("aa-final-tdp-complet", out)

        if on_ground and self.airborne:
            self.phase = "landed"
            if self.touchdown_at is None:
                self.touchdown_at = now

        if self.phase == "landed" and on_ground:
            elapsed = now - (self.touchdown_at if self.touchdown_at is not None else now)
            # Une vitesse de roulage ne signifie pas que la piste est dégagée.
            # Il faut être latéralement sorti de la bande de piste (marge incluse).
            safely_off_runway = abs(lateral) >= 0.035
            if safely_off_runway and 2.0 <= speed <= 18.0 and elapsed >= 8.0:
                if self.vacate_since is None:
                    self.vacate_since = now
                elif now - self.vacate_since >= 2.0:
                    self._emit("aa-vacate-tdp", out)
            else:
                self.vacate_since = None
            if speed <= 1.5 and "aa-vacate-tdp" in self.events:
                if self.parked_since is None:
                    self.parked_since = now
                elif now - self.parked_since >= 12.0:
                    self._emit("aa-parking-tdp", out)
                    self._emit("aa-leave-tdp", out)
                    self.phase = "completed"
            else:
                self.parked_since = None
        self.last_on_ground = bool(on_ground)
        return out