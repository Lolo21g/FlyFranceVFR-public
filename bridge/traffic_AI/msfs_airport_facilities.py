"""Lecture des infrastructures d'aérodrome via SimConnect Facility Data (MSFS 2020).

Le module récupère le graphe natif TAXI_POINT / TAXI_PARKING / TAXI_PATH,
le met en cache par OACI et calcule un chemin conservateur jusqu'à un point
HOLD_SHORT. Les segments RUNWAY, CLOSED, PATH, ROAD et VEHICLE ne sont jamais
utilisés comme voies de roulage.
"""
from __future__ import annotations

import ctypes
import heapq
import json
import math
import struct
import time
from pathlib import Path

# SIMCONNECT_RECV_ID : valeurs effectives du protocole MSFS 2020, verifiées
# sur le fil. FACILITY_DATA = 28 (un message par enregistrement),
# FACILITY_DATA_END = 29 (message de fin, taille 16).
RECV_FACILITY_DATA = 28
RECV_FACILITY_DATA_END = 29
# SIMCONNECT_FACILITY_DATA_TYPE.
FACILITY_AIRPORT = 0
FACILITY_TAXI_POINT = 14
FACILITY_TAXI_PARKING = 15
FACILITY_TAXI_PATH = 16
FACILITY_HEADER_SIZE = 40  # SIMCONNECT_RECV_FACILITY_DATA, avant le payload Data.

# Les index des TaxiwayPoint et TaxiwayParking sont uniques dans un aéroport.
# Les champs sont demandés dans le même ordre que les formats de décodage ci-dessous.
_DEFINITION = (
    ("OPEN AIRPORT",),
    ("LATITUDE", "LONGITUDE", "ALTITUDE"),
    ("OPEN TAXI_POINT",),
    ("TYPE", "ORIENTATION", "BIAS_X", "BIAS_Z"),
    ("CLOSE TAXI_POINT",),
    ("OPEN TAXI_PARKING",),
    ("TYPE", "TAXI_POINT_TYPE", "NAME", "SUFFIX", "NUMBER", "ORIENTATION",
     "HEADING", "RADIUS", "BIAS_X", "BIAS_Z"),
    ("CLOSE TAXI_PARKING",),
    ("OPEN TAXI_PATH",),
    ("TYPE", "WIDTH", "RUNWAY_NUMBER", "START", "END"),
    ("CLOSE TAXI_PATH",),
    ("CLOSE AIRPORT",),
)


def _distance_m(a: dict, b: dict) -> float:
    lat1, lon1 = math.radians(float(a["lat"])), math.radians(float(a["lon"]))
    lat2, lon2 = math.radians(float(b["lat"])), math.radians(float(b["lon"]))
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 6371000.0 * 2 * math.asin(min(1.0, math.sqrt(h)))


def _local_xy(point: dict, lat0: float) -> tuple[float, float]:
    return (math.radians(float(point["lon"])) * 6371000.0 * math.cos(math.radians(lat0)),
            math.radians(float(point["lat"])) * 6371000.0)


def _bias_to_position(reference: dict, bias_x: float, bias_z: float) -> dict:
    lat0 = float(reference["lat"])
    lat = lat0 + math.degrees(float(bias_z) / 6371000.0)
    cos_lat = max(1e-8, math.cos(math.radians(lat0)))
    lon = float(reference["lon"]) + math.degrees(float(bias_x) / (6371000.0 * cos_lat))
    return {"lat": lat, "lon": lon}


def _unpack(fmt: str, payload: bytes):
    size = struct.calcsize(fmt)
    if len(payload) < size:
        raise ValueError(f"Données Facility Data incomplètes : {len(payload)} octets, {size} attendus")
    return struct.unpack_from(fmt, payload, 0)


def decode_facility_record(raw: bytes) -> dict | None:
    """Décode un message SIMCONNECT_RECV_FACILITY_DATA brut."""
    if len(raw) < FACILITY_HEADER_SIZE:
        raise ValueError("Message Facility Data trop court")
    size, _version, recv_id = struct.unpack_from("<III", raw, 0)
    if recv_id != RECV_FACILITY_DATA:
        return None
    # En-tête vérifié sur le fil : user_request_id à l'offset 12, index du
    # nœud à l'offset 16 (unique à travers les types), facility_type à 24.
    # Les champs demandés commencent à FACILITY_HEADER_SIZE.
    user_request_id, item_index, parent_id, facility_type = struct.unpack_from("<IIII", raw, 12)
    payload = raw[FACILITY_HEADER_SIZE:min(len(raw), size)]
    result = {"request_id": user_request_id, "item_index": item_index,
              "parent_id": parent_id, "facility_type": facility_type}
    if facility_type == FACILITY_AIRPORT:
        lat, lon, altitude = _unpack("<ddd", payload)
        result["airport"] = {"lat": lat, "lon": lon, "altitude_m": altitude}
    elif facility_type == FACILITY_TAXI_POINT:
        point_type, orientation, bias_x, bias_z = _unpack("<iiff", payload)
        result["taxi_point"] = {"type": point_type, "orientation": orientation,
                                 "bias_x": bias_x, "bias_z": bias_z}
    elif facility_type == FACILITY_TAXI_PARKING:
        values = _unpack("<iiiiiiffff", payload)
        result["parking"] = {"type": values[0], "taxi_point_type": values[1],
                             "name": values[2], "suffix": values[3], "number": values[4],
                             "orientation": values[5], "heading": values[6],
                             "radius": values[7], "bias_x": values[8], "bias_z": values[9]}
    elif facility_type == FACILITY_TAXI_PATH:
        path_type, width, runway_number, start, end = _unpack("<ifiii", payload)
        result["taxi_path"] = {"type": path_type, "width": width,
                                "runway_number": runway_number, "start": start, "end": end}
    else:
        result["ignored"] = True
    return result


class AirportFacilityManager:
    """Un seul chargement d'aérodrome à la fois par connexion SimConnect."""
    def __init__(self, cache_dir: Path):
        self.cache_dir = Path(cache_dir)
        self.definition_id = None
        self.pending: dict[int, dict] = {}
        self.layouts: dict[str, dict] = {}
        self.errors: dict[str, str] = {}
        self._last_sm = None

    @staticmethod
    def _facility_api(sm, public_name: str, export_name: str, argtypes: list):
        """Expose une fonction Facility Data absente du wrapper Python standard.

        Python-SimConnect lie plusieurs exports SimConnect dans SimConnectDll,
        mais pas les deux fonctions Facility Data. La DLL native est déjà chargée
        dans sm.dll.SimConnect : on lie donc directement ses exports officiels.
        """
        wrapped = getattr(sm.dll, public_name, None)
        if wrapped is not None:
            return wrapped
        native = getattr(sm.dll, "SimConnect", None)
        if native is None:
            raise RuntimeError(
                f"Le wrapper SimConnect n'expose pas {public_name} et sa DLL native est inaccessible"
            )
        try:
            function = getattr(native, export_name)
        except AttributeError as exc:
            # Le wrapper Python-SimConnect charge souvent une DLL historique
            # (FSX / ancienne redist). Facility Data est disponible dans les
            # versions SimConnect MSFS 2020 à partir de SU10 (0.19.0).
            # Afficher le chemin exact permet de remplacer la bonne DLL, sans
            # charger une seconde DLL et mélanger des handles SimConnect.
            dll_path = getattr(native, "_name", None) or getattr(native, "_handle", None)
            dll_path = str(dll_path) if dll_path is not None else "chemin non exposé par ctypes"
            raise RuntimeError(
                f"L'export natif {export_name} est absent de la DLL SimConnect chargée "
                f"({dll_path}). Cette DLL doit être mise à jour vers la version "
                "SimConnect du SDK MSFS 2020 SU10 ou ultérieur ; ne pas charger "
                "une deuxième DLL séparément du handle SimConnect existant."
            ) from exc
        # Les vrais exports ctypes acceptent restype/argtypes. Le garde-fou
        # conserve aussi la testabilité avec des fonctions Python simulées.
        try:
            function.restype = ctypes.c_int32  # HRESULT Windows, toujours 32 bits.
            function.argtypes = argtypes
        except AttributeError:
            pass
        return function

    def _ensure_definition(self, sm):
        if self.definition_id is not None:
            return
        add_to_definition = self._facility_api(
            sm, "AddToFacilityDefinition", "SimConnect_AddToFacilityDefinition",
            [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_char_p],
        )
        definition = sm.new_def_id()
        definition_id = int(definition.value)
        for group in _DEFINITION:
            for field in group:
                hr = add_to_definition(sm.hSimConnect, definition_id, field.encode("ascii"))
                if not sm.IsHR(hr, 0):
                    raise RuntimeError(f"AddToFacilityDefinition({field}) refusé (HRESULT {int(hr) & 0xffffffff:#010x})")
        self.definition_id = definition_id

    def request_airport(self, sm, icao: str) -> bool:
        code = str(icao or "").strip().upper()
        if len(code) != 4 or not code.isalnum():
            raise ValueError("Code OACI invalide pour la demande Facility Data")
        if code in self.layouts:
            return True
        # Une réponse Facility Data peut être perdue si MSFS recharge une scène.
        # Ne pas laisser une requête orpheline bloquer tous les aérodromes suivants.
        now = time.time()
        for stale_id, stale in list(self.pending.items()):
            if now - float(stale.get("started_at", now)) > 35.0:
                self.pending.pop(stale_id, None)
                # Erreur temporaire : une nouvelle demande rede possible
                # après 120 s, au lieu de bloquer l'aérodrome jusqu'au
                # redémarrage du pont.
                self.errors[stale["icao"]] = ("Aucune réponse Facility Data reçue dans le délai prévu", now)
        error = self.errors.get(code)
        if error is not None and now - float(error[1]) < 120.0:
            raise RuntimeError(f"Lecture Facility Data précédente échouée pour {code} : {error[0]}")
        self.errors.pop(code, None)
        if any(item["icao"] == code for item in self.pending.values()):
            return False
        if self.pending:
            return False
        self._ensure_definition(sm)
        request_facility_data = self._facility_api(
            sm, "RequestFacilityData", "SimConnect_RequestFacilityData",
            [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_char_p, ctypes.c_char_p],
        )
        request = sm.new_request_id()
        request_id = int(request.value)
        self.pending[request_id] = {"icao": code, "started_at": time.time(),
            "airport": None, "taxi_points": {}, "parkings": {}, "taxi_paths": []}
        self._last_sm = sm
        hr = request_facility_data(sm.hSimConnect, self.definition_id, request_id,
                                   code.encode("ascii"), b"")
        if not sm.IsHR(hr, 0):
            self.pending.pop(request_id, None)
            raise RuntimeError(f"RequestFacilityData({code}) refusé (HRESULT {int(hr) & 0xffffffff:#010x})")
        return False

    def handle_message(self, raw: bytes):
        if len(raw) < 12:
            return False
        _size, _version, recv_id = struct.unpack_from("<III", raw, 0)
        if recv_id == RECV_FACILITY_DATA:
            record = decode_facility_record(raw)
            if not record:
                return True
            state = self.pending.get(record["request_id"])
            if state is None or record.get("ignored"):
                return True
            index = int(record["item_index"])
            if "airport" in record:
                # Le dword "item index" du protocole est un compteur global de
                # session : il continue d'une demande à l'autre. On l'ancastre
                # sur le record AIRPORT (relatif 0) pour obtenir des index
                # locaux ; les références start/end des chemins taxi sont
                # elles-mêmes locales à la demande.
                state["item_base"] = index
                state["airport"] = record["airport"]
            else:
                index -= int(state.get("item_base", 0))
            if "taxi_point" in record:
                # items : aeroport(0), puis points taxi (1..n) -> index local
                # du point taxi = index d'item - 1.
                state["taxi_points"][index - 1] = record["taxi_point"]
            elif "parking" in record:
                # les parkings suivent les points : rang local = index d'item
                # - 1 - nombre de points deja reçus.
                state["parkings"][index - 1 - len(state["taxi_points"])] = record["parking"]
            elif "taxi_path" in record:
                state["taxi_paths"].append(record["taxi_path"])
            return True
        if recv_id == RECV_FACILITY_DATA_END:
            if len(raw) < 16:
                return True
            request_id = struct.unpack_from("<I", raw, 12)[0]
            state = self.pending.pop(request_id, None)
            if state is not None:
                try:
                    layout = build_airport_graph(state["icao"], state["airport"],
                        state["taxi_points"], state["parkings"], state["taxi_paths"])
                    self.layouts[state["icao"]] = layout
                    self.cache_dir.mkdir(parents=True, exist_ok=True)
                    path = self.cache_dir / f"{state['icao']}_layout.json"
                    path.write_text(json.dumps(layout, ensure_ascii=False, indent=2), encoding="utf-8")
                    self.errors.pop(state["icao"], None)
                except Exception as exc:
                    self.errors[state["icao"]] = (str(exc), time.time())
                    raise
            return True
        return False

    def get(self, icao: str) -> dict | None:
        return self.layouts.get(str(icao or "").strip().upper())

    def is_pending(self, icao: str) -> bool:
        code = str(icao or "").strip().upper()
        return any(item["icao"] == code for item in self.pending.values())


def build_airport_graph(icao: str, airport: dict | None, taxi_points: dict,
                        parkings: dict, taxi_paths: list[dict]) -> dict:
    if not airport or not (-90 <= float(airport["lat"]) <= 90 and -180 <= float(airport["lon"]) <= 180):
        raise ValueError(f"MSFS n'a pas renvoyé le point de référence de {icao}")
    # Protocole MSFS verifié : les references start/end des chemins taxi sont
    # des index LOCAUX a la demande. Les points taxi occupent l'espace
    # 0..np_{-1} ; chaque chemin de type PARKING (3) reference un rang de
    # parking (0..np_parking-1), pas un index de point. Dans le graphe fusionné,
    # les nœuds de parking recoivent donc les index np + rang.
    nodes = {}
    for index, item in taxi_points.items():
        pos = _bias_to_position(airport, item["bias_x"], item["bias_z"])
        nodes[int(index)] = {**pos, "index": int(index), "node_kind": "taxi_point",
                             "point_type": int(item["type"]), "orientation": int(item["orientation"])}
    parking_base = len(taxi_points)
    for index, item in parkings.items():
        node_key = parking_base + int(index)
        pos = _bias_to_position(airport, item["bias_x"], item["bias_z"])
        nodes[node_key] = {**pos, "index": node_key, "node_kind": "parking",
                           "point_type": int(item["taxi_point_type"]),
                           "parking_type": int(item["type"]), "parking_number": int(item["number"]),
                           "heading": float(item["heading"]), "radius": float(item["radius"])}
    edges = []
    runway_edges = []
    seen_edges = set()
    for path in taxi_paths:
        path_type = int(path["type"])
        start, end = int(path["start"]), int(path["end"])
        if path_type == 3:
            # Liaison monter au parking : start = index de point taxi,
            # end = rang de parking (espace d'index separe).
            parking_key = parking_base + end
            if start not in nodes or parking_key not in nodes:
                continue
            a, b = int(start), int(parking_key)
        else:
            if start not in nodes or end not in nodes or start == end:
                continue
            a, b = int(start), int(end)
        edge_key = (min(a, b), max(a, b))
        if edge_key in seen_edges:
            continue
        seen_edges.add(edge_key)
        length = _distance_m(nodes[a], nodes[b])
        if not math.isfinite(length) or length < 0.5 or length > 2000:
            continue
        edge = {"start": a, "end": b, "type": path_type,
                "width_m": float(path["width"]), "length_m": length}
        if int(path_type) == 2:
            # RUNWAY : jamais roule automatiquement, sert uniquement de
            # barriere geographique pour eviter les coupures de piste.
            runway_edges.append(edge)
        elif int(path_type) in (1, 3, 4):
            # 1 et 4 = TAXI, 3 = liaison PARKING. Les types RUNWAY, CLOSED,
            # PATH, VEHICLE, ROAD ne deviennent jamais des liens roulables.
            edges.append(edge)
    return {"schema_version": 2, "source": "MSFS_SIMCONNECT_FACILITY_DATA",
            "airport_icao": str(icao).upper(), "airport_reference": airport,
            "nodes": list(nodes.values()), "edges": edges, "runway_edges": runway_edges,
            "counts": {"taxi_points": len(taxi_points), "parkings": len(parkings),
                       "taxi_paths": len(taxi_paths), "usable_edges": len(edges),
                       "runway_barriers": len(runway_edges),
                       "holding_points": sum(1 for n in nodes.values() if n["point_type"] in (2, 4, 5, 6))},
            "loaded_at": time.strftime("%Y-%m-%dT%H:%M:%S")}


def _proper_segment_crossing(a: dict, b: dict, c: dict, d: dict) -> bool:
    """True seulement si deux segments se croisent à l'intérieur (pas à un nœud partagé)."""
    lat0 = (float(a["lat"]) + float(b["lat"]) + float(c["lat"]) + float(d["lat"])) / 4.0
    points = [_local_xy(p, lat0) for p in (a, b, c, d)]
    (ax, ay), (bx, by), (cx, cy), (dx, dy) = points
    def orient(px, py, qx, qy, rx, ry):
        return (qx - px) * (ry - py) - (qy - py) * (rx - px)
    o1 = orient(ax, ay, bx, by, cx, cy)
    o2 = orient(ax, ay, bx, by, dx, dy)
    o3 = orient(cx, cy, dx, dy, ax, ay)
    o4 = orient(cx, cy, dx, dy, bx, by)
    eps = 0.05
    return ((o1 > eps and o2 < -eps) or (o1 < -eps and o2 > eps)) and \
           ((o3 > eps and o4 < -eps) or (o3 < -eps and o4 > eps))


def plan_taxi_route(layout: dict, aircraft_position: dict, max_start_distance_m: float = 45.0) -> dict | None:
    """Plus court chemin depuis le nœud natif le plus proche vers un HOLD_SHORT.

    Seuls les liens TAXI/PARKING sont admis. Aucun lien RUNWAY ou CLOSED n'est
    utilisé. Le raccord avion->nœud reste limité à max_start_distance_m.
    """
    nodes = {int(n["index"]): n for n in layout.get("nodes", [])}
    adjacency: dict[int, list[tuple[int, float]]] = {idx: [] for idx in nodes}
    runway_edges = layout.get("runway_edges", [])
    for edge in layout.get("edges", []):
        a, b = int(edge["start"]), int(edge["end"])
        if a not in nodes or b not in nodes:
            continue
        # Une liaison TAXI qui traverse géométriquement un segment de piste
        # est écartée : aucun roulage automatique ne doit couper une piste.
        crosses_runway = False
        for runway in runway_edges:
            r1, r2 = int(runway["start"]), int(runway["end"])
            if a in (r1, r2) or b in (r1, r2) or r1 not in nodes or r2 not in nodes:
                continue
            if _proper_segment_crossing(nodes[a], nodes[b], nodes[r1], nodes[r2]):
                crosses_runway = True
                break
        if crosses_runway:
            continue
        weight = float(edge.get("length_m") or _distance_m(nodes[a], nodes[b]))
        adjacency[a].append((b, weight))
        adjacency[b].append((a, weight))
    candidates = [( _distance_m(aircraft_position, node), idx)
                  for idx, node in nodes.items() if adjacency.get(idx)]
    if not candidates:
        return None
    start_distance, start = min(candidates, key=lambda item: item[0])
    if start_distance > float(max_start_distance_m):
        return None
    holds = {idx for idx, node in nodes.items() if int(node.get("point_type", 0)) in (2, 4, 5, 6)}
    if not holds:
        return None
    distances = {start: 0.0}
    previous = {}
    heap = [(0.0, start)]
    target = None
    while heap:
        cost, current = heapq.heappop(heap)
        if cost != distances.get(current):
            continue
        if current in holds and current != start:
            target = current
            break
        for neighbor, weight in adjacency.get(current, []):
            new_cost = cost + weight
            if new_cost < distances.get(neighbor, float("inf")):
                distances[neighbor] = new_cost
                previous[neighbor] = current
                heapq.heappush(heap, (new_cost, neighbor))
    if target is None:
        return None
    indices = [target]
    while indices[-1] != start:
        parent = previous.get(indices[-1])
        if parent is None:
            return None
        indices.append(parent)
    indices.reverse()
    route_nodes = [nodes[idx] for idx in indices]
    route_points = [{"lat": float(aircraft_position["lat"]), "lon": float(aircraft_position["lon"]),
                     "point_type": "taxiway", "node_index": None}]
    for node in route_nodes:
        point = {"lat": float(node["lat"]), "lon": float(node["lon"]),
                 "point_type": "holding" if int(node.get("point_type", 0)) in (2, 4, 5, 6) else "taxiway",
                 "node_index": int(node["index"])}
        if _distance_m(route_points[-1], point) > 1.5:
            route_points.append(point)
    if len(route_points) < 2 or route_points[-1]["point_type"] != "holding":
        return None
    return {"route_id": f"MSFS-{layout.get('airport_icao', 'XXXX')}-{start}-{target}",
            "distance_m": round(start_distance, 1), "taxi_distance_m": round(distances[target], 1),
            "taxi_points": route_points, "source": "MSFS_SIMCONNECT_FACILITY_DATA"}
