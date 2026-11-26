"""Gestion des vols aller-retour ATC des avions Traffic IA (MSFS 2020).

Le roulage, le décollage, l'approche, l'atterrissage et le roulage au parking
sont confiés à l'ATC de MSFS via AISetAircraftFlightPlan. On évite ainsi de
faire suivre à un avion une ligne droite arbitraire entre parking et piste.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import math
import xml.etree.ElementTree as ET


@dataclass(frozen=True)
class Airport:
    icao: str
    name: str
    latitude: float
    longitude: float
    altitude_ft: float = 0.0

    def validate(self) -> None:
        code = self.icao.strip().upper()
        if not (3 <= len(code) <= 4 and code.isalnum()):
            raise ValueError(f"Code OACI invalide : {self.icao!r}")
        if not (-90 <= float(self.latitude) <= 90):
            raise ValueError("Latitude aérodrome invalide")
        if not (-180 <= float(self.longitude) <= 180):
            raise ValueError("Longitude aérodrome invalide")
        if not (-1500 <= float(self.altitude_ft) <= 30000):
            raise ValueError("Altitude aérodrome invalide")


def _dms(value: float, latitude: bool) -> str:
    hemi = ("N" if value >= 0 else "S") if latitude else ("E" if value >= 0 else "W")
    absolute = abs(float(value))
    degrees = int(absolute)
    minutes_float = (absolute - degrees) * 60
    minutes = int(minutes_float)
    seconds = (minutes_float - minutes) * 60
    return f'{hemi}{degrees}° {minutes:02d}\' {seconds:05.2f}"'


def _world_position(airport: Airport) -> str:
    return f"{_dms(airport.latitude, True)},{_dms(airport.longitude, False)},{airport.altitude_ft:+010.2f}"


def _bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return math.degrees(math.atan2(y, x)) % 360.0


def _distance_nm(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 3440.065 * math.asin(min(1.0, math.sqrt(h)))


def build_vfr_flightplan(departure: Airport, destination: Airport, output_dir: str | Path,
                         *, cruise_altitude_ft: int | None = None, leg_name: str = "aller") -> Path:
    """Crée un .PLN MSFS 2020 exploitable par AISetAircraftFlightPlan.

    Le PLN inclut des waypoints intermédiaires à l'altitude de croisière :
    sans eux, l'ATC IA vole direct et rase le sol (~100 ft AGL).
    """
    departure.validate()
    destination.validate()
    if departure.icao.upper() == destination.icao.upper():
        raise ValueError("Le vol doit relier deux aérodromes différents")
    distance_nm = _distance_nm(departure.latitude, departure.longitude,
                               destination.latitude, destination.longitude)
    if cruise_altitude_ft is None:
        cruise_altitude_ft = 1000
    if not 1000 <= int(cruise_altitude_ft) <= 12000:
        raise ValueError("Altitude de croisière VFR hors plage (1000–12000 ft)")

    root = ET.Element("SimBase.Document", {"Type": "AceXML", "version": "1,0"})
    ET.SubElement(root, "Descr").text = "AceXML Document"
    fp = ET.SubElement(root, "FlightPlan.FlightPlan")
    values = [
        ("Title", f"{departure.icao.upper()} to {destination.icao.upper()}"),
        ("FPType", "VFR"), ("RouteType", "Direct"),
        ("CruisingAlt", str(int(cruise_altitude_ft))),
        ("DepartureID", departure.icao.upper()),
        ("DepartureLLA", _world_position(departure)),
        ("DestinationID", destination.icao.upper()),
        ("DestinationLLA", _world_position(destination)),
        ("Descr", f"Traffic IA FlyFranceVFR - {leg_name}"),
        ("DeparturePosition", ""),
        ("DepartureName", departure.name),
        ("DestinationName", destination.name),
    ]
    for tag, value in values:
        ET.SubElement(fp, tag).text = value
    app = ET.SubElement(fp, "AppVersion")
    ET.SubElement(app, "AppVersionMajor").text = "10"
    ET.SubElement(app, "AppVersionBuild").text = "61472"

    bearing = _bearing_deg(departure.latitude, departure.longitude,
                           destination.latitude, destination.longitude)
    planned = [("departure", departure.latitude, departure.longitude, float(departure.altitude_ft))]
    if distance_nm > 8.0:
        d_climb = max(2.0, distance_nm * 0.2)
        d_descent = min(distance_nm - 2.0, distance_nm * 0.8)
        lat_i, lon_i = _destination_point(departure.latitude, departure.longitude, bearing, d_climb)
        planned.append(("MONTEE", lat_i, lon_i, float(cruise_altitude_ft)))
        if distance_nm > 25.0:
            lat_i, lon_i = _destination_point(departure.latitude, departure.longitude, bearing, distance_nm * 0.5)
            planned.append(("CROISIERE", lat_i, lon_i, float(cruise_altitude_ft)))
        lat_i, lon_i = _destination_point(departure.latitude, departure.longitude, bearing, d_descent)
        planned.append(("APPROCHE", lat_i, lon_i, float(cruise_altitude_ft)))
    planned.append(("destination", destination.latitude, destination.longitude, float(destination.altitude_ft)))

    for ident, lat_i, lon_i, alt_i in planned:
        is_airport = ident in ("departure", "destination")
        airport = departure if ident == "departure" else destination
        waypoint = ET.SubElement(fp, "ATCWaypoint", {"id": airport.icao.upper() if is_airport else ident})
        ET.SubElement(waypoint, "ATCWaypointType").text = "Airport" if is_airport else "User"
        ET.SubElement(waypoint, "WorldPosition").text = (
            _dms(lat_i, True) + "," + _dms(lon_i, False) + f",+{alt_i:08.2f}")
        if is_airport:
            icao = ET.SubElement(waypoint, "ICAO")
            ET.SubElement(icao, "ICAOIdent").text = airport.icao.upper()

    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)
    path = out / f"traffic_{departure.icao.upper()}_{destination.icao.upper()}_{leg_name}.pln"
    ET.ElementTree(root).write(path, encoding="utf-8", xml_declaration=True)
    ET.parse(path)
    return path



def _destination_point(lat: float, lon: float, bearing_deg: float, distance_nm: float) -> tuple[float, float]:
    """Point géographique à une distance et un relèvement donnés."""
    radius_m = 6371008.8
    distance_m = float(distance_nm) * 1852.0
    bearing = math.radians(float(bearing_deg) % 360.0)
    lat1, lon1 = math.radians(lat), math.radians(lon)
    angular = distance_m / radius_m
    lat2 = math.asin(math.sin(lat1) * math.cos(angular) +
                     math.cos(lat1) * math.sin(angular) * math.cos(bearing))
    lon2 = lon1 + math.atan2(math.sin(bearing) * math.sin(angular) * math.cos(lat1),
                             math.cos(angular) - math.sin(lat1) * math.sin(lat2))
    return math.degrees(lat2), (math.degrees(lon2) + 540.0) % 360.0 - 180.0


def build_local_circuit_flightplan(airport: Airport, runway_heading_deg: float,
                                   output_dir: str | Path, *,
                                   circuit_direction: str = "left",
                                   circuit_altitude_agl_ft: int = 1000,
                                   circuit_count: int = 3) -> Path:
    """Construit un PLN VFR de plusieurs tours de piste sur le même terrain.

    Chaque tour contient vent traversier, vent arrière, base et finale ; le
    waypoint aérodrome d'arrivée n'est placé qu'après le dernier tour. Le cap
    de piste provient des données de piste de l'aérodrome actif. Le roulage et
    les phases ATC restent pilotés par MSFS.
    """
    airport.validate()
    raw_heading = float(runway_heading_deg)
    if not math.isfinite(raw_heading) or not 0.0 <= raw_heading <= 360.0:
        raise ValueError("Orientation de piste invalide")
    heading = raw_heading % 360.0
    direction = str(circuit_direction or "left").strip().lower()
    if direction not in {"left", "right"}:
        raise ValueError("Sens de circuit invalide (left ou right)")
    if not 500 <= int(circuit_altitude_agl_ft) <= 3000:
        raise ValueError("Hauteur de circuit hors plage (500–3000 ft AGL)")
    if not 1 <= int(circuit_count) <= 5:
        raise ValueError("Le nombre de tours de piste doit être compris entre 1 et 5")

    # Un circuit standard à gauche : les points latéraux sont à gauche du cap
    # de piste. Le sens droit inverse simplement le décalage latéral.
    side = -90.0 if direction == "left" else 90.0
    pattern = [
        ("VENT_TRAVERSIER", heading, 1.0, side, 0.8),
        ("VENT_ARRIERE", heading, 0.2, side, 1.8),
        ("ETAPE_DE_BASE", heading, -1.1, side, 0.9),
        ("FINALE", heading, -1.9, 0.0, 0.0),
    ]
    # Combine deux déplacements orthogonaux à partir du centre de l'aérodrome.
    waypoints = []
    for ident, track, along_nm, lateral_bearing, lateral_nm in pattern:
        lat, lon = _destination_point(airport.latitude, airport.longitude, track, along_nm)
        if lateral_nm:
            lat, lon = _destination_point(lat, lon, heading + side, lateral_nm)
        waypoints.append((ident, lat, lon))

    cruise_alt = int(round(airport.altitude_ft + circuit_altitude_agl_ft))
    root = ET.Element("SimBase.Document", {"Type": "AceXML", "version": "1,0"})
    ET.SubElement(root, "Descr").text = "AceXML Document"
    fp = ET.SubElement(root, "FlightPlan.FlightPlan")
    values = [
        ("Title", f"Circuit VFR {airport.icao.upper()}"),
        ("FPType", "VFR"), ("RouteType", "Direct"),
        ("CruisingAlt", str(cruise_alt)),
        ("DepartureID", airport.icao.upper()),
        ("DepartureLLA", _world_position(airport)),
        ("DestinationID", airport.icao.upper()),
        ("DestinationLLA", _world_position(airport)),
        ("Descr", f"Traffic IA FlyFranceVFR - {circuit_count} tours de piste {direction}"),
        ("DeparturePosition", ""),
        ("DepartureName", airport.name),
        ("DestinationName", airport.name),
    ]
    for tag, value in values:
        ET.SubElement(fp, tag).text = value
    app = ET.SubElement(fp, "AppVersion")
    ET.SubElement(app, "AppVersionMajor").text = "10"
    ET.SubElement(app, "AppVersionBuild").text = "61472"

    start = ET.SubElement(fp, "ATCWaypoint", {"id": airport.icao.upper()})
    ET.SubElement(start, "ATCWaypointType").text = "Airport"
    ET.SubElement(start, "WorldPosition").text = _world_position(airport)
    start_icao = ET.SubElement(start, "ICAO")
    ET.SubElement(start_icao, "ICAOIdent").text = airport.icao.upper()

    # Répéter la séquence complète vent traversier -> vent arrière -> base ->
    # finale. Le dernier tour seulement est suivi du waypoint aérodrome d'arrivée.
    # Des identifiants distincts évitent les doublons dans le parseur PLN de MSFS.
    for lap in range(1, int(circuit_count) + 1):
        for ident, lat, lon in waypoints:
            wp = ET.SubElement(fp, "ATCWaypoint", {"id": f"{ident}_{lap}"})
            ET.SubElement(wp, "ATCWaypointType").text = "User"
            ET.SubElement(wp, "WorldPosition").text = _dms(lat, True) + "," + _dms(lon, False) + f",+{cruise_alt:08.2f}"

    end = ET.SubElement(fp, "ATCWaypoint", {"id": airport.icao.upper() + "_ARR"})
    ET.SubElement(end, "ATCWaypointType").text = "Airport"
    ET.SubElement(end, "WorldPosition").text = _world_position(airport)
    end_icao = ET.SubElement(end, "ICAO")
    ET.SubElement(end_icao, "ICAOIdent").text = airport.icao.upper()

    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)
    path = out / f"traffic_circuit_{airport.icao.upper()}_{int(round(heading)):03d}_{direction}_{int(circuit_count)}tours.pln"
    ET.ElementTree(root).write(path, encoding="utf-8", xml_declaration=True)
    ET.parse(path)
    return path

def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2-lat1), math.radians(lon2-lon1)
    a = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return 2*r*math.asin(min(1.0, math.sqrt(a)))


def reached_airport(traffic_item: dict, airport: Airport, radius_km: float = 2.0) -> bool:
    """Détecte un avion au sol dans l'emprise de l'aérodrome.

    Le Bridge ajoute ensuite une temporisation à l'arrêt pour ne pas déclencher
    le vol retour dès le toucher des roues ou pendant le roulage de dégagement.
    """
    if not bool(traffic_item.get("on_ground")):
        return False
    try:
        distance = haversine_km(float(traffic_item["lat"]), float(traffic_item["lon"]),
                                airport.latitude, airport.longitude)
    except (KeyError, TypeError, ValueError):
        return False
    return distance <= radius_km


def select_first_parked_aircraft(records: dict, airport_icao: str) -> tuple[int, dict] | None:
    """Retourne le premier avion IA créé sur l'aérodrome demandé.

    L'ordre est déterminé par created_at, puis par ObjectID pour rester
    déterministe si deux créations ont exactement le même horodatage.
    Les avions en suppression sont ignorés.
    """
    icao = str(airport_icao or "").strip().upper()
    candidates = []
    for raw_id, record in (records or {}).items():
        if not isinstance(record, dict):
            continue
        if str(record.get("airport_icao", "")).strip().upper() != icao:
            continue
        if record.get("removing"):
            continue
        try:
            object_id = int(raw_id)
            created_at = float(record.get("created_at", 0.0))
        except (TypeError, ValueError):
            continue
        candidates.append((created_at, object_id, dict(record)))
    if not candidates:
        return None
    _created_at, object_id, record = min(candidates, key=lambda item: (item[0], item[1]))
    return object_id, record



def circuit_route_points(airport: Airport, runway_heading_deg: float, *,
                         circuit_direction: str = "left", circuit_altitude_agl_ft: int = 1000,
                         circuit_count: int = 3, speed_kt: float = 70.0) -> list[dict]:
    """Waypoints explicites de N tours de piste (même géométrie que le PLN).

    Entre deux tours, un passage bas (300 ft AGL) dans l'axe simule le
    « touch and go » sans toucher la piste. Le dernier tour s'arrête sur la
    finale : le Bridge rend alors l'avion à l'ATC MSFS pour l'atterrissage.
    """
    airport.validate()
    heading = float(runway_heading_deg) % 360.0
    direction = str(circuit_direction or "left").strip().lower()
    if direction not in {"left", "right"}:
        raise ValueError("Sens de circuit invalide (left ou right)")
    if not 1 <= int(circuit_count) <= 5:
        raise ValueError("Le nombre de tours de piste doit être compris entre 1 et 5")
    side = -90.0 if direction == "left" else 90.0
    agl = float(circuit_altitude_agl_ft)
    # (identifiant, distance dans l'axe NM, décalage latéral NM, hauteur AGL)
    pattern = [("VENT_TRAVERSIER", 1.0, 0.8, agl), ("VENT_ARRIERE", 0.2, 1.8, agl),
               ("ETAPE_DE_BASE", -1.1, 0.9, agl * 0.75), ("FINALE", -1.9, 0.0, agl * 0.6)]
    def locate(along_nm: float, lateral_nm: float) -> tuple[float, float]:
        lat, lon = _destination_point(airport.latitude, airport.longitude, heading, along_nm)
        if lateral_nm:
            lat, lon = _destination_point(lat, lon, heading + side, lateral_nm)
        return lat, lon
    points: list[dict] = []
    for lap in range(1, int(circuit_count) + 1):
        for ident, along, lateral, height in pattern:
            lat, lon = locate(along, lateral)
            points.append({"ident": f"{ident}_{lap}", "lat": lat, "lon": lon,
                           "alt_agl_ft": height, "speed_kt": float(speed_kt)})
        if lap < int(circuit_count):
            lat, lon = locate(0.3, 0.0)
            points.append({"ident": f"PASSAGE_BAS_{lap}", "lat": lat, "lon": lon,
                           "alt_agl_ft": 300.0, "speed_kt": float(speed_kt)})
    return points



def transit_route_points(origin: Airport, destination: Airport, *, speed_kt: float = 100.0) -> list[dict]:
    """Waypoints d'un vol entre deux aérodromes, avec une vraie altitude de croisière.

    Le PLN « direct » entre deux aérodromes ne fixe aucune altitude aux
    waypoints : l'ATC IA de MSFS a été observé à ~100 ft AGL sur tout le trajet.
    Point de montée près du départ, point d'approche avant l'arrivée ; au point
    d'approche le Bridge rend l'avion à l'ATC (descente, circuit, atterrissage).
    """
    origin.validate()
    destination.validate()
    lat1, lon1 = math.radians(origin.latitude), math.radians(origin.longitude)
    lat2, lon2 = math.radians(destination.latitude), math.radians(destination.longitude)
    dl = lon2 - lon1
    bearing = math.degrees(math.atan2(math.sin(dl) * math.cos(lat2),
        math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dl))) % 360.0
    distance_nm = haversine_km(origin.latitude, origin.longitude,
                               destination.latitude, destination.longitude) / 1.852
    if distance_nm < 4.0:
        raise ValueError("Trajet trop court pour une route aérienne explicite")
    cruise_agl = 1500.0 if distance_nm <= 20.0 else 2500.0
    climb_nm = min(3.0, 0.3 * distance_nm)
    approach_nm = min(3.5, 0.3 * distance_nm)
    p1 = _destination_point(origin.latitude, origin.longitude, bearing, climb_nm)
    p2 = _destination_point(origin.latitude, origin.longitude, bearing, distance_nm - approach_nm)
    return [
        {"ident": "MONTEE", "lat": p1[0], "lon": p1[1], "alt_agl_ft": cruise_agl, "speed_kt": float(speed_kt)},
        {"ident": "APPROCHE", "lat": p2[0], "lon": p2[1], "alt_agl_ft": cruise_agl, "speed_kt": float(speed_kt)},
    ]