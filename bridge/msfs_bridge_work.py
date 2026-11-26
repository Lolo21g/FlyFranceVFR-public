"""
FlyFranceVFR — Pont MSFS 2020
Lance HTTP + WebSocket, connecte SimConnect, détecte le landing rate.
"""

import asyncio
import ctypes
import json
import logging
import shutil
import secrets
import subprocess
import math
import os
import queue
import re
import socket
import sys
import threading
import time
import traceback
from io import BytesIO
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from SimConnect import SimConnect, AircraftRequests, Request
from SimConnect.Enum import SIMCONNECT_DATATYPE, SIMCONNECT_SIMOBJECT_TYPE, SIMCONNECT_UNUSED, SIMCONNECT_RECV_ID, SIMCONNECT_EXCEPTION, SIMCONNECT_PERIOD, SIMCONNECT_DATA_INITPOSITION

try:
    import pystray
    from PIL import Image, ImageDraw
    HAS_TRAY = True
except ImportError:
    HAS_TRAY = False

import websockets

log = logging.getLogger("msfs_bridge")

# Les modules Traffic IA sont des fichiers externes, placés à côté du Bridge.
# En mode PyInstaller, le répertoire courant peut être différent du dossier EXE :
# il faut donc ajouter explicitement la racine de l'application au chemin Python.
_APP_ROOT = (Path(sys.executable).resolve().parent if getattr(sys, "frozen", False)
             else Path(__file__).resolve().parent)
_APP_ROOT_STR = str(_APP_ROOT)
if _APP_ROOT_STR not in sys.path:
    sys.path.insert(0, _APP_ROOT_STR)
_TRAFFIC_AI_DIR = _APP_ROOT / "traffic_AI"

# Déploiement automatique des livrées des avions IA dans MSFS.
# La source (dossier "liveries") est installée par le logiciel FlyFranceVFR ;
# le Bridge la copie dans le dossier Community de MSFS à chaque démarrage
# (MSFS ne peut charger des avions que depuis son propre dossier Packages).
PILOT_LIVERIES_PACKAGE_NAME = "flyfrancevfr-pilot-liveries"


def _msfs_packages_path():
    base_roaming = os.environ.get("APPDATA", str(Path.home() / "AppData" / "Roaming"))
    cfg = Path(base_roaming) / "Microsoft Flight Simulator" / "UserCfg.opt"
    fallback = cfg.parent / "Packages"
    try:
        if cfg.is_file():
            text = cfg.read_text(encoding="utf-8", errors="replace")
            match = re.search(r'InstalledPackagesPath\s+"([^"]+)"', text)
            if match:
                p = Path(os.path.expandvars(match.group(1)))
                if p.is_dir():
                    return p
    except Exception:
        pass
    return fallback


def deploy_pilot_liveries():
    """Copie les livrées IA (situées à côté du Bridge, dossier liveries)
    dans <Packages MSFS>\Community\flyfrancevfr-pilot-liveries."""
    candidates = [
        _APP_ROOT.parent / "liveries" / PILOT_LIVERIES_PACKAGE_NAME,
        _APP_ROOT / "liveries" / PILOT_LIVERIES_PACKAGE_NAME,
    ]
    source = next((c for c in candidates if c.is_dir()), None)
    if source is None:
        log.info("Livrées IA non déployées : dossier source absent (%s)", candidates[0])
        return False
    community = _msfs_packages_path() / "Community" / PILOT_LIVERIES_PACKAGE_NAME
    if not community.parent.is_dir():
        community.parent.mkdir(parents=True, exist_ok=True)
    try:
        if community.is_dir():
            count_src = sum(1 for _ in source.rglob("*") if _.is_file())
            count_dst = sum(1 for _ in community.rglob("*") if _.is_file())
            if count_dst >= count_src:
                log.info("Livrées IA déjà déployées dans %s (%d fichiers)", community, count_dst)
                return True
            shutil.rmtree(community, ignore_errors=True)
        shutil.copytree(source, community)
        count = sum(1 for _ in community.rglob("*") if _.is_file())
        log.info("Livrées IA déploées : %s (%d fichiers)", community, count)
        return True
    except Exception:
        log.exception("Échec du déploiement des livrées IA vers %s", community)
        return False


from radio_recognizer import RadioRecognizer
from traffic_AI.ground_route_monitor import runway_axis_deviation, classify_ground_state
from traffic_AI.ai_waypoint_controller import RoutePoint, send_ground_route, send_airborne_route, release_atc_control
from traffic_AI.msfs_airport_facilities import AirportFacilityManager, plan_taxi_route
from traffic_AI.ai_radio import AIRadioCircuitTracker

_FLIGHT_MANAGER_LOAD_ERROR = None
try:
    if not (_TRAFFIC_AI_DIR / "__init__.py").is_file():
        raise FileNotFoundError(f"Fichier absent : {_TRAFFIC_AI_DIR / '__init__.py'}")
    if not (_TRAFFIC_AI_DIR / "ai_flight_manager.py").is_file():
        raise FileNotFoundError(f"Fichier absent : {_TRAFFIC_AI_DIR / 'ai_flight_manager.py'}")
    from traffic_AI.ai_flight_manager import (
        Airport, build_vfr_flightplan, build_local_circuit_flightplan,
        reached_airport, select_first_parked_aircraft,
        circuit_route_points, transit_route_points,
    )
    log.info("Gestionnaire de circuit IA chargé depuis %s", _TRAFFIC_AI_DIR)
except Exception as _flight_manager_error:
    Airport = None
    build_vfr_flightplan = None
    build_local_circuit_flightplan = None
    circuit_route_points = None
    transit_route_points = None
    reached_airport = None
    select_first_parked_aircraft = None
    _FLIGHT_MANAGER_LOAD_ERROR = f"{type(_flight_manager_error).__name__}: {_flight_manager_error}"
    log.exception("Gestionnaire de circuit IA indisponible (dossier attendu : %s)", _TRAFFIC_AI_DIR)

# Moteur métier Traffic IA (module facultatif pendant les mises à jour)
try:
    from traffic_AI.traffic_ia_engine import TrafficIAEngine
    _traffic_engine = TrafficIAEngine(_TRAFFIC_AI_DIR / "traffic_ia_config.json")
    log.info("Moteur Traffic IA chargé (flotte=%s)", len(_traffic_engine.fleet_manifest()))
except Exception as _traffic_engine_error:
    TrafficIAEngine = None
    _traffic_engine = None
    log.exception("Moteur Traffic IA indisponible : %s", _traffic_engine_error)

from update_openaip_data import run_update as _run_openaip_update_impl

OPENAIP_API_KEY = "b118f0206ba79835393625fe7ae0bae5"  # meme cle que le frontend (flyfrancevfr.html)

HOST       = "0.0.0.0"
LOCAL_HOST = "localhost"
WS_PORT    = 8765
HTTP_PORT  = 8080
APP_URL    = f"http://{LOCAL_HOST}:{HTTP_PORT}/flyfrancevfr.html"
NO_BROWSER = os.environ.get("FLYFRANCEVFR_NO_BROWSER", "").strip().lower() in {"1", "true", "yes", "on"}

log = logging.getLogger("msfs_bridge")

def _make_log_handlers():
    handlers = [logging.StreamHandler(sys.stdout)]
    try:
        base = Path(sys.executable).parent if getattr(sys, 'frozen', False) else Path(__file__).parent
        handlers.append(logging.FileHandler(base / "bridge.log", encoding="utf-8"))
    except Exception:
        pass
    return handlers

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s",
                    handlers=_make_log_handlers())

connected_clients = set()
_status = {"sim": False, "alt": 0, "spd": 0, "hdg": 0}
_loop   = None
_tray_icon = None
_latest_data = {}
_data_lock = threading.Lock()
_sim_command_lock = threading.Lock()
_single_instance_mutex = None
_shutdown_requested = False
_fuel_command = None
_payload_command = None
_registration_command = None
_registration_verify_target = None
_registration_verify_deadline = 0
_last_fuel_result = {"ok": None, "message": "Aucune synchronisation carburant", "updatedAt": None}
_last_payload_result = {"ok": None, "message": "Aucune synchronisation charge", "updatedAt": None}
_last_registration_result = {"ok": None, "message": "Aucune synchronisation immatriculation", "updatedAt": None}
_update_lock = threading.Lock()
_update_status = {"running": False, "ok": None, "message": "Jamais lancee", "updatedAt": None, "output": ""}

# Trafic IA : commandes envoyees au thread SimConnect deja existant.
# Les valeurs DR400/C172/DA40NG sont des titres candidats modifiables si le package MSFS
# utilise un titre SimObject different.
AI_AIRCRAFT_TITLES = {"DR400": "DR400", "C172": "C172", "DA40NG": "DA40NG"}
AI_MAX_PARKED_AIRCRAFT = 3  # limite d'avions IA posés à l'aérodrome (modifiable via traffic_ia_config.json : max_parked_aircraft)
AI_MAX_PATROL_AIRCRAFT = 3  # limite d'avions IA en patrouille en vol (modifiable via traffic_ia_config.json : max_patrol_aircraft)
AI_CIRCUIT_LAPS = 3  # nombre de tours de piste de la mission « circuit » (au moins 3)
AI_LAUNCH_STAGGER_SECONDS = 180.0  # délai entre deux départs d'avions IA du même aérodrome (modifiable via traffic_ia_config.json : launch_stagger_seconds)
_ai_last_departure_at = {}  # OACI -> heure du dernier départ autorisé
AI_CREATE_SPACING_SECONDS = 8.0  # laisse MSFS reserver/charger le parking avant la demande suivante
_ai_last_create_started = 0.0

# Patrouille en vol : avions IA créés directement en l'air (AICreateNonATCAircraft)
# qui tournent en circuit fermé autour d'une zone. Le pilote « waypoints » de MSFS
# ne sait pas rouler au sol : ce mode ne doit JAMAIS être combiné à un avion posé.
AI_WAYPOINT_SPEED_REQUESTED = 0x04
AI_WAYPOINT_THROTTLE_REQUESTED = 0x08
AI_WAYPOINT_COMPUTE_VERTICAL_SPEED = 0x10
AI_WAYPOINT_WRAP_TO_FIRST = 0x00400000
AI_PATROL_DEFAULTS = {"altitude_ft": 1000.0, "radius_nm": 3.0, "speed_kts": 105.0,
                      "points": 12, "direction": "right"}


class AI_WaypointMsfs(ctypes.Structure):
    """SIMCONNECT_DATA_WAYPOINT (SDK MSFS) : lat, lon, alt, flags, ktsSpeed, percentThrottle."""
    # SimConnect.h applique un empaquetage sur 1 octet : la structure SDK fait
    # 44 octets. Sans ce réglage ctypes insère 4 octets de remplissage après
    # Flags et transmet une structure de 48 octets, que MSFS ne pilote pas
    # correctement.
    _pack_ = 1
    _fields_ = [
        ("Latitude", ctypes.c_double),
        ("Longitude", ctypes.c_double),
        ("Altitude", ctypes.c_double),
        ("Flags", ctypes.c_uint32),
        ("ktsSpeed", ctypes.c_double),
        ("percentThrottle", ctypes.c_double),
    ]
_ai_aircraft_title_cache = {}
_ai_command_queue = queue.Queue()
_ai_pending_lock = threading.Lock()
_ai_pending_requests = {}
_ai_exception_backlog = {}
_ai_object_ids = set()
_ai_object_records = {}  # object_id -> metadonnees des avions crees par FlyFranceVFR
_ai_remove_queue = queue.Queue()
_ai_used_tail_numbers = set()  # evite les doublons pendant la session
_ai_atcid_retry_pending = {}  # object_id -> {"reg", "due", "attempts", "max_attempts"} : ecritures ATC ID différées
_ai_patrol_waypoints_pending = {}  # object_id -> {"waypoints", "due", "attempts"} : envoi du circuit fermé différé
_ai_patrol_probe_schedule = []  # sondes télémétrie post-envoi : {"object_id", "tail", "delay_s", "due"}
_ai_atcid_probes = {}  # request_id -> {"object_id", "reg"} : lecture diagnostic ATC ID/TITLE sur l'objet IA
_ai_atcid_probe_schedule = []  # [{"object_id", "reg", "due"}] lectures différées à programmer
_ai_flightplan_queue = queue.Queue()
_ai_flightplan_pending = {}  # send_id -> suivi des erreurs différées SimConnect
_ai_flight_monitor_last = 0.0
_airport_facility_manager = None  # données aérodrome natives SimConnect, une instance par connexion
# Reconnaissance vocale radio hors-ligne (Vosk), indépendante du navigateur
VOSK_MODEL_DIR_NAME = "vosk-model-small-fr-0.22"
_radio_recognizer = None
_radio_recognizer_lock = threading.Lock()

# Détection landing rate
_prev_on_ground = False
_vs_buffer = []  # dernières valeurs VS avant toucher


def _setup_traffic_reader(sm):
    definitions = (
        (b"PLANE LATITUDE", b"degrees"),
        (b"PLANE LONGITUDE", b"degrees"),
        (b"PLANE ALTITUDE", b"feet"),
        (b"SIM ON GROUND", b"Bool"),
        (b"GROUND VELOCITY", b"knots"),
        (b"PLANE HEADING DEGREES TRUE", b"degrees"),
    )
    definition_id = sm.new_def_id()
    request_id = sm.new_request_id()
    for name, unit in definitions:
        hr = sm.dll.AddToDataDefinition(
            sm.hSimConnect,
            definition_id.value,
            name,
            unit,
            SIMCONNECT_DATATYPE.SIMCONNECT_DATATYPE_FLOAT64,
            0,
            SIMCONNECT_UNUSED,
        )
        if not sm.IsHR(hr, 0):
            raise RuntimeError(f"Definition trafic SimConnect refusee: {name!r}")

    # TITLE permet de récupérer la variante exacte de l'avion observé.
    # Sur MSFS 2020, les variantes de peinture sont généralement portées par
    # des titres aircraft.cfg distincts. Sur les SimObjects modulaires de 2024,
    # la livrée peut être séparée du titre (LIVERY NAME).
    title_offset = len(definitions) * ctypes.sizeof(ctypes.c_double)
    title_datatype = getattr(SIMCONNECT_DATATYPE, "SIMCONNECT_DATATYPE_STRING256", None)
    title_enabled = False
    if title_datatype is not None:
        try:
            hr = sm.dll.AddToDataDefinition(
                sm.hSimConnect,
                definition_id.value,
                b"TITLE",
                None,  # SimConnect exige NULL comme unité pour les données texte
                title_datatype,
                0,
                SIMCONNECT_UNUSED,
            )
            title_enabled = bool(sm.IsHR(hr, 0))
            if not title_enabled:
                log.warning("SimConnect ne permet pas la lecture TITLE du trafic ; livrée automatique indisponible")
        except Exception as exc:
            log.warning("Lecture TITLE du trafic indisponible : %s", exc)
    else:
        log.warning("Type STRING256 absent du wrapper SimConnect ; lecture TITLE ignorée")

    state = {"lock": threading.Lock(), "pending": {}, "snapshot": [], "last_request": 0.0}
    original_handler = sm.handle_simobject_event

    def traffic_handler(obj_data):
        if obj_data.dwRequestID != request_id.value:
            original_handler(obj_data)
            return
        values = ctypes.cast(
            obj_data.dwData,
            ctypes.POINTER(ctypes.c_double * len(definitions)),
        ).contents
        item = {
            "id": int(obj_data.dwObjectID),
            "lat": float(values[0]),
            "lon": float(values[1]),
            "altitude": float(values[2]),
            "on_ground": bool(round(values[3])),
            "ground_speed": float(values[4]),
            "heading": float(values[5]) % 360,
        }
        if title_enabled:
            try:
                data_address = ctypes.cast(obj_data.dwData, ctypes.c_void_p).value
                if not data_address:
                    raise ValueError("pointeur de données SimConnect nul")
                raw_title = ctypes.string_at(data_address + title_offset, 256)
                item["title"] = raw_title.split(b"\0", 1)[0].decode("utf-8", errors="replace").strip()
            except Exception as exc:
                log.debug("Lecture du titre d'un avion IA impossible : %s", exc)
        with state["lock"]:
            if int(obj_data.dwentrynumber) == 0:
                state["pending"] = {}
            state["pending"][item["id"]] = item
            if int(obj_data.dwentrynumber) + 1 >= max(1, int(obj_data.dwoutof)):
                state["snapshot"] = list(state["pending"].values())

    sm.handle_simobject_event = traffic_handler

    def read_snapshot(radius_m=12000):
        now = time.time()
        if now - state["last_request"] >= 2.0:
            state["last_request"] = now
            sm.dll.RequestDataOnSimObjectType(
                sm.hSimConnect,
                request_id.value,
                definition_id.value,
                int(radius_m),
                SIMCONNECT_SIMOBJECT_TYPE.SIMCONNECT_SIMOBJECT_TYPE_AIRCRAFT,
            )
        with state["lock"]:
            return [dict(item) for item in state["snapshot"]]

    return read_snapshot


# ── HTTP ──────────────────────────────────────────────────────────────────────

def get_base_dir():
    if getattr(sys, 'frozen', False):
        return Path(sys.executable).parent
    return Path(__file__).parent

def _send_json(handler, code, payload):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(code)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


CHECKLIST_MAX_BYTES = 30 * 1024 * 1024


def get_checklist_dir():
    """Dossier des checklists PDF : <dossier de l'app>\\aircraft\\checklist (comme les fichiers des zones)"""
    return get_base_dir() / "aircraft" / "checklist"


def _checklist_file(name):
    """Chemin d'un PDF du dossier des checklists : simple nom de fichier .pdf, jamais un chemin"""
    name = os.path.basename(str(name or "").replace("\\", "/"))
    if not name.lower().endswith(".pdf") or name.startswith(".") or len(name) > 120:
        raise ValueError("nom de fichier invalide")
    return get_checklist_dir() / name


def _gf_mul(a, b):
    p = 0
    while b:
        if b & 1:
            p ^= a
        a <<= 1
        if a & 0x100:
            a ^= 0x11D
        b >>= 1
    return p & 0xFF


def _rs_generator(degree):
    gen = [1]
    x = 1
    for _ in range(degree):
        gen = [_gf_mul(c, x) ^ (gen[i + 1] if i + 1 < len(gen) else 0) for i, c in enumerate(gen + [0])]
        x = _gf_mul(x, 2)
    return gen


def _rs_remainder(data, degree):
    gen = _rs_generator(degree)
    rem = [0] * degree
    for b in data:
        factor = b ^ rem.pop(0)
        rem.append(0)
        for i in range(degree):
            rem[i] ^= _gf_mul(gen[i + 1], factor)
    return rem


def _append_bits(bits, value, length):
    for i in range(length - 1, -1, -1):
        bits.append((value >> i) & 1)


def _qr_code_png(text, scale=8, border=4):
    try:
        import qrcode
        qr = qrcode.QRCode(
            version=None,
            error_correction=qrcode.constants.ERROR_CORRECT_M,
            box_size=10,
            border=4,
        )
        qr.add_data(text)
        qr.make(fit=True)
        img = qr.make_image(fill_color="black", back_color="white").convert("RGB")
        out = BytesIO()
        img.save(out, format="PNG")
        return out.getvalue()
    except Exception:
        pass

    from PIL import Image, ImageDraw

    version = 4
    size = version * 4 + 17
    data_codewords = 80
    ec_codewords = 20
    raw = text.encode("utf-8")
    if len(raw) > 78:
        raise ValueError("adresse trop longue pour le QR code")

    bits = []
    _append_bits(bits, 0b0100, 4)
    _append_bits(bits, len(raw), 8)
    for b in raw:
        _append_bits(bits, b, 8)
    _append_bits(bits, 0, min(4, data_codewords * 8 - len(bits)))
    while len(bits) % 8:
        bits.append(0)
    pads = [0xEC, 0x11]
    data = []
    for i in range(0, len(bits), 8):
        v = 0
        for bit in bits[i:i + 8]:
            v = (v << 1) | bit
        data.append(v)
    while len(data) < data_codewords:
        data.append(pads[len(data) % 2])
    codewords = data + _rs_remainder(data, ec_codewords)

    modules = [[None] * size for _ in range(size)]
    function = [[False] * size for _ in range(size)]

    def set_mod(x, y, dark, is_function=True):
        if 0 <= x < size and 0 <= y < size:
            modules[y][x] = bool(dark)
            if is_function:
                function[y][x] = True

    def finder(x, y):
        for dy in range(-1, 8):
            for dx in range(-1, 8):
                xx, yy = x + dx, y + dy
                if 0 <= xx < size and 0 <= yy < size:
                    dark = 0 <= dx <= 6 and 0 <= dy <= 6 and (dx in (0, 6) or dy in (0, 6) or (2 <= dx <= 4 and 2 <= dy <= 4))
                    set_mod(xx, yy, dark)

    finder(0, 0)
    finder(size - 7, 0)
    finder(0, size - 7)
    for i in range(8, size - 8):
        set_mod(i, 6, i % 2 == 0)
        set_mod(6, i, i % 2 == 0)

    def alignment(cx, cy):
        for dy in range(-2, 3):
            for dx in range(-2, 3):
                set_mod(cx + dx, cy + dy, max(abs(dx), abs(dy)) != 1)

    alignment(26, 26)
    set_mod(8, 4 * version + 9, True)
    for i in range(9):
        if i != 6:
            function[8][i] = function[i][8] = True
            function[8][size - 1 - i] = function[size - 1 - i][8] = True

    stream = []
    for cw in codewords:
        for i in range(7, -1, -1):
            stream.append((cw >> i) & 1)

    idx = 0
    upward = True
    x = size - 1
    while x > 0:
        if x == 6:
            x -= 1
        rows = range(size - 1, -1, -1) if upward else range(size)
        for y in rows:
            for xx in (x, x - 1):
                if not function[y][xx]:
                    modules[y][xx] = bool(stream[idx]) if idx < len(stream) else False
                    idx += 1
        upward = not upward
        x -= 2

    def mask_bit(mask, x, y):
        return (
            (x + y) % 2 == 0 if mask == 0 else
            y % 2 == 0 if mask == 1 else
            x % 3 == 0 if mask == 2 else
            (x + y) % 3 == 0 if mask == 3 else
            ((y // 2) + (x // 3)) % 2 == 0 if mask == 4 else
            (x * y) % 2 + (x * y) % 3 == 0 if mask == 5 else
            ((x * y) % 2 + (x * y) % 3) % 2 == 0 if mask == 6 else
            ((x + y) % 2 + (x * y) % 3) % 2 == 0
        )

    def format_bits(mask):
        data5 = (1 << 3) | mask  # correction L
        v = data5 << 10
        for i in range(14, 9, -1):
            if (v >> i) & 1:
                v ^= 0x537 << (i - 10)
        return ((data5 << 10) | v) ^ 0x5412

    def with_format(base, mask):
        m = [row[:] for row in base]
        fmt = format_bits(mask)
        a = [(0, 8), (1, 8), (2, 8), (3, 8), (4, 8), (5, 8), (7, 8), (8, 8), (8, 7), (8, 5), (8, 4), (8, 3), (8, 2), (8, 1), (8, 0)]
        b = [(8, size - 1), (8, size - 2), (8, size - 3), (8, size - 4), (8, size - 5), (8, size - 6), (8, size - 7), (8, size - 8), (size - 8, 8), (size - 7, 8), (size - 6, 8), (size - 5, 8), (size - 4, 8), (size - 3, 8), (size - 2, 8)]
        for i in range(15):
            bit = ((fmt >> i) & 1) == 1
            x1, y1 = a[i]
            x2, y2 = b[i]
            m[y1][x1] = bit
            m[y2][x2] = bit
        return m

    def penalty(m):
        score = 0
        for y in range(size):
            run_color = m[y][0]
            run_len = 1
            for x in range(1, size):
                if m[y][x] == run_color:
                    run_len += 1
                else:
                    if run_len >= 5:
                        score += 3 + run_len - 5
                    run_color, run_len = m[y][x], 1
            if run_len >= 5:
                score += 3 + run_len - 5
        for x in range(size):
            run_color = m[0][x]
            run_len = 1
            for y in range(1, size):
                if m[y][x] == run_color:
                    run_len += 1
                else:
                    if run_len >= 5:
                        score += 3 + run_len - 5
                    run_color, run_len = m[y][x], 1
            if run_len >= 5:
                score += 3 + run_len - 5
        for y in range(size - 1):
            for x in range(size - 1):
                if m[y][x] == m[y][x + 1] == m[y + 1][x] == m[y + 1][x + 1]:
                    score += 3
        dark = sum(1 for row in m for v in row if v)
        score += abs(dark * 20 - size * size * 10) // (size * size) * 10
        return score

    best = None
    best_score = None
    for mask in range(8):
        m = [row[:] for row in modules]
        for y in range(size):
            for x in range(size):
                if not function[y][x] and mask_bit(mask, x, y):
                    m[y][x] = not m[y][x]
        m = with_format(m, mask)
        score = penalty(m)
        if best_score is None or score < best_score:
            best, best_score = m, score

    pixels = (size + border * 2) * scale
    img = Image.new("RGB", (pixels, pixels), "white")
    draw = ImageDraw.Draw(img)
    for y in range(size):
        for x in range(size):
            if best[y][x]:
                x0 = (x + border) * scale
                y0 = (y + border) * scale
                draw.rectangle([x0, y0, x0 + scale - 1, y0 + scale - 1], fill="black")
    out = BytesIO()
    img.save(out, format="PNG")
    return out.getvalue()


def _send_png(handler, data):
    handler.send_response(200)
    handler.send_header("Content-Type", "image/png")
    handler.send_header("Content-Length", str(len(data)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(data)


def _shutdown_process():
    global _shutdown_requested
    if _shutdown_requested:
        return
    _shutdown_requested = True
    log.info("Arret demande depuis l'interface web")

    def _do_shutdown():
        try:
            if _tray_icon:
                _tray_icon.stop()
        except Exception:
            pass
        try:
            if _loop:
                _loop.call_soon_threadsafe(_loop.stop)
        except Exception:
            pass
        time.sleep(0.4)
        os._exit(0)

    threading.Thread(target=_do_shutdown, daemon=True).start()


def _run_openaip_update():
    with _update_lock:
        _update_status.update({"running": True, "ok": None, "message": "Mise a jour OpenAIP en cours...", "output": "", "updatedAt": time.strftime("%Y-%m-%d %H:%M:%S")})
    log_lines = []
    def _log(line):
        log_lines.append(str(line))
        log.info(str(line))
    try:
        summary = _run_openaip_update_impl(get_base_dir(), OPENAIP_API_KEY, log=_log)
        output = "\n".join(log_lines)
        with _update_lock:
            _update_status.update({"running": False, "ok": True, "message": summary or "Mise a jour OpenAIP terminee", "output": output[-3000:], "updatedAt": time.strftime("%Y-%m-%d %H:%M:%S")})
        log.info("Mise a jour OpenAIP terminee")
    except Exception as e:
        output = ("\n".join(log_lines) + "\n" + str(e)).strip()
        with _update_lock:
            _update_status.update({"running": False, "ok": False, "message": str(e), "output": output[-3000:], "updatedAt": time.strftime("%Y-%m-%d %H:%M:%S")})
        log.warning(f"Mise a jour OpenAIP echouee : {e}")


def _local_ipv4_addresses():
    ips = []
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            ip = info[4][0]
            if ip and not ip.startswith("127.") and ip not in ips:
                ips.append(ip)
    except Exception:
        pass
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        if ip and not ip.startswith("127.") and ip not in ips:
            ips.insert(0, ip)
    except Exception:
        pass
    return ips


def _queue_fuel_sync(percent):
    global _fuel_command
    percent = max(0.0, min(100.0, float(percent)))
    with _sim_command_lock:
        _fuel_command = {"percent": percent, "ts": time.time()}
        _last_fuel_result.update({"ok": None, "message": f"Synchronisation carburant demandee: {percent:.0f}%", "updatedAt": time.strftime("%Y-%m-%d %H:%M:%S")})
    return percent


def _take_fuel_command():
    global _fuel_command
    with _sim_command_lock:
        cmd = _fuel_command
        _fuel_command = None
    return cmd


def _set_fuel_result(ok, message):
    with _sim_command_lock:
        _last_fuel_result.update({"ok": bool(ok), "message": message, "updatedAt": time.strftime("%Y-%m-%d %H:%M:%S")})


def _fuel_result():
    with _sim_command_lock:
        return dict(_last_fuel_result)


def _queue_payload_sync(weights_kg):
    global _payload_command
    weights = [max(0.0, float(w)) for w in weights_kg if float(w) >= 0]
    with _sim_command_lock:
        _payload_command = {"weights_kg": weights, "ts": time.time()}
        _last_payload_result.update({"ok": None, "message": f"Synchronisation charge demandee: {sum(weights):.0f} kg", "updatedAt": time.strftime("%Y-%m-%d %H:%M:%S")})
    return weights


def _take_payload_command():
    global _payload_command
    with _sim_command_lock:
        cmd = _payload_command
        _payload_command = None
    return cmd


def _set_payload_result(ok, message):
    with _sim_command_lock:
        _last_payload_result.update({"ok": bool(ok), "message": message, "updatedAt": time.strftime("%Y-%m-%d %H:%M:%S")})


def _payload_result():
    with _sim_command_lock:
        return dict(_last_payload_result)


def _normalize_registration(value):
    raw = "".join(ch for ch in str(value or "").upper() if ch.isalnum())
    if len(raw) == 5 and raw.startswith("F"):
        return f"{raw[0]}-{raw[1:]}"
    raise ValueError("format attendu F-XXXX")


def _queue_registration_sync(registration):
    global _registration_command
    reg = _normalize_registration(registration)
    with _sim_command_lock:
        _registration_command = {"registration": reg, "ts": time.time()}
        _last_registration_result.update({"ok": None, "message": f"Synchronisation immatriculation demandee: {reg}", "updatedAt": time.strftime("%Y-%m-%d %H:%M:%S")})
    return reg


def _take_registration_command():
    global _registration_command
    with _sim_command_lock:
        cmd = _registration_command
        _registration_command = None
    return cmd


def _set_registration_result(ok, message):
    with _sim_command_lock:
        _last_registration_result.update({"ok": bool(ok), "message": message, "updatedAt": time.strftime("%Y-%m-%d %H:%M:%S")})


def _registration_result():
    with _sim_command_lock:
        return dict(_last_registration_result)


def _apply_fuel_percent(aq, percent):
    ratio = max(0.0, min(1.0, float(percent) / 100.0))
    tanks = [
        ("FUEL_TANK_CENTER_CAPACITY", "FUEL_TANK_CENTER_LEVEL"),
        ("FUEL_TANK_CENTER2_CAPACITY", "FUEL_TANK_CENTER2_LEVEL"),
        ("FUEL_TANK_CENTER3_CAPACITY", "FUEL_TANK_CENTER3_LEVEL"),
        ("FUEL_TANK_LEFT_MAIN_CAPACITY", "FUEL_TANK_LEFT_MAIN_LEVEL"),
        ("FUEL_TANK_RIGHT_MAIN_CAPACITY", "FUEL_TANK_RIGHT_MAIN_LEVEL"),
        ("FUEL_TANK_LEFT_AUX_CAPACITY", "FUEL_TANK_LEFT_AUX_LEVEL"),
        ("FUEL_TANK_RIGHT_AUX_CAPACITY", "FUEL_TANK_RIGHT_AUX_LEVEL"),
        ("FUEL_TANK_LEFT_TIP_CAPACITY", "FUEL_TANK_LEFT_TIP_LEVEL"),
        ("FUEL_TANK_RIGHT_TIP_CAPACITY", "FUEL_TANK_RIGHT_TIP_LEVEL"),
        ("FUEL_TANK_EXTERNAL1_CAPACITY", "FUEL_TANK_EXTERNAL1_LEVEL"),
        ("FUEL_TANK_EXTERNAL2_CAPACITY", "FUEL_TANK_EXTERNAL2_LEVEL"),
    ]
    applied = []
    for cap_key, level_key in tanks:
        try:
            cap = aq.get(cap_key)
            if cap is not None and float(cap) > 0.01:
                aq.set(level_key, ratio)
                applied.append(level_key)
        except Exception as e:
            log.debug(f"Reservoir ignore {level_key}: {e}")
    if not applied:
        for level_key in ("FUEL_TANK_LEFT_MAIN_LEVEL", "FUEL_TANK_RIGHT_MAIN_LEVEL", "FUEL_TANK_CENTER_LEVEL"):
            try:
                aq.set(level_key, ratio)
                applied.append(level_key)
            except Exception as e:
                log.debug(f"Reservoir fallback ignore {level_key}: {e}")
    if not applied:
        raise RuntimeError("Aucun reservoir MSFS modifiable trouve")
    return applied


# Mots (FR/EN/DE/ES/IT) designant une station de bagages, de fret ou de carburant
_BAGGAGE_WORDS = ("bagg", "bagag", "cargo", "carga", "chargement", "nacelle", "pod", "luggage", "trunk", "fret", "soute", "hold", "compart", "storage", "gepaeck", "gep\u00e4ck", "fracht", "laderaum", "equipaje", "bagaglio", "stiva", "fuel", "carb")

_ac_info_cache = {"title": None, "info": {}, "ts": 0.0}


def _aq_num(aq, name):
    try:
        v = aq.get(name)
        if v is None:
            return None
        f = float(v)
        return f if math.isfinite(f) else None
    except Exception:
        return None


def _aq_str(aq, name):
    try:
        v = aq.get(name)
        if isinstance(v, bytes):
            v = v.decode("utf-8", "ignore")
        v = str(v or "").strip()
        return v or None
    except Exception:
        return None


def _read_station_names(aq, count):
    """Noms des stations de charge. La lib n'expose pas PAYLOAD_STATION_NAME en indexe
    (aq.get("PAYLOAD_STATION_NAME:1") renvoie toujours None) : on utilise une requete dediee."""
    names = []
    try:
        from SimConnect.RequestList import Request
        req = Request((b"PAYLOAD STATION NAME:index", b"String"), aq.sm, _time=10,
                      _dec="Nom de la station de charge", _settable=False, _attemps=20)
    except Exception:
        return [""] * count
    for i in range(1, count + 1):
        try:
            req.outData = None  # evite de relire le nom de la station precedente
            req.setIndex(i)
            v = req.outData if req.outData is not None else req.value
            if isinstance(v, bytes):
                v = v.decode("utf-8", "ignore")
            names.append(str(v or "").strip())
        except Exception:
            names.append("")
    return names


def _read_aircraft_info(aq):
    """Caracteristiques de l'avion charge (lues une fois par titre). Tout est optionnel."""
    info = {}
    info["atc_model"] = _aq_str(aq, "ATC_MODEL")
    n = _aq_num(aq, "NUMBER_OF_ENGINES")
    info["engines"] = int(n) if n else None
    info["engine_type"] = _aq_num(aq, "ENGINE_TYPE")  # 0 piston, 1 jet, 5 turbopropulseur
    info["empty_lb"] = _aq_num(aq, "EMPTY_WEIGHT")
    info["max_lb"] = _aq_num(aq, "MAX_GROSS_WEIGHT")
    cap = _aq_num(aq, "FUEL_TOTAL_CAPACITY")
    info["fuel_cap_gal"] = cap if cap and cap > 0 else None
    # Vitesse de croisiere de conception : supposee en pieds/seconde (a verifier selon l'avion)
    fps = _aq_num(aq, "DESIGN_SPEED_VC")
    info["cruise_raw"] = fps  # valeur brute, pour verifier l'unite
    info["vs0_raw"] = _aq_num(aq, "DESIGN_SPEED_VS0")
    info["vs1_raw"] = _aq_num(aq, "DESIGN_SPEED_VS1")
    info["vr_raw"] = _aq_num(aq, "DESIGN_TAKEOFF_SPEED")
    kt = fps * 0.592484 if fps else None
    info["cruise_kt"] = kt if kt and 40 <= kt <= 400 else None
    # Places : stations de charge qui ne sont ni bagages ni cargo
    count = int(_aq_num(aq, "PAYLOAD_STATION_COUNT") or 0)
    names, roles = [], []
    raw_names = _read_station_names(aq, count) if count else []
    for i in range(1, count + 1):
        raw_nm = raw_names[i - 1] if i - 1 < len(raw_names) else ""
        names.append(raw_nm or "(sans nom)")
        nm = raw_nm.lower()
        if not nm:
            roles.append("?")
        elif any(k in nm for k in _BAGGAGE_WORDS):
            roles.append("baggage")
        else:
            roles.append("seat")
    known = [r for r in roles if r != "?"]
    info["station_count"] = count or None
    info["seats"] = roles.count("seat") if known and roles.count("seat") else None
    info["roles"] = roles if roles and len(known) == len(roles) else None
    info["stations"] = names
    return info


def _read_fuel_flow_gph(aq, engines):
    total = 0.0
    for i in range(1, max(1, min(int(engines or 1), 4)) + 1):
        v = _aq_num(aq, f"ENG_FUEL_FLOW_GPH:{i}")
        if v and v > 0:
            total += v
    return total or None


def _apply_payload(aq, weights_kg):
    pounds = [float(w) * 2.2046226218 for w in weights_kg]
    try:
        count = int(float(aq.get("PAYLOAD_STATION_COUNT") or 0))
    except Exception:
        count = 0
    if count <= 0:
        count = max(1, min(8, len(pounds)))
    applied = 0
    for idx in range(1, min(count, 8) + 1):
        value = pounds[idx - 1] if idx <= len(pounds) else 0.0
        try:
            aq.set(f"PAYLOAD_STATION_WEIGHT:{idx}", value)
            applied += 1
        except Exception as e:
            log.debug(f"Station payload ignoree {idx}: {e}")
    if applied <= 0:
        raise RuntimeError("Aucune station payload MSFS modifiable trouvee")
    return applied, sum(weights_kg)


def _apply_registration(aq, registration):
    reg = _normalize_registration(registration)
    tried = []
    for key in ("ATC_ID", "ATC ID", "ATC TAIL NUMBER", "ATC REGISTRATION"):
        try:
            if aq.set(key, reg.encode("utf-8")):
                tried.append(key)
        except Exception as e:
            log.warning(f"Immatriculation ignoree {key}: {e}")
    if not tried:
        raise RuntimeError("Aucune variable immatriculation MSFS modifiable trouvee")
    return reg, tried


def _com_frequency_to_mhz(value):
    try:
        n = float(value)
    except Exception:
        return 0.0
    if not math.isfinite(n) or n <= 0:
        return 0.0
    if 100.0 <= n <= 200.0:
        return n
    if n >= 1000000.0:
        return n / 1000000.0
    if n >= 100000.0:
        return n / 1000.0
    # Certaines variables SimConnect peuvent revenir en BCD16 (ex: 0x1908 => 119.080).
    i = int(round(n))
    if 0 < i <= 0x9999:
        digits = []
        tmp = i
        for _ in range(4):
            digits.insert(0, tmp & 0xF)
            tmp >>= 4
        if all(0 <= d <= 9 for d in digits):
            mhz = 100.0 + digits[0] * 10.0 + digits[1] + digits[2] / 10.0 + digits[3] / 100.0
            if 100.0 <= mhz <= 200.0:
                return mhz
    return n


def _read_com_frequency(aq, index):
    keys = [
        f"COM ACTIVE FREQUENCY:{index}",
        f"COM_ACTIVE_FREQUENCY:{index}",
        f"COM ACTIVE FREQ:{index}",
        f"COM_ACTIVE_FREQ:{index}",
        f"COM RECEIVE FREQUENCY:{index}",
        f"COM_RECEIVE_FREQUENCY:{index}",
    ]
    if index == 1:
        keys += ["COM1 ACTIVE FREQUENCY", "COM1_ACTIVE_FREQUENCY"]
    elif index == 2:
        keys += ["COM2 ACTIVE FREQUENCY", "COM2_ACTIVE_FREQUENCY"]
    for key in keys:
        try:
            mhz = _com_frequency_to_mhz(aq.get(key))
            if 100.0 <= mhz <= 200.0:
                return mhz
        except Exception as e:
            log.debug(f"Frequence COM ignoree {key}: {e}")
    return 0.0


def _xpdr_code_to_text(value):
    try:
        n = int(round(float(value)))
    except Exception:
        return ""
    if n <= 0:
        return ""
    candidates = []
    if 0 < n <= 0x7777:
        digits = []
        tmp = n
        for _ in range(4):
            digits.insert(0, tmp & 0xF)
            tmp >>= 4
        if all(0 <= d <= 7 for d in digits):
            candidates.append("".join(str(d) for d in digits))
    if 0 < n <= 7777:
        dec = f"{n:04d}"
        if len(dec) == 4 and all(ch in "01234567" for ch in dec):
            candidates.append(dec)
    try:
        octal = f"{n:o}"[-4:].zfill(4)
        if len(octal) == 4 and all(ch in "01234567" for ch in octal):
            candidates.append(octal)
    except Exception:
        pass
    for code in candidates:
        if code and code != "0000":
            return code
    return ""


def _read_transponder_code(aq):
    keys = [
        "TRANSPONDER CODE:1",
        "TRANSPONDER_CODE:1",
        "TRANSPONDER CODE",
        "TRANSPONDER_CODE",
        "XPNDR CODE",
        "XPDR CODE",
    ]
    for key in keys:
        try:
            code = _xpdr_code_to_text(aq.get(key))
            if code:
                return code
        except Exception as e:
            log.debug(f"Code transpondeur ignore {key}: {e}")
    return ""


def _read_transponder_state(aq, direct_request=None):
    keys = [
        "TRANSPONDER STATE:1",
        "TRANSPONDER_STATE:1",
        "TRANSPONDER STATE",
        "TRANSPONDER_STATE",
    ]
    for key in keys:
        try:
            value = aq.get(key)
            if value is None:
                continue
            state = int(round(float(value)))
            if 0 <= state <= 5:
                return state
        except Exception as e:
            log.debug(f"Etat transpondeur ignore {key}: {e}")
    if direct_request is not None:
        try:
            value = direct_request.get()
            if value is not None:
                state = int(round(float(value)))
                if 0 <= state <= 5:
                    return state
        except Exception as e:
            log.debug(f"Etat transpondeur direct ignore: {e}")
    return None


def _read_bool(aq, *keys):
    for key in keys:
        try:
            value = aq.get(key)
            if value is None:
                continue
            return bool(round(float(value)))
        except Exception as e:
            log.debug(f"Booleen SimConnect ignore {key}: {e}")
    return False


def _read_com_transmit(aq):
    com1_tx = _read_bool(aq, "COM TRANSMIT:1", "COM_TRANSMIT:1")
    com2_tx = _read_bool(aq, "COM TRANSMIT:2", "COM_TRANSMIT:2")
    if com1_tx and not com2_tx:
        return 1, com1_tx, com2_tx
    if com2_tx and not com1_tx:
        return 2, com1_tx, com2_tx
    if com1_tx:
        return 1, com1_tx, com2_tx
    if com2_tx:
        return 2, com1_tx, com2_tx

    keys = ["COM SELECTED TRANSMIT", "COM_SELECTED_TRANSMIT", "COM TRANSMIT", "COM_TRANSMIT"]
    for key in keys:
        try:
            value = aq.get(key)
            if value is None:
                continue
            n = int(round(float(value)))
            if n in (1, 2):
                return n, n == 1, n == 2
            if n in (0, 1):
                tx = n + 1
                return tx, tx == 1, tx == 2
        except Exception as e:
            log.debug(f"Selection COM ignoree {key}: {e}")
    return 0, False, False


class SilentHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(get_base_dir()), **kwargs)

    def end_headers(self):
        # HTML et polices : interdire le cache disque de WebView2,
        # sinon les mises a jour de l'interface ne s'affichent pas.
        if urlparse(self.path).path.lower().endswith((".html", ".woff2")):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, *a): pass

    def _checklist_list(self):
        folder = get_checklist_dir()
        files = sorted(p.name for p in folder.glob("*.pdf")) if folder.is_dir() else []
        _send_json(self, 200, {"ok": True, "files": files})

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path not in ("/api/checklist", "/api/checklist-delete"):
            _send_json(self, 404, {"ok": False, "message": "inconnu"})
            return
        if self.client_address[0] not in ("127.0.0.1", "::1"):
            _send_json(self, 403, {"ok": False, "message": "acces refuse"})
            return
        try:
            path = _checklist_file(parse_qs(parsed.query).get("file", [""])[0])
            if parsed.path == "/api/checklist-delete":
                if path.exists():
                    path.unlink()
                _send_json(self, 200, {"ok": True})
                return
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > CHECKLIST_MAX_BYTES:
                raise ValueError("fichier vide ou trop volumineux (30 Mo maximum)")
            data = self.rfile.read(length)
            if not data.startswith(b"%PDF-"):
                raise ValueError("ce fichier n'est pas un PDF")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            _send_json(self, 200, {"ok": True})
        except Exception as e:
            _send_json(self, 400, {"ok": False, "message": str(e)})

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/checklist-list":
            self._checklist_list()
            return
        if parsed.path.startswith("/api/payload-status"):
            _send_json(self, 200, _payload_result())
            return
        if parsed.path.startswith("/api/registration-status"):
            _send_json(self, 200, _registration_result())
            return
        if parsed.path.startswith("/api/registration"):
            try:
                qs = parse_qs(parsed.query)
                reg = qs.get("value", qs.get("registration", [""]))[0]
                reg = _queue_registration_sync(reg)
                _send_json(self, 200, {"ok": True, "queued": True, "registration": reg})
            except Exception as e:
                _send_json(self, 400, {"ok": False, "message": str(e)})
            return
        if parsed.path.startswith("/api/network"):
            ips = _local_ipv4_addresses()
            urls = [f"http://{ip}:{HTTP_PORT}/flyfrancevfr.html" for ip in ips]
            _send_json(self, 200, {"ok": True, "ips": ips, "urls": urls, "port": HTTP_PORT, "wsPort": WS_PORT})
            return
        if parsed.path.startswith("/api/qr"):
            try:
                qs = parse_qs(parsed.query)
                text = qs.get("data", [""])[0]
                if not text:
                    ips = _local_ipv4_addresses()
                    text = f"http://{ips[0]}:{HTTP_PORT}/flyfrancevfr.html" if ips else APP_URL
                _send_png(self, _qr_code_png(text))
            except Exception as e:
                _send_json(self, 400, {"ok": False, "message": str(e)})
            return
        if parsed.path.startswith("/api/payload"):
            try:
                qs = parse_qs(parsed.query)
                raw = qs.get("weights", [""])[0]
                weights = [float(x) for x in raw.split(",") if x.strip()]
                if not weights:
                    raise ValueError("aucun poids fourni")
                weights = _queue_payload_sync(weights)
                _send_json(self, 200, {"ok": True, "queued": True, "totalKg": round(sum(weights), 1), "stations": len(weights)})
            except Exception as e:
                _send_json(self, 400, {"ok": False, "message": str(e)})
            return
        if parsed.path.startswith("/api/fuel-status"):
            _send_json(self, 200, _fuel_result())
            return
        if parsed.path.startswith("/api/fuel"):
            try:
                qs = parse_qs(parsed.query)
                percent = qs.get("percent", [None])[0]
                if percent is None:
                    liters = float(qs.get("liters", [0])[0])
                    capacity = float(qs.get("capacity", [0])[0])
                    if capacity <= 0:
                        raise ValueError("capacite invalide")
                    percent = (liters / capacity) * 100.0
                percent = _queue_fuel_sync(float(percent))
                _send_json(self, 200, {"ok": True, "queued": True, "percent": round(percent, 1)})
            except Exception as e:
                _send_json(self, 400, {"ok": False, "message": str(e)})
            return
        if self.path.startswith("/api/update-openaip"):
            with _update_lock:
                running = _update_status.get("running", False)
            if not running:
                threading.Thread(target=_run_openaip_update, daemon=True).start()
            _send_json(self, 200, {"started": not running, "status": dict(_update_status)})
            return
        if self.path.startswith("/api/update-status"):
            with _update_lock:
                payload = dict(_update_status)
            _send_json(self, 200, payload)
            return
        if self.path.startswith("/api/telemetry"):
            with _data_lock:
                latest = dict(_latest_data)
            _send_json(self, 200, {"status": dict(_status), "latest": latest, "clients": len(connected_clients)})
            return
        if self.path.startswith("/api/shutdown"):
            _send_json(self, 200, {"ok": True, "message": "Arret de FlyFranceVFR"})
            threading.Timer(0.2, _shutdown_process).start()
            return
        super().do_GET()

def run_http_server():
    server = ThreadingHTTPServer((HOST, HTTP_PORT), SilentHandler)
    server.daemon_threads = True
    log.info(f"HTTP sur http://{HOST}:{HTTP_PORT}")
    server.serve_forever()


# ── Tray ──────────────────────────────────────────────────────────────────────

def make_icon(connected):
    img = Image.new("RGBA", (64, 64), (0,0,0,0))
    d   = ImageDraw.Draw(img)
    col = (61,214,140) if connected else (90,100,128)
    d.polygon([(32,4),(40,28),(60,32),(40,38),(44,60),(32,52),(20,60),(24,38),(4,32),(24,28)], fill=col)
    return img

def update_tray():
    if not _tray_icon: return
    s = _status
    if s["sim"]:
        _tray_icon.icon  = make_icon(True)
        _tray_icon.title = f"FlyFranceVFR ✓  {s['alt']:.0f} ft · {s['spd']:.0f} kt · HDG {s['hdg']:.0f}°"
    else:
        _tray_icon.icon  = make_icon(False)
        _tray_icon.title = "FlyFranceVFR — En attente de MSFS..."


# ── WebSocket ─────────────────────────────────────────────────────────────────

async def broadcast(data):
    if not connected_clients: return
    msg = json.dumps(data)
    await asyncio.gather(*[c.send(msg) for c in connected_clients], return_exceptions=True)


def find_vosk_model_path():
    """Le modèle peut se trouver à côté de l'exe (copie manuelle dans
    inno_package\\bridge\\) ou dans _internal\\ (embarqué via --add-data lors
    du build PyInstaller) : on essaie les deux, dans cet ordre."""
    candidates = [get_base_dir() / VOSK_MODEL_DIR_NAME]
    meipass = getattr(sys, '_MEIPASS', None)
    if meipass:
        candidates.append(Path(meipass) / VOSK_MODEL_DIR_NAME)
    for c in candidates:
        if c.exists():
            return c
    return candidates[0]  # aucun trouvé : on renvoie le 1er, RadioRecognizer loggera l'erreur


def get_radio_recognizer():
    """Charge le modèle Vosk au premier appel (évite d'alourdir le démarrage
    du bridge si la radio vocale n'est jamais utilisée)."""
    global _radio_recognizer
    with _radio_recognizer_lock:
        if _radio_recognizer is None:
            model_path = find_vosk_model_path()
            log.info(f"Chemin modèle Vosk retenu : {model_path}")
            _radio_recognizer = RadioRecognizer(model_path, _loop, _on_radio_result)
        return _radio_recognizer


async def _on_radio_result(text, final, error=None):
    payload = {'type': 'radioTranscript', 'text': text, 'final': bool(final)}
    if error:
        payload['error'] = error
        log.warning(f"Radio Vosk indisponible : {error}")
    await broadcast(payload)


def _pilot_title(pilot):
    """Titre SimObject propre à un pilote : "pilot_titles": {"pilot-01": "FFVFR DR400 F-NACD", ...}.

    Prioritaire sur pilot_liveries (par peinture) : chaque pilote a sa propre
    livree Community avec l'immatriculation cuite dans la texture.
    """
    if _traffic_engine is None or not isinstance(pilot, dict):
        return None
    pid = str(pilot.get("id") or "").strip()
    if not pid:
        return None
    try:
        title = (_traffic_engine.config.get("pilot_titles") or {}).get(pid)
    except Exception:
        return None
    if title and str(title).strip():
        return str(title).strip()
    return None


def _discover_ai_aircraft_title(model, paint=None):
    """Cherche un titre [fltsim] dans les aircraft.cfg des packages MSFS installés.

    paint (facultatif) : livrée du pilote fictif ("bleu-blanc", "jaune-noir",
    "rouge-blanc"...) lue dans traffic_ia_config.json. Chaque pilote recoit sa
    propre livrée installée dans MSFS, distinguable visuellement, avec une
    préférence pour les livrées qui affichent l'immatriculation
    (atc_id_enable = 1) au lieu d'un rectangle blanc.
    """
    paint_key = str(paint or "").strip().casefold()
    model = str(model or "").strip().upper()
    cache_key = (model, paint_key)
    if cache_key in _ai_aircraft_title_cache:
        return _ai_aircraft_title_cache[cache_key]

    # Livrée par pilote imposée dans traffic_ia_config.json :
    # "pilot_liveries": {"DR400": {"bleu-blanc": "titre exact", ...}}
    if paint_key:
        try:
            forced_paint = (((_traffic_engine.config.get("pilot_liveries") or {}).get(model) or {}).get(paint_key)
                            if _traffic_engine is not None else None)
        except Exception:
            forced_paint = None
        if forced_paint and str(forced_paint).strip():
            title = str(forced_paint).strip()
            log.info(f"Livrée pilote imposée par la configuration pour {model}/{paint_key}: {title}")
            _ai_aircraft_title_cache[cache_key] = title
            return title

    # Titre imposé dans traffic_ia_config.json : "aircraft_titles": {"DR400": "titre exact"}
    try:
        forced = ((_traffic_engine.config.get("aircraft_titles") or {}).get(model)
                  if _traffic_engine is not None else None)
    except Exception:
        forced = None
    if forced and str(forced).strip() and not paint_key:
        title = str(forced).strip()
        log.info(f"Titre SimObject imposé par la configuration pour {model}: {title}")
        _ai_aircraft_title_cache[cache_key] = title
        return title

    packages = []
    explicit = os.environ.get("MSFS_PACKAGES_PATH", "").strip().strip('"')
    if explicit:
        packages.append(Path(explicit))

    appdata = Path(os.environ.get("APPDATA", str(Path.home() / "AppData/Roaming")))
    local = Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData/Local")))
    cfg_candidates = [
        appdata / "Microsoft Flight Simulator" / "UserCfg.opt",
        local / "Packages" / "Microsoft.FlightSimulator_8wekyb3d8bbwe" / "LocalCache" / "UserCfg.opt",
        local / "Packages" / "Microsoft.Limitless_8wekyb3d8bbwe" / "LocalCache" / "UserCfg.opt",
    ]
    for cfg in cfg_candidates:
        try:
            content = cfg.read_text(encoding="utf-8", errors="ignore")
            match = re.search(r'InstalledPackagesPath\s+"([^"]+)"', content, re.I)
            if match:
                packages.append(Path(match.group(1)))
        except OSError:
            pass

    roots = []
    seen = set()
    for base in packages:
        for candidate in (base / "Community", base / "Official" / "OneStore", base / "Official" / "Steam"):
            key = str(candidate).lower()
            if key not in seen and candidate.is_dir():
                roots.append(candidate)
                seen.add(key)

    candidates = []
    title_re = re.compile(r'^\s*title\s*=\s*(.*?)\s*$', re.I | re.M)
    for root in roots:
        try:
            cfg_files = root.rglob("aircraft.cfg")
            for cfg in cfg_files:
                try:
                    content = cfg.read_text(encoding="utf-8-sig", errors="ignore")
                except OSError:
                    continue
                for raw_title in title_re.findall(content):
                    # aircraft.cfg peut contenir : title = "Nom avion" ; commentaire
                    # Ne jamais transmettre le commentaire au nom du conteneur SimConnect.
                    title_value = re.sub(r"\s+[;#].*$", "", raw_title).strip()
                    if len(title_value) >= 2 and title_value[0] == title_value[-1] and title_value[0] in ('"', "'"):
                        title_value = title_value[1:-1]
                    title = title_value.strip()
                    normalized = re.sub(r'[^A-Z0-9]+', '', title.upper())
                    if not title:
                        continue
                    if model == "DR400":
                        if "DR400" in normalized:
                            priority = 0
                        elif "ROBIN" in normalized and ("DR" in normalized or "400" in normalized):
                            priority = 1
                        else:
                            continue
                    elif model == "C172":
                        if "C172" in normalized or "CESSNA172" in normalized:
                            priority = 0
                        elif "172" in normalized and ("CESSNA" in normalized or "SKYHAWK" in normalized):
                            priority = 1
                        else:
                            continue
                    elif model == "DA40NG":
                        # Diamond DA40 NG : ne jamais confondre avec le DA40 TDI.
                        if "DA40NG" in normalized and "TDI" not in normalized:
                            priority = 0
                        else:
                            continue
                    else:
                        continue
                    # Livrées qui affichent l'immatriculation (atc_id_enable = 1)
                    # sont préférées : une livrée "0" dessine un rectangle blanc.
                    enable_match = re.search(r"^\s*atc_id_enable\s*=\s*(\d)", content, re.I | re.M)
                    decal_ok = 0 if (enable_match and enable_match.group(1) == "0") else 1
                    candidates.append((priority, decal_ok, title.casefold(), title, str(cfg)))
        except OSError:
            continue

    if candidates:
        candidates.sort(key=lambda item: (item[0], 1 - item[1], item[2]))
        if paint_key:
            # Livrée par pilote : pool restreint aux livrées affichant
            # l'immatriculation, attribution stable par nom de livrée.
            decal_titles = [item for item in candidates if item[1] == 1]
            pool = decal_titles if decal_titles else candidates
            paint_rotation = ["bleu-blanc", "jaune-noir", "rouge-blanc", "blanc-bleu",
                              "noir-jaune", "blanc-rouge", "jaune-bleu", "rouge-blanc-v2"]
            try:
                paint_index = paint_rotation.index(paint_key)
            except ValueError:
                paint_index = sum(ord(ch) for ch in paint_key)
            chosen = pool[paint_index % len(pool)]
            title = chosen[3]
            log.info(
                f"Livrée pilote {paint_key} pour {model}: {title} ({chosen[4]}) "
                f"[{paint_index % len(pool) + 1}/{len(pool)} livrées avec immatriculation]",
            )
        else:
            title = candidates[0][3]
            log.info(f"Titre SimObject détecté pour {model}: {title} ({candidates[0][4]})")
        for _prio, _decal, _key, _title, _cfg in candidates[:10]:
            log.info(f"  candidat {model} (priorité {_prio}, immat {'oui' if _decal else 'non'}) : {_title} ({_cfg})")
    else:
        title = AI_AIRCRAFT_TITLES.get(model, model)
        log.warning(f"Aucun aircraft.cfg correspondant à {model} trouvé ; utilisation du titre candidat '{title}'")

    _ai_aircraft_title_cache[cache_key] = title
    return title


def _select_matching_airport_livery(command, read_traffic):
    """Réutilise la variante TITLE d'un avion identique déjà posé à proximité."""
    if not callable(read_traffic):
        return
    try:
        traffic = read_traffic()
    except Exception as exc:
        log.debug("Lecture du trafic pour la livrée IA impossible : %s", exc)
        return

    # La télémétrie principale donne la position de l'avion utilisateur : on
    # évite ainsi de copier une livrée d'un aérodrome voisin dans le rayon 12 km.
    with _data_lock:
        user_data = dict(_latest_data)
    try:
        user_lat = float(user_data.get("lat"))
        user_lon = float(user_data.get("lon"))
    except (TypeError, ValueError):
        user_lat = user_lon = None

    wanted = command.get("model", "").upper()
    candidates = []

    # RequestDataOnSimObjectType ne renvoie pas toujours l'avion utilisateur.
    # On ajoute donc celui-ci comme référence s'il est posé sur l'aérodrome :
    # son TITLE est le nom exact de la variante/livrée chargée par MSFS.
    user_title = str(user_data.get("aircraft_title") or "").strip()
    user_on_ground = bool(user_data.get("on_ground"))
    if user_title and user_on_ground:
        normalized_user = re.sub(r"[^A-Z0-9]+", "", user_title.upper())
        if wanted == "DR400":
            user_matches = "DR400" in normalized_user or ("ROBIN" in normalized_user and ("DR" in normalized_user or "400" in normalized_user))
        elif wanted == "C172":
            user_matches = "C172" in normalized_user or "CESSNA172" in normalized_user or ("172" in normalized_user and ("CESSNA" in normalized_user or "SKYHAWK" in normalized_user))
        elif wanted == "DA40NG":
            user_matches = "DA40NG" in normalized_user and "TDI" not in normalized_user
        else:
            user_matches = False
        if user_matches:
            candidates.append((0.0, user_title, {
                "id": "USER", "title": user_title,
                "lat": user_data.get("lat"), "lon": user_data.get("lon"),
                "on_ground": True,
            }))
            log.info("Avion utilisateur retenu comme référence de livrée : %s (%s au sol)", user_title, wanted)

    for item in traffic:
        title = str(item.get("title") or "").strip()
        if not title or not item.get("on_ground"):
            continue
        # Ne pas recopier un avion déjà injecté par FlyFranceVFR : on veut
        # prendre comme référence le trafic/aéronef déjà présent sur le terrain.
        try:
            object_id = int(item.get("id", -1))
        except (TypeError, ValueError):
            object_id = -1
        if object_id in _ai_object_ids:
            continue
        normalized = re.sub(r"[^A-Z0-9]+", "", title.upper())
        if wanted == "DR400":
            matches = "DR400" in normalized or ("ROBIN" in normalized and ("DR" in normalized or "400" in normalized))
        elif wanted == "C172":
            matches = "C172" in normalized or "CESSNA172" in normalized or ("172" in normalized and ("CESSNA" in normalized or "SKYHAWK" in normalized))
        elif wanted == "DA40NG":
            matches = "DA40NG" in normalized and "TDI" not in normalized
        else:
            matches = False
        if not matches:
            continue
        distance = 0.0
        if user_lat is not None and user_lon is not None:
            try:
                dlat = (float(item["lat"]) - user_lat) * 111320.0
                dlon = (float(item["lon"]) - user_lon) * 111320.0 * math.cos(math.radians(user_lat))
                distance = math.hypot(dlat, dlon)
            except (KeyError, TypeError, ValueError):
                distance = 999999.0
            if distance > 2000.0:
                continue
        candidates.append((distance, title, item))

    if not candidates:
        titles_seen = [str(item.get("title") or "").strip() for item in traffic if item.get("on_ground")]
        titles_seen = [title for title in titles_seen if title][:8]
        log.info(
            "Aucun %s déjà au sol à proximité : conservation de la livrée SimObject par défaut (%s). Titres au sol observés : %s",
            wanted, command.get("title"), ", ".join(titles_seen) if titles_seen else "aucun titre lisible",
        )
        return

    candidates.sort(key=lambda entry: entry[0])
    distance, selected_title, source = candidates[0]
    previous_title = command.get("title")
    command["title"] = selected_title
    command["livery_source"] = {
        "object_id": source.get("id"),
        "title": selected_title,
        "distance_m": round(distance, 1),
    }
    log.info(
        "Livrée reprise depuis l'avion déjà présent : modèle=%s, titre='%s', objet source=%s, distance=%.1f m (titre initial='%s')",
        wanted, selected_title, source.get("id"), distance, previous_title,
    )


def _ai_category_limit(kind):
    """Limite par catégorie (parked / patrol) depuis traffic_ia_config.json."""
    cfg = (_traffic_engine.config or {}) if _traffic_engine is not None else {}
    default = AI_MAX_PARKED_AIRCRAFT if kind == "parked" else AI_MAX_PATROL_AIRCRAFT
    try:
        return max(1, min(15, int(cfg.get(f"max_{kind}_aircraft", default))))
    except (TypeError, ValueError):
        return int(default)


def _ai_active_counts():
    """(parked, patrol) : avions actifs + demandes en attente + file d'attente."""
    parked = patrol = 0
    for rec in _ai_object_records.values():
        if rec.get("patrol"):
            patrol += 1
        else:
            parked += 1
    for pending in _ai_pending_requests.values():
        command = pending.get("command") or {}
        if command.get("mode") == "patrol":
            patrol += 1
        else:
            parked += 1
    with _ai_command_queue.mutex:
        for command in list(_ai_command_queue.queue):
            if command.get("mode") == "patrol":
                patrol += 1
            else:
                parked += 1
    return parked, patrol


def _queue_ai_parked_aircraft(model, airport_icao):
    model = str(model or "").strip().upper()
    icao = str(airport_icao or "").strip().upper()
    if model not in AI_AIRCRAFT_TITLES:
        raise ValueError("Modèle IA non autorisé (DR400, C172 ou DA40NG attendu)")
    if not re.fullmatch(r"[A-Z0-9]{3,4}", icao):
        raise ValueError("Code OACI aérodrome invalide")
    # Les 15 pilotes fictifs ont une identité et un indicatif fixes dans
    # traffic_ia_config.json. On attribue le premier profil libre à chaque avion.
    with _ai_pending_lock:
        parked_count, _patrol_count = _ai_active_counts()
        max_parked = _ai_category_limit("parked")
        if parked_count >= max_parked:
            raise ValueError(
                f"Limite atteinte : {max_parked} avions IA maximum à l'aérodrome "
                "(patrouilles en vol non comptées). Supprime un avion avant d'en creer un autre."
            )
        pilots = (_traffic_engine.fleet_manifest() if _traffic_engine is not None else [])
        used_pilot_ids = {str(rec.get("pilot_id")) for rec in _ai_object_records.values() if rec.get("pilot_id")}
        used_pilot_ids.update(str(p.get("command", {}).get("pilot", {}).get("id"))
                              for p in _ai_pending_requests.values() if p.get("command"))
        with _ai_command_queue.mutex:
            used_pilot_ids.update(str(cmd.get("pilot", {}).get("id")) for cmd in list(_ai_command_queue.queue))
        pilot = next((dict(x) for x in pilots if str(x.get("id")) not in used_pilot_ids), None)
        if not pilot:
            raise RuntimeError("Les 15 pilotes fictifs sont déjà affectés à des avions IA actifs.")
        tail = str(pilot.get("callsign") or "").strip().upper()
        if not re.fullmatch(r"F-[A-Z0-9]{4}", tail):
            raise RuntimeError(f"Indicatif invalide dans le profil {pilot.get('id')}: {tail!r}")
        if tail in _ai_used_tail_numbers:
            raise RuntimeError(f"Indicatif déjà utilisé pendant cette session : {tail}")
        _ai_used_tail_numbers.add(tail)
    command_id = f"ai-{int(time.time() * 1000)}-{secrets.token_hex(3)}"
    _ai_command_queue.put({
        "command_id": command_id,
        "model": model,
        "title": _pilot_title(pilot) or _discover_ai_aircraft_title(model, pilot.get("paint")),
        "airport_icao": icao,
        "tail_number": tail,
        "pilot": pilot,
        "created_at": time.time(),
    })
    return {"command_id": command_id, "model": model, "airport_icao": icao, "tail_number": tail}


def _ai_patrol_params():
    """Paramètres de patrouille en vol depuis traffic_ia_config.json (clé "patrol")."""
    cfg = (_traffic_engine.config or {}) if _traffic_engine is not None else {}
    patrol = cfg.get("patrol") or {}
    params = {}
    for key, default, lo, hi in (
        ("altitude_ft", AI_PATROL_DEFAULTS["altitude_ft"], 500.0, 12000.0),
        ("radius_nm", AI_PATROL_DEFAULTS["radius_nm"], 0.5, 20.0),
        ("speed_kts", AI_PATROL_DEFAULTS["speed_kts"], 40.0, 250.0),
    ):
        try:
            params[key] = max(lo, min(hi, float(patrol.get(key, default))))
        except (TypeError, ValueError):
            params[key] = float(default)
    try:
        params["points"] = int(max(6, min(36, int(patrol.get("points", AI_PATROL_DEFAULTS["points"])))))
    except (TypeError, ValueError):
        params["points"] = int(AI_PATROL_DEFAULTS["points"])
    params["direction"] = "left" if str(patrol.get("direction", AI_PATROL_DEFAULTS["direction"])).lower() == "left" else "right"
    return params


def _destination_point(lat, lon, bearing_deg, dist_nm):
    """Point d'arrivée depuis (lat, lon) en orthodromie simple sur sphère."""
    earth_nm = 3440.065
    brn = math.radians(bearing_deg)
    la1 = math.radians(float(lat))
    lo1 = math.radians(float(lon))
    la2 = math.asin(math.sin(la1) * math.cos(dist_nm / earth_nm)
                    + math.cos(la1) * math.sin(dist_nm / earth_nm) * math.cos(brn))
    lo2 = lo1 + math.atan2(math.sin(brn) * math.sin(dist_nm / earth_nm) * math.cos(la1),
                           math.cos(dist_nm / earth_nm) - math.sin(la1) * math.sin(la2))
    return math.degrees(la2), (math.degrees(lo2) + 540.0) % 360.0 - 180.0


def _queue_ai_patrol_aircraft(model, airport_payload, radius_nm=None, altitude_ft=None):
    """File une création d'avion IA directement en vol (patrouille en circuit fermé)."""
    model = str(model or "").strip().upper()
    if model not in AI_AIRCRAFT_TITLES:
        raise ValueError("Modèle IA non autorisé (DR400, C172 ou DA40NG attendu)")
    airport = _airport_from_payload(airport_payload)
    with _ai_pending_lock:
        _parked_count, patrol_count = _ai_active_counts()
        max_patrol = _ai_category_limit("patrol")
        if patrol_count >= max_patrol:
            raise ValueError(
                f"Limite atteinte : {max_patrol} patrouilles en vol maximum "
                "(avions posés à l'aérodrome non comptés). Supprime un avion avant d'en creer un autre."
            )
        pilots = (_traffic_engine.fleet_manifest() if _traffic_engine is not None else [])
        used_pilot_ids = {str(rec.get("pilot_id")) for rec in _ai_object_records.values() if rec.get("pilot_id")}
        used_pilot_ids.update(str(p.get("command", {}).get("pilot", {}).get("id"))
                              for p in _ai_pending_requests.values() if p.get("command"))
        with _ai_command_queue.mutex:
            used_pilot_ids.update(str(cmd.get("pilot", {}).get("id")) for cmd in list(_ai_command_queue.queue))
        pilot = next((dict(x) for x in pilots if str(x.get("id")) not in used_pilot_ids), None)
        if not pilot:
            raise RuntimeError("Les 15 pilotes fictifs sont déjà affectés à des avions IA actifs.")
        tail = str(pilot.get("callsign") or "").strip().upper()
        if not re.fullmatch(r"F-[A-Z0-9]{4}", tail):
            raise RuntimeError(f"Indicatif invalide dans le profil {pilot.get('id')}: {tail!r}")
        if tail in _ai_used_tail_numbers:
            raise RuntimeError(f"Indicatif déjà utilisé pendant cette session : {tail}")
        # Indicatif réutilisable : une patrouille supprimée peut recréer le même profil.
        # (pas d'ajout à _ai_used_tail_numbers tant que l'avion n'est pas confirmé)
        spawn_slot = patrol_count  # rang de création : décale le point de départ sur le cercle
    params = _ai_patrol_params()
    try:
        if radius_nm is not None:
            params["radius_nm"] = max(0.5, min(20.0, float(radius_nm)))
    except (TypeError, ValueError):
        pass
    try:
        if altitude_ft is not None:
            params["altitude_ft"] = max(500.0, min(12000.0, float(altitude_ft)))
    except (TypeError, ValueError):
        pass
    # Circuit : points répartis autour du centre. Stratégie anti-blocage MSFS :
    # - la liste de waypoints ne peut être envoyée qu'UNE fois par objet (bug MSFS) ;
    # - la boucle WRAP_TO_FIRST seule est parfois ignorée -> l'IA freine à
    #   l'arrivée du dernier waypoint. On envoie donc 120 tours EXPLICITES
    #   (≈ 20 h de vol), tous en SPEED_REQUESTED, avec WRAP_TO_FIRST
    #   uniquement sur le tout dernier waypoint.
    waypoints = []
    step = 360.0 / params["points"]
    sign = 1.0 if params["direction"] == "right" else -1.0
    if spawn_slot % 2 == 1:
        sign = -sign  # sens alterné : les patrouilles paires/impaires tournent en sens inverse
    spawn_offset = (spawn_slot * 120.0) % 360.0
    # Chaque patrouille reçoit son propre parcours : rayon, sens, phase et
    # légère forme ovale diffèrent. Elles restent autour de l'aérodrome sans
    # se superposer ni se suivre comme sur le même rail.
    slot_radius = params["radius_nm"] + (spawn_slot * 1.0)
    slot_speed = params["speed_kts"] * (1.0 + 0.08 * (spawn_slot - 1))
    slot_speed = max(40.0, min(250.0, slot_speed))
    route_lobes = 2 + (spawn_slot % 2)  # ovales à 2 ou 3 lobes, selon l'avion
    route_variation_nm = 0.35 + (0.10 * (spawn_slot % 3))
    route_phase = (spawn_offset + 37.0 * spawn_slot) % 360.0
    # Nombre de tours : SimConnect rejette les envois trop volumineux en un seul
    # SetDataOnSimObject (access violation au-delà de ~50 Ko ; constaté en test).
    # On borne la charge utile à ~24 Ko par envoi (48 octets par waypoint),
    # soit ≈ 40 tours de 12 points (1440 legs = ~8 h de vol) ; WRAP_TO_FIRST
    # sur le tout dernier waypoint boucle la patrouille si MSFS l'honore.
    # Nombre de tours : le tampon d'envoi SimConnect est plafonné à 4096 octets ;
    # au-delà le paquet est refusé (INVALID_DATA_SIZE, voire access violation).
    # On borne la charge utile à 4000 octets : 6 tours de 12 points = 72
    # waypoints (3,4 Ko, ~1 h de vol), WRAP_TO_FIRST sur le tout dernier.
    waypoint_bytes = ctypes.sizeof(AI_WaypointMsfs) * params["points"]
    patrol_laps = max(2, min(10, 4000 // max(1, waypoint_bytes)))
    for _lap in range(patrol_laps):
        for index in range(params["points"]):
            bearing = (spawn_offset + sign * step * index) % 360.0
            point_radius = slot_radius + route_variation_nm * math.sin(
                math.radians(route_lobes * (bearing - route_phase))
            )
            wlat, wlon = _destination_point(
                airport.latitude, airport.longitude, bearing, point_radius
            )
            # La vitesse demandée suffit au pilote IA. Ne pas imposer aussi
            # les gaz : ces deux ordres peuvent se contredire suivant le modèle
            # d'avion, jusqu'à faire chuter sa vitesse à zéro.
            flags = AI_WAYPOINT_SPEED_REQUESTED | AI_WAYPOINT_COMPUTE_VERTICAL_SPEED
            if _lap == patrol_laps - 1 and index == params["points"] - 1:
                flags |= AI_WAYPOINT_WRAP_TO_FIRST
            waypoints.append(AI_WaypointMsfs(
                Latitude=wlat, Longitude=wlon, Altitude=params["altitude_ft"],
                Flags=flags, ktsSpeed=slot_speed,
                percentThrottle=0.0,
            ))
    # Cap réel entre les deux premiers points, quel que soit le sens de rotation.
    _dlat = waypoints[1].Latitude - waypoints[0].Latitude
    _dlon = (waypoints[1].Longitude - waypoints[0].Longitude) * math.cos(math.radians(waypoints[0].Latitude))
    tangent = (math.degrees(math.atan2(_dlon, _dlat)) + 360.0) % 360.0
    # Ne jamais créer l'IA exactement sur son premier waypoint : MSFS peut le
    # considérer déjà atteint dès l'apparition et laisser l'avion sans ordre de
    # mouvement. On le crée 0,25 NM en amont, dans l'axe du premier segment.
    init_lat, init_lon = _destination_point(
        waypoints[0].Latitude, waypoints[0].Longitude, (tangent + 180.0) % 360.0, 0.25,
    )
    _patrol_info = {"altitude_ft": params["altitude_ft"], "radius_nm": round(slot_radius, 2),
                    "speed_kts": round(slot_speed), "points": params["points"],
                    "direction": "right" if sign > 0 else "left",
                    "route_shape": f"boucle {route_lobes} lobes"}
    command_id = f"ai-{int(time.time() * 1000)}-{secrets.token_hex(3)}"
    _ai_command_queue.put({
        "command_id": command_id,
        "mode": "patrol",
        "model": model,
        "title": _pilot_title(pilot) or _discover_ai_aircraft_title(model, pilot.get("paint")),
        "airport_icao": airport.icao,
        "tail_number": tail,
        "pilot": pilot,
        "created_at": time.time(),
        "patrol": _patrol_info,
        "init": {"lat": init_lat, "lon": init_lon, "alt": params["altitude_ft"],
                 "heading": tangent, "speed": int(round(slot_speed))},
        "waypoints": waypoints,
    })
    return {"command_id": command_id, "model": model, "airport_icao": airport.icao,
            "tail_number": tail, "patrol": _patrol_info}


def _queue_ai_remove_aircraft(object_id):
    """N'autorise la suppression que des objets crees par cette instance du Bridge."""
    try:
        object_id = int(object_id)
    except (TypeError, ValueError):
        raise ValueError("Identifiant d'avion IA invalide")
    with _ai_pending_lock:
        record = _ai_object_records.get(object_id)
        if record is None:
            raise ValueError("Cet avion ne fait pas partie des avions IA crees par FlyFranceVFR")
        if record.get("removing"):
            raise ValueError("La suppression de cet avion est deja en cours")
        record["removing"] = True
    _ai_remove_queue.put({"object_id": object_id, "record": dict(record)})
    return {"object_id": object_id}


def _airport_from_payload(payload):
    if not isinstance(payload, dict):
        raise ValueError("Données aérodrome manquantes")
    airport = Airport(
        icao=str(payload.get("icao", "")).strip().upper(),
        name=str(payload.get("name", payload.get("icao", "Aérodrome"))).strip(),
        latitude=float(payload.get("latitude")),
        longitude=float(payload.get("longitude")),
        altitude_ft=float(payload.get("altitude_ft", 0.0)),
    )
    airport.validate()
    return airport


def _queue_ai_round_trip(object_id, departure_payload, destination_payload):
    """Prépare un aller-retour ATC pour un avion IA déjà créé au parking."""
    if Airport is None or build_vfr_flightplan is None:
        raise RuntimeError("Gestionnaire de vol IA non chargé")
    try:
        object_id = int(object_id)
    except (TypeError, ValueError):
        raise ValueError("Identifiant avion invalide")
    with _ai_pending_lock:
        record = _ai_object_records.get(object_id)
        if record is None:
            raise ValueError("Avion non géré par FlyFranceVFR")
        if record.get("flight_phase") not in (None, "parked", "completed"):
            raise ValueError("Un vol est déjà en cours pour cet avion")
    departure = _airport_from_payload(departure_payload)
    destination = _airport_from_payload(destination_payload)
    if departure.icao == destination.icao:
        raise ValueError("L'aérodrome de destination doit être différent du départ")
    out_dir = get_base_dir() / "traffic_AI" / "flightplans"
    outbound = build_vfr_flightplan(departure, destination, out_dir, leg_name="aller")
    inbound = build_vfr_flightplan(destination, departure, out_dir, leg_name="retour")
    command_id = f"flight-{int(time.time() * 1000)}-{secrets.token_hex(3)}"
    # Altitude de croisière explicite (le PLN direct laisse l'ATC IA voler à ~100 ft AGL).
    airborne_legs = None
    if _airborne_control_enabled() and transit_route_points is not None:
        try:
            airborne_legs = {
                "outbound": {"points": transit_route_points(departure, destination), "stage": "pending",
                             "atc_path": str(outbound), "max_seconds": 3600.0},
                "return": {"points": transit_route_points(destination, departure), "stage": "pending",
                           "atc_path": str(inbound), "max_seconds": 3600.0},
            }
        except Exception as leg_exc:
            log.warning("Route aérienne de transit non préparée (%s) : plan ATC seul", leg_exc)
    _ai_flightplan_queue.put({
        "command_id": command_id, "object_id": object_id,
        "departure": departure, "destination": destination,
        "outbound_path": str(outbound), "inbound_path": str(inbound),
        "phase": "outbound", "created_at": time.time(),
        "airborne_legs": airborne_legs,
    })
    return {"command_id": command_id, "object_id": object_id,
            "departure": departure.icao, "destination": destination.icao}



def _queue_ai_local_circuit(object_id, airport_payload, runway_heading_deg, circuit_direction="left",
                            runway_designator="", holding_full=""):
    """Prépare un circuit local pour un avion. Plusieurs avions du même aérodrome
    peuvent être lancés : leur sortie du parking est séquencée par
    _process_ai_flightplans (un seul roulage guidé à la fois)."""
    if Airport is None or build_local_circuit_flightplan is None:
        detail = _FLIGHT_MANAGER_LOAD_ERROR or "fonctions du gestionnaire indisponibles"
        raise RuntimeError(f"Gestionnaire de circuit IA non chargé : {detail}. Dossier attendu : {_TRAFFIC_AI_DIR}")
    try:
        object_id = int(object_id)
    except (TypeError, ValueError):
        raise ValueError("Identifiant avion invalide")
    with _ai_pending_lock:
        record = _ai_object_records.get(object_id)
        if record is None:
            raise ValueError("Avion non géré par FlyFranceVFR")
        if record.get("flight_phase") not in (None, "parked", "completed"):
            raise ValueError("Un vol est déjà en cours pour cet avion")
    airport = _airport_from_payload(airport_payload)
    if str(record.get("airport_icao", "")).upper() != airport.icao:
        raise ValueError(
            f"Cet avion est stationné à {record.get('airport_icao') or 'un autre aérodrome'}, "
            f"pas à {airport.icao}. Le circuit doit rester sur son aérodrome de départ."
        )
    heading = float(runway_heading_deg)
    if not 0.0 <= heading <= 360.0:
        raise ValueError("Cap de piste invalide")
    out_dir = get_base_dir() / "traffic_AI" / "flightplans"
    mission = "circuit"
    circuit_path = build_local_circuit_flightplan(
        airport, heading, out_dir, circuit_direction=circuit_direction,
        circuit_count=AI_CIRCUIT_LAPS
    )
    # Constat des logs : avec un PLN dont départ = arrivée, l'ATC IA de MSFS ignore
    # les waypoints intermédiaires et fait un seul circuit. On garde donc le PLN
    # pour le décollage et l'atterrissage, et on pilote les waypoints en vol.
    airborne_plan = None
    if _airborne_control_enabled() and circuit_route_points is not None:
        try:
            airborne_points = circuit_route_points(
                airport, heading, circuit_direction=circuit_direction, circuit_count=AI_CIRCUIT_LAPS)
            airborne_max_s = 1800.0
            airborne_plan = {"points": airborne_points, "stage": "pending",
                             "atc_path": str(circuit_path), "max_seconds": airborne_max_s,
                             "kind": mission, "runway_heading": float(heading) % 360.0,
                             "direction": circuit_direction}
        except Exception as plan_exc:
            log.warning("Route aérienne IA non préparée (%s) : retour au plan ATC seul", plan_exc)
    command_id = f"circuit-{int(time.time() * 1000)}-{secrets.token_hex(3)}"
    # Conserver l'axe de piste demandé pour analyser le roulage et l'alignement.
    # Ce suivi est uniquement diagnostique : il ne prend pas le contrôle de l'avion.
    with _ai_pending_lock:
        current_record = _ai_object_records.get(object_id)
        if current_record is not None:
            current_record["runway_heading_deg"] = heading % 360.0
            current_record["ground_route_last_state"] = None
            current_record["mission"] = mission
            current_record["airborne_plan"] = airborne_plan
            current_record["radio_context"] = {
                "mission": mission,
                "airport_icao": airport.icao, "airport_name": airport.name,
                "runway_designator": str(runway_designator or "").strip().upper(),
                "holding_full": str(holding_full or "").strip(),
                "base_runway_designator": str(runway_designator or "").strip().upper(),
                "base_holding_full": str(holding_full or "").strip(),
                "base_runway_heading": heading % 360.0,
                "circuit_direction": direction if (direction := str(circuit_direction or "left").lower()) in ("left", "right") else "left",
            }
            current_record["radio_tracker"] = AIRadioCircuitTracker(
                airport.latitude, airport.longitude, heading, circuit_direction
            )
    _ai_flightplan_queue.put({
        "command_id": command_id, "object_id": object_id,
        "departure": airport, "destination": airport,
        "outbound_path": str(circuit_path), "inbound_path": None,
        "phase": "local_circuit", "created_at": time.time(),
        "runway_heading_deg": heading % 360.0,
    })
    return {"command_id": command_id, "object_id": object_id,
            "airport_icao": airport.icao, "runway_heading": heading,
            "flightplan": str(circuit_path), "mission": mission,
            "laps": AI_CIRCUIT_LAPS}

def _ai_launch_stagger_seconds():
    """Délai entre deux départs : traffic_ia_config.json (launch_stagger_seconds) ou défaut."""
    try:
        value = float((_traffic_engine.config or {}).get("launch_stagger_seconds", AI_LAUNCH_STAGGER_SECONDS))
    except Exception:
        value = AI_LAUNCH_STAGGER_SECONDS
    return max(30.0, min(1800.0, value))


def _ai_departure_wait_seconds(object_id, airport_icao, now=None):
    """Secondes à attendre avant de laisser partir cet avion (0 = il peut partir).

    Règle : un nouveau départ n'est autorisé qu'un certain temps après le départ
    précédent du même aérodrome (pas après son retour), et jamais pendant qu'un
    autre avion effectue encore son roulage guidé vers le point d'attente. Un
    garde-fou de 5 minutes évite qu'un roulage bloqué n'empêche tout départ.
    """
    now = time.time() if now is None else float(now)
    code = str(airport_icao or "").strip().upper()
    wait = max(0.0, _ai_last_departure_at.get(code, 0.0) + _ai_launch_stagger_seconds() - now)
    with _ai_pending_lock:
        for oid, rec in _ai_object_records.items():
            if int(oid) == int(object_id) or rec.get("removing"):
                continue
            if str(rec.get("airport_icao", "")).strip().upper() != code:
                continue
            if rec.get("flight_phase") == "taxi_out":
                if now - float(rec.get("taxi_started_at") or now) < 300.0:
                    wait = max(wait, 10.0)
    return wait


def _send_ai_flightplan(sm, object_id, path, phase):
    """Transmet un PLN et suit les exceptions SimConnect différées par SendID."""
    request = sm.new_request_id()
    request_id = int(request.value)
    plan_path = Path(path).with_suffix("")  # SimConnect attend le chemin sans .pln
    if not Path(path).is_file():
        raise FileNotFoundError(f"Plan de vol introuvable : {path}")
    ET = __import__("xml.etree.ElementTree", fromlist=["ElementTree"])
    ET.parse(path)  # contrôle XML avant de toucher à l'avion
    hr = sm.dll.AISetAircraftFlightPlan(
        sm.hSimConnect, int(object_id), str(plan_path).encode("utf-8"), request_id
    )
    if not sm.IsHR(hr, 0):
        raise RuntimeError(f"AISetAircraftFlightPlan refusé immédiatement (HRESULT {int(hr) & 0xffffffff:#010x})")

    send_id = None
    packet_id = ctypes.c_uint32(0)
    packet_hr = sm.dll.GetLastSentPacketID(sm.hSimConnect, ctypes.byref(packet_id))
    if sm.IsHR(packet_hr, 0):
        send_id = int(packet_id.value)
    else:
        log.warning("Impossible de récupérer le SendID du plan IA (HRESULT %s)", f"{int(packet_hr) & 0xffffffff:#010x}")

    now = time.time()
    with _ai_pending_lock:
        delayed_error = _ai_exception_backlog.pop(send_id, None) if send_id is not None else None
        record = _ai_object_records.get(int(object_id))
        if delayed_error:
            if record is not None:
                record["flight_phase"] = "parked"
                record["round_trip"] = None
            raise RuntimeError(
                "MSFS a rejeté le plan après son envoi : "
                f"{delayed_error.get('exception_name')} (code {delayed_error.get('exception_code')}, "
                f"index {delayed_error.get('exception_index')})"
            )
        if send_id is not None:
            _ai_flightplan_pending[send_id] = {
                "object_id": int(object_id), "phase": phase, "path": str(path),
                "created_at": now, "exception": None,
            }
        if record is not None:
            record["flight_phase"] = phase
            record["flight_started_at"] = now
            record["flight_seen_airborne"] = False
            record["arrival_candidate_since"] = None
            record["flight_plan_path"] = str(path)
            record["flightplan_send_id"] = send_id
            record["missing_traffic_samples"] = 0
            record["last_traffic_position"] = None
    log.info(
        "Plan IA accepté à l'envoi : objet=%s, phase=%s, send_id=%s, fichier=%s ; attente confirmation MSFS",
        object_id, phase, send_id, path,
    )
    _emit_ai_result({
        "type": "aiTrafficFlightPlan", "ok": True,
        "object_id": int(object_id), "phase": phase,
        "message": "Commande envoyée à MSFS. En attente de confirmation du déplacement réel de l'avion."
    })


def _holding_requires_runway_flip(layout, holding_point, runway_heading_deg, min_offset_m=60.0):
    """Indique si le point d'attente visé dessert l'extrémité OPPOSÉE à celle du cap donné.

    Retourne True (inverser la piste), False (même extrémité) ou None (indéterminé :
    point d'attente trop proche du milieu de la piste ou piste introuvable dans le graphe).
    Le point d'attente d'une piste se trouve derrière son seuil de départ : si le cap est
    070°, l'attente est côté 250° ; si elle est côté 070°, c'est la piste 25 qui est utilisée.
    """
    try:
        heading = float(runway_heading_deg) % 360.0
        ref = layout.get("airport_reference") or {}
        lat0, lon0 = float(ref["lat"]), float(ref["lon"])
        cos_lat = math.cos(math.radians(lat0))
        ux, uy = math.sin(math.radians(heading)), math.cos(math.radians(heading))

        def to_xy(lat, lon):
            return (float(lon) - lon0) * 111320.0 * cos_lat, (float(lat) - lat0) * 110574.0

        hx, hy = to_xy(holding_point["lat"], holding_point["lon"])
        nodes = {int(n["index"]): n for n in layout.get("nodes", [])}
        aligned = []
        for edge in layout.get("runway_edges", []):
            a, b = nodes.get(int(edge["start"])), nodes.get(int(edge["end"]))
            if a is None or b is None:
                continue
            ax, ay = to_xy(a["lat"], a["lon"])
            bx, by = to_xy(b["lat"], b["lon"])
            seg_heading = math.degrees(math.atan2(bx - ax, by - ay)) % 180.0
            diff = abs((seg_heading - heading % 180.0 + 90.0) % 180.0 - 90.0)
            if diff > 25.0:
                continue
            mx, my = (ax + bx) / 2.0, (ay + by) / 2.0
            lateral = abs((mx - hx) * uy - (my - hy) * ux)
            aligned.append((lateral, (ax, ay), (bx, by)))
        centre_along = 0.0  # repli : point de référence de l'aérodrome
        if aligned:
            best = min(item[0] for item in aligned)
            along = [x * ux + y * uy for lat, p1, p2 in aligned if lat <= best + 40.0 for (x, y) in (p1, p2)]
            centre_along = (min(along) + max(along)) / 2.0
        offset = (hx * ux + hy * uy) - centre_along
        if abs(offset) < float(min_offset_m):
            return None
        return offset > 0.0
    except Exception:
        return None


def _reciprocal_runway_designator(designator):
    """07 -> 25, 13 -> 31, 18 -> 36, 07L -> 25R."""
    match = re.fullmatch(r"(\d{1,2})([LRC]?)", str(designator or "").strip().upper())
    if not match:
        return str(designator or "")
    reciprocal = (int(match.group(1)) + 17) % 36 + 1
    return f"{reciprocal:02d}{ {'L': 'R', 'R': 'L', 'C': 'C', '': ''}[match.group(2)] }"


def _airborne_control_enabled():
    """traffic_ia_config.json : "airborne_waypoint_control" (défaut : vrai)."""
    try:
        return bool((_traffic_engine.config or {}).get("airborne_waypoint_control", True))
    except Exception:
        return True


def _nm_between(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 3440.065 * math.asin(min(1.0, math.sqrt(h)))


def _run_airborne_stage(sm, object_id, record, item, trip, now, phase="local_circuit"):
    """Pilote le circuit en vol par waypoints explicites.

    1) « pending » : après le décollage ATC (>= 200 ft AGL, < 2,5 NM), l'ATC est
       libéré et la liste de waypoints tours de piste est envoyée.
    2) « waypoints » : à proximité du dernier point (ou délai dépassé), le PLN ATC
       est renvoyé : l'ATC MSFS fait l'approche, l'atterrissage et le roulage.
    Retourne True si l'avion a été traité ici (le reste de la logique est sauté).
    """
    if phase == "local_circuit":
        plan = record.get("airborne_plan")
    else:
        plan = (trip.get("airborne_legs") or {}).get(phase)
    if not plan or plan.get("stage") not in ("pending", "waypoints"):
        return False
    # Aérodrome de départ de ce tronçon : le retour part de la destination.
    airport = trip["departure"] if phase == "outbound" else trip["destination"]
    try:
        lat, lon = float(item["lat"]), float(item["lon"])
        agl = float(item.get("altitude", 0.0)) - float(airport.altitude_ft)
    except (KeyError, TypeError, ValueError):
        return False
    if plan["stage"] == "pending":
        dist_nm = _nm_between(lat, lon, airport.latitude, airport.longitude)
        if phase == "local_circuit":
            # Tours de oiste : l'ATC MSFS fait voler l'avion très bas (~100-300 ft)
            # et il peut ne jamais franchir 200 ft AGL à moins de 2,5 NM. On prend donc la main
            # dès que l'avion est réellement en l'air, sans exiger une montée préalable.
            min_agl, max_dist_nm = 60.0, 10.0
        else:
            min_agl, max_dist_nm = 200.0, 2.5
        if agl < min_agl or dist_nm > max_dist_nm:
            if now - float(plan.get("_wait_log_at", 0.0)) >= 20.0:
                plan["_wait_log_at"] = now
                log.info("Route aérienne IA en attente : objet=%s, hauteur=%.0f ft (seuil %.0f), distance=%.1f NM (max %.1f)",
                         object_id, agl, min_agl, dist_nm, max_dist_nm)
            return False
        if plan.get("kind") == "circuit" and circuit_route_points is not None:
            # Piste réellement utilisée par l'ATC (cap de montée), pas celle prévue par l'app.
            tracker = record.get("radio_tracker")
            actual = float(getattr(tracker, "runway_heading", plan.get("runway_heading", 0.0)))
            climb_heading = float(item.get("heading", actual)) % 360.0
            if dist_nm <= 2.5 and abs((climb_heading - actual + 180.0) % 360.0 - 180.0) > 90.0:
                actual = (actual + 180.0) % 360.0
            if abs((actual - float(plan.get("runway_heading", actual)) + 180.0) % 360.0 - 180.0) > 90.0:
                try:
                    plan["points"] = circuit_route_points(
                        airport, actual, circuit_direction=plan.get("direction", "left"),
                        circuit_count=AI_CIRCUIT_LAPS)
                    log.info("Piste ATC opposée à la piste prévue : circuit recalculé sur le cap %.0f° (objet %s)",
                             actual, object_id)
                except Exception as rebuild_exc:
                    log.warning("Circuit non recalculé (%s)", rebuild_exc)
                plan["runway_heading"] = actual
        try:
            sm._traffic_ai_waypoint_datatype = SIMCONNECT_DATATYPE.SIMCONNECT_DATATYPE_WAYPOINT
            sm._traffic_ai_unused = SIMCONNECT_UNUSED
            if not plan.get("_atc_released_at"):
                release_atc_control(sm, object_id)
                plan["_atc_released_at"] = now
                log.info("Contrôle ATC libéré : objet=%s, envoi des waypoints dans 2 s", object_id)
                return True
            if now - float(plan["_atc_released_at"]) < 2.0:
                return True
            points = [RoutePoint(latitude=p["lat"], longitude=p["lon"], altitude_ft=p["alt_agl_ft"],
                                 speed_kt=p["speed_kt"], on_ground=False, altitude_is_agl=True,
                                 compute_vertical_speed=True) for p in plan["points"]]
            sent = send_airborne_route(sm, object_id, points, release_atc=False)
        except Exception as exc:
            plan["stage"] = "failed"
            log.error("Route aérienne IA impossible pour %s : %s (le plan ATC est rendu à l'avion)", object_id, exc)
            # AIReleaseControl a pu réussir avant l'échec : sans cela l'avion reste sans pilote.
            try:
                _send_ai_flightplan(sm, object_id, plan["atc_path"], phase)
            except Exception as restore_exc:
                log.error("Reprise ATC impossible après échec pour %s : %s", object_id, restore_exc)
            _emit_ai_result({"type": "aiTrafficFlightPlan", "ok": False, "object_id": object_id,
                             "phase": phase, "message": f"Route aérienne impossible : {exc}"})
            return False
        plan["stage"] = "waypoints"
        plan["started_at"] = now
        label = record.get("mission") if phase == "local_circuit" else phase
        log.info("Route aérienne IA envoyée : objet=%s, %s waypoints, étape=%s, hauteur=%.0f ft, distance=%.1f NM",
                 object_id, sent.get("waypoint_count"), label, agl, dist_nm)
        _emit_ai_result({"type": "aiTrafficFlightPlan", "ok": True, "object_id": object_id,
                         "phase": phase,
                         "message": f"Décollage effectué ; {sent.get('waypoint_count')} waypoints envoyés ({label})."})
        return True
    last = plan["points"][-1]
    near_end = _nm_between(lat, lon, last["lat"], last["lon"]) <= 0.3
    timed_out = now - float(plan.get("started_at", now)) > float(plan.get("max_seconds", 1800.0))
    if not (near_end or timed_out):
        return True
    try:
        _send_ai_flightplan(sm, object_id, plan["atc_path"], phase)
        plan["stage"] = "atc_landing"
        log.info("Fin de route aérienne IA (%s) : objet=%s ; l'ATC MSFS reprend pour l'atterrissage",
                 "délai dépassé" if timed_out and not near_end else "dernier waypoint atteint", object_id)
    except Exception as exc:
        plan["stage"] = "failed"
        log.error("Reprise ATC impossible en fin de route aérienne pour %s : %s", object_id, exc)
        _emit_ai_result({"type": "aiTrafficFlightPlan", "ok": False, "object_id": object_id,
                         "phase": phase, "message": f"Reprise ATC impossible : {exc}"})
    return True


def _process_ai_flightplans(sm, read_traffic=None):
    """Assigne les plans puis déclenche automatiquement le retour après l'arrivée."""
    global _ai_flight_monitor_last
    try:
        command = _ai_flightplan_queue.get_nowait()
    except queue.Empty:
        command = None
    if command and command.get("phase") in ("local_circuit", "outbound") and not command.get("_departure_slot_taken"):
        try:
            icao_dep = command["departure"].icao
            wait_s = _ai_departure_wait_seconds(command["object_id"], icao_dep)
            if wait_s > 0:
                if not command.get("_departure_wait_logged"):
                    command["_departure_wait_logged"] = True
                    minutes = max(1, int(math.ceil(wait_s / 60.0)))
                    log.info("Avion IA %s en attente de départ à %s (environ %s min)", command["object_id"], icao_dep, minutes)
                    _emit_ai_result({"type": "aiTrafficFlightPlan", "ok": True,
                        "object_id": int(command["object_id"]), "phase": "local_circuit",
                        "message": f"Départ échelonné : cet avion quittera le parking dans environ {minutes} min."})
                _ai_flightplan_queue.put(command)
                command = None
            else:
                command["_departure_slot_taken"] = True
                _ai_last_departure_at[str(icao_dep).strip().upper()] = time.time()
        except Exception as wait_exc:
            log.debug("Contrôle du départ échelonné IA ignoré : %s", wait_exc)
    if command:
        try:
            object_id = int(command["object_id"])
            phase = command.get("phase", "outbound")
            taxi_started = False
            taxi_deferred = False
            # Pour un circuit local ou un vol vers l'aérodrome le plus proche,
            # une route automatique peut guider l'avion du parking jusqu'au
            # point d'attente. L'ATC MSFS reprend ensuite la main : sans ce
            # roulage, l'ATC IA laisse parfois l'avion bloqué avant l'alignement
            # (observé sur les phases outbound : LFRU→LFRJ, LFCD→LFCH).
            if phase in ("local_circuit", "outbound") and callable(read_traffic):
                try:
                    try:
                        snapshot = read_traffic(75000)
                    except TypeError:
                        snapshot = read_traffic()
                    aircraft = next((x for x in (snapshot or []) if int(x.get("id", -1)) == object_id), None)
                    if aircraft is None:
                        deadline = float(command.setdefault("_traffic_wait_deadline", time.time() + 15.0))
                        if time.time() < deadline:
                            _ai_flightplan_queue.put(command)
                            taxi_deferred = True
                        else:
                            log.warning("Télémétrie de l'avion IA %s absente après 15 s ; repli sur l'ATC MSFS", object_id)
                    if aircraft and aircraft.get("on_ground"):
                        icao = command["departure"].icao
                        aircraft_position = {"lat": aircraft["lat"], "lon": aircraft["lon"]}
                        matched = None
                        manager = _airport_facility_manager
                        # Données natives de l'aérodrome chargé dans MSFS.
                        # Le Bridge attend leur réponse asynchrone avant de choisir une route.
                        if manager is not None:
                            layout = manager.get(icao)
                            if layout is None:
                                deadline = float(command.setdefault("_facility_wait_deadline", time.time() + 25.0))
                                try:
                                    manager.request_airport(sm, icao)
                                except Exception as facility_exc:
                                    log.warning("Lecture Facility Data indisponible pour %s : %s", icao, facility_exc)
                                    command["_facility_wait_deadline"] = time.time()
                                    deadline = time.time()
                                if time.time() < deadline:
                                    if not command.get("_facility_wait_logged"):
                                        log.info("Récupération automatique des voies MSFS pour %s ; attente des données SimConnect", icao)
                                        command["_facility_wait_logged"] = True
                                    _ai_flightplan_queue.put(command)
                                    taxi_deferred = True
                                else:
                                    log.warning("Données d'aérodrome MSFS non reçues pour %s après 25 s", icao)
                            else:
                                matched = plan_taxi_route(layout, aircraft_position, max_start_distance_m=45.0)
                                if matched:
                                    log.info("Graphe MSFS %s : %s nœuds, %s liaisons roulables, %s segments de piste interdits ; route automatique %s (raccord %.1f m, trajet %.1f m)",
                                        icao, len(layout.get("nodes", [])), len(layout.get("edges", [])), len(layout.get("runway_edges", [])),
                                        matched["route_id"], matched["distance_m"], matched["taxi_distance_m"])
                                else:
                                    log.warning("Graphe MSFS %s chargé mais aucun chemin sûr parking/position → point d'attente n'a été trouvé", icao)
                        if matched:
                            points = matched.get("taxi_points") or []
                            # La route automatique est limitée au HOLD_SHORT :
                            # aucune entrée de piste n'est envoyée.
                            taxi_points = [RoutePoint(
                                latitude=float(p["lat"]), longitude=float(p["lon"]),
                                altitude_ft=float(aircraft.get("altitude", command["departure"].altitude_ft)),
                                speed_kt=4.0, on_ground=True)
                                for p in points]
                            if len(taxi_points) >= 2 and points[-1].get("point_type") == "holding":
                                sm._traffic_ai_waypoint_datatype = SIMCONNECT_DATATYPE.SIMCONNECT_DATATYPE_WAYPOINT
                                sm._traffic_ai_unused = SIMCONNECT_UNUSED
                                sent = send_ground_route(sm, object_id, taxi_points, release_atc=True)
                                holding_point = points[-1]
                                with _ai_pending_lock:
                                    record = _ai_object_records.get(object_id)
                                    if record is not None:
                                        record["round_trip"] = command
                                        record["flight_phase"] = "taxi_out"
                                        record["taxi_source_phase"] = phase
                                        record["taxi_route_id"] = matched["route_id"]
                                        record["taxi_route_source"] = matched.get("source", "MSFS_SIMCONNECT_FACILITY_DATA")
                                        record["taxi_holding_anchor"] = {"lat": float(holding_point["lat"]), "lon": float(holding_point["lon"])}
                                        record["taxi_hold_since"] = None
                                        record["taxi_started_at"] = time.time()
                                        record["last_traffic_position"] = None
                                        tracker = record.get("radio_tracker")
                                        if tracker is not None:
                                            tracker.holding_position = (float(holding_point["lat"]), float(holding_point["lon"]))
                                            # La piste annoncée doit être celle que dessert réellement le
                                            # point d'attente atteint (pas celle proposée au lancement).
                                            flip = _holding_requires_runway_flip(layout, holding_point, tracker.runway_heading)
                                            if flip:
                                                tracker.runway_heading = (float(tracker.runway_heading) + 180.0) % 360.0
                                                tracker.runway_flipped = True
                                                record["runway_heading_deg"] = tracker.runway_heading
                                                log.info("Point d'attente %s côté opposé : piste ramenée à %.0f° (objet %s)",
                                                         matched["route_id"], tracker.runway_heading, object_id)
                                taxi_started = True
                                log.info("Roulage IA direct engagé : objet=%s route=%s source=%s (%s points), arrêt prévu au point d'attente ; résultat=%s",
                                         object_id, matched["route_id"], matched.get("source", "MSFS_SIMCONNECT_FACILITY_DATA"), sent["waypoint_count"], sent)
                                _emit_ai_result({"type": "aiTrafficFlightPlan", "ok": True,
                                    "object_id": object_id, "phase": "taxi_out",
                                    "message": f"Roulage guidé par le réseau MSFS jusqu'au point d'attente ({matched['route_id']})."})
                except Exception as taxi_exc:
                    log.warning("Roulage guidé indisponible pour l'objet %s ; retour au pilotage ATC MSFS : %s", object_id, taxi_exc)
            if not taxi_started and not taxi_deferred:
                _send_ai_flightplan(sm, object_id, command["outbound_path"], phase)
                with _ai_pending_lock:
                    record = _ai_object_records.get(object_id)
                    if record is not None:
                        record["round_trip"] = command
                _emit_ai_result({"type": "aiTrafficFlightPlan", "ok": True,
                                 "object_id": object_id, "phase": phase,
                                 "message": (f"Circuit de piste lancé à {command['departure'].icao} par l'ATC MSFS." if phase == "local_circuit" else f"Vol aller {command['departure'].icao} → {command['destination'].icao} lancé.")})
        except Exception as exc:
            log.warning("Affectation plan de vol IA impossible : %s", exc)
            _emit_ai_result({"type": "aiTrafficFlightPlan", "ok": False,
                             "object_id": command.get("object_id"), "message": str(exc)})

    now = time.time()
    # Une commande SimConnect peut être acceptée à l'envoi puis rejetée
    # quelques instants plus tard. Ne jamais confondre HRESULT positif et succès ATC.
    failed_plans = []
    with _ai_pending_lock:
        for send_id, pending in list(_ai_flightplan_pending.items()):
            if pending.get("exception"):
                failed_plans.append((send_id, pending))
                _ai_flightplan_pending.pop(send_id, None)
    # Aucun accusé positif standard n'est émis pour AISetAircraftFlightPlan :
    # après 3 minutes sans exception, on libère seulement le suivi du SendID.
    # Le statut du vol reste surveillé séparément par la télémétrie objet.
    expired_plans = []
    with _ai_pending_lock:
        for send_id, pending in list(_ai_flightplan_pending.items()):
            if now - float(pending.get("created_at", now)) > 180.0:
                expired_plans.append((send_id, pending))
                _ai_flightplan_pending.pop(send_id, None)
    for send_id, pending in expired_plans:
        log.info("Fin surveillance exception plan IA : objet=%s, SendID=%s ; aucune exception différée reçue (cela ne confirme pas le déplacement)",
                 pending.get("object_id"), send_id)

    for send_id, pending in failed_plans:
        oid = pending["object_id"]
        err = pending["exception"]
        with _ai_pending_lock:
            rec = _ai_object_records.get(oid)
            if rec is not None:
                rec["flight_phase"] = "parked"
                rec["round_trip"] = None
                rec["flightplan_error"] = err
        message = (f"MSFS a rejeté le plan de vol de l'objet {oid} : "
                   f"{err.get('exception_name')} (code {err.get('exception_code')}, "
                   f"index {err.get('exception_index')}, SendID {send_id}).")
        log.error(message)
        _emit_ai_result({"type": "aiTrafficFlightPlan", "ok": False,
                         "object_id": oid, "phase": pending.get("phase"), "message": message})

    if not callable(read_traffic) or now - _ai_flight_monitor_last < 5.0:
        return
    _ai_flight_monitor_last = now
    try:
        traffic = read_traffic(75000)
    except TypeError:
        traffic = read_traffic()
    except Exception as exc:
        log.debug("Surveillance vol IA différée : %s", exc)
        return
    by_id = {}
    for item in traffic or []:
        try:
            by_id[int(item.get("id", -1))] = item
        except (TypeError, ValueError):
            continue

    with _ai_pending_lock:
        records = [(oid, dict(rec)) for oid, rec in _ai_object_records.items()
                   if rec.get("round_trip") and rec.get("flight_phase") in ("taxi_out", "outbound", "return", "local_circuit")]
    for object_id, record in records:
        item = by_id.get(object_id)
        if not item:
            missing = int(record.get("missing_traffic_samples", 0)) + 1
            with _ai_pending_lock:
                current = _ai_object_records.get(object_id)
                if current is not None:
                    current["missing_traffic_samples"] = missing
            if missing == 1 or missing % 3 == 0:
                log.warning(
                    "Objet IA absent de la lecture trafic : objet=%s, immat=%s, phase=%s, absences=%s ; objet non supprimé par FlyFranceVFR",
                    object_id, record.get("tail_number"), record.get("flight_phase"), missing,
                )
            if missing >= 3 and not record.get("traffic_missing_reported"):
                with _ai_pending_lock:
                    current = _ai_object_records.get(object_id)
                    if current is not None:
                        current["traffic_missing_reported"] = True
                message = (f"L'avion IA {record.get('tail_number')} (objet {object_id}) n'est plus visible dans la lecture trafic SimConnect. "
                           "FlyFranceVFR ne l'a pas supprimé ; vérifie s'il a disparu dans MSFS.")
                _emit_ai_result({"type": "aiTrafficFlightPlan", "ok": False,
                                 "object_id": object_id, "phase": record.get("flight_phase"), "message": message})
            continue
        with _ai_pending_lock:
            current = _ai_object_records.get(object_id)
            if current is not None:
                current["missing_traffic_samples"] = 0
                current["traffic_missing_reported"] = False
                previous = current.get("last_traffic_position")
                position = (round(float(item.get("lat", 0)), 6), round(float(item.get("lon", 0)), 6),
                            round(float(item.get("altitude", 0)), 1), round(float(item.get("ground_speed", 0)), 1))
                if previous != position:
                    heading = float(item.get("heading", 0.0)) % 360.0
                    runway_heading = current.get("runway_heading_deg")
                    axis_error = None
                    if runway_heading is not None:
                        axis_error = runway_axis_deviation(heading, runway_heading)
                    on_ground = bool(item.get("on_ground"))
                    speed = float(item.get("ground_speed", 0.0))
                    ground_state = classify_ground_state(
                        on_ground, speed, heading,
                        float(runway_heading) if runway_heading is not None else None,
                    )
                    log.info(
                        "Mouvement IA observé : objet=%s, immat=%s, phase=%s, lat=%s, lon=%s, alt=%s ft, sol=%s, vitesse=%s kt, cap_vrai=%.1f°, axe_piste=%s, ecart_axe=%s°, diagnostic_sol=%s",
                        object_id, record.get("tail_number"), record.get("flight_phase"),
                        position[0], position[1], position[2], on_ground, position[3], heading,
                        (round(float(runway_heading), 1) if runway_heading is not None else "inconnu"),
                        (round(axis_error, 1) if axis_error is not None else "inconnu"), ground_state,
                    )
                    if ground_state == "ACCELERATION_HORS_AXE" and current.get("ground_route_last_state") != ground_state:
                        log.warning(
                            "ALIGNEMENT IA SUSPECT : objet=%s, immat=%s, vitesse_sol=%.1f kt, cap=%.1f°, axe_piste=%.1f°, écart=%s°. Vérifier la route taxiway/scène MSFS ; aucun changement automatique de trajectoire n'est appliqué.",
                            object_id, record.get("tail_number"), speed, heading,
                            float(runway_heading), round(axis_error, 1),
                        )
                    current["ground_route_last_state"] = ground_state
                    current["last_traffic_position"] = position
                tracker = current.get("radio_tracker") if current is not None else None
                radio_context = dict(current.get("radio_context") or {}) if current is not None else {}
                pilot_profile = dict(current.get("pilot") or {}) if current is not None else {}
            else:
                tracker = None
                radio_context = {}
                pilot_profile = {}
        if tracker is not None and record.get("flight_phase") in ("taxi_out", "local_circuit"):
            try:
                radio_events = tracker.update(
                    lat=float(item.get("lat", 0.0)), lon=float(item.get("lon", 0.0)),
                    heading=float(item.get("heading", 0.0)),
                    ground_speed=float(item.get("ground_speed", 0.0)),
                    on_ground=bool(item.get("on_ground")), now=now,
                )
                with _ai_pending_lock:
                    live = _ai_object_records.get(object_id)
                    live_context = live.get("radio_context") if live else None
                    if live_context is not None and "base_runway_heading" in live_context:
                        base_heading = float(live_context["base_runway_heading"])
                        flipped_now = abs((float(tracker.runway_heading) - base_heading + 180.0) % 360.0 - 180.0) > 90.0
                        if flipped_now != bool(live_context.get("runway_flipped", False)):
                            old_designator = str(live_context.get("runway_designator", ""))
                            base_designator = str(live_context.get("base_runway_designator", old_designator))
                            new_designator = _reciprocal_runway_designator(base_designator) if flipped_now else base_designator
                            live_context["runway_designator"] = new_designator
                            # Point d'attente : recalculé côté appli depuis la piste réellement utilisée.
                            live_context["holding_full"] = "" if flipped_now else str(live_context.get("base_holding_full", ""))
                            live_context["runway_flipped"] = flipped_now
                            live["runway_heading_deg"] = float(tracker.runway_heading) % 360.0
                            radio_context = dict(live_context)
                            log.info("Piste utilisée par l'ATC : %s au lieu de %s (objet %s)",
                                     new_designator, old_designator, object_id)
                for event_id in radio_events:
                    log.info("Radio A/A IA : objet=%s, indicatif=%s, événement=%s",
                             object_id, pilot_profile.get("callsign", record.get("tail_number", "F-XXXX")), event_id)
                    _emit_ai_result({
                        "type": "aiRadioEvent", "event_id": event_id,
                        "object_id": object_id,
                        "airport_icao": radio_context.get("airport_icao", record.get("airport_icao", "")),
                        "airport_name": radio_context.get("airport_name", "Aérodrome"),
                        "runway_designator": radio_context.get("runway_designator", ""),
                        "holding_full": radio_context.get("holding_full", ""),
                        "circuit_direction": radio_context.get("circuit_direction", "left"),
                        "mission": radio_context.get("mission", "circuit"),
                        "pilot_id": pilot_profile.get("id", "pilot-01"),
                        "callsign": pilot_profile.get("callsign", record.get("tail_number", "F-XXXX")),
                        "voice": pilot_profile.get("voice", ""),
                        "aircraft_model": record.get("model", "avion"),
                    })
            except Exception as radio_exc:
                log.debug("Suivi radio A/A IA différé pour %s : %s", object_id, radio_exc)
        trip = record["round_trip"]
        phase = record.get("flight_phase")
        if phase == "taxi_out":
            anchor = record.get("taxi_holding_anchor") or {}
            try:
                dlat = (float(item["lat"]) - float(anchor["lat"])) * 111320.0
                dlon = (float(item["lon"]) - float(anchor["lon"])) * 111320.0 * math.cos(math.radians(float(item["lat"])))
                distance_to_hold = math.hypot(dlat, dlon)
                speed_now = float(item.get("ground_speed", 999.0))
            except (KeyError, TypeError, ValueError):
                distance_to_hold, speed_now = 9999.0, 999.0
            if bool(item.get("on_ground")) and distance_to_hold <= 12.0 and speed_now <= 2.5:
                with _ai_pending_lock:
                    current = _ai_object_records.get(object_id)
                    if current is not None and current.get("taxi_hold_since") is None:
                        current["taxi_hold_since"] = now
                    hold_since = current.get("taxi_hold_since") if current is not None else None
                # Laisser le temps à l'annonce radio du point d'attente avant de
                # rendre l'avion à l'ATC MSFS pour l'alignement et le décollage.
                if hold_since is not None and now - float(hold_since) >= 5.0:
                    try:
                        resume_phase = str(record.get("taxi_source_phase") or "local_circuit")
                        _send_ai_flightplan(sm, object_id, trip["outbound_path"], resume_phase)
                        _emit_ai_result({"type": "aiTrafficFlightPlan", "ok": True,
                            "object_id": object_id, "phase": resume_phase,
                            "message": f"Point d'attente atteint ({record.get('taxi_route_id')}). Annonce radio effectuée ; l'ATC MSFS reprend la main pour l'entrée de piste et le décollage."})
                    except Exception as taxi_handoff_exc:
                        log.error("Reprise ATC impossible après roulage guidé pour %s : %s", object_id, taxi_handoff_exc)
                        _emit_ai_result({"type": "aiTrafficFlightPlan", "ok": False,
                            "object_id": object_id, "phase": "taxi_out", "message": f"Roulage arrivé au point d'attente mais reprise ATC impossible : {taxi_handoff_exc}"})
                        with _ai_pending_lock:
                            current = _ai_object_records.get(object_id)
                            if current is not None:
                                current["flight_phase"] = "parked"
                                current["round_trip"] = None
            else:
                with _ai_pending_lock:
                    current = _ai_object_records.get(object_id)
                    if current is not None:
                        current["taxi_hold_since"] = None
            continue
        if not item.get("on_ground"):
            with _ai_pending_lock:
                if object_id in _ai_object_records:
                    _ai_object_records[object_id]["flight_seen_airborne"] = True
            if phase in ("local_circuit", "outbound", "return"):
                _run_airborne_stage(sm, object_id, record, item, trip, now, phase)
            continue
        if not record.get("flight_seen_airborne"):
            # Chien de garde : avion immobile > 240 s près du terrain, phase de départ -> on renvoie
            # le plan (l'ATC IA de MSFS peut rester bloqué à l'entrée de piste). Les relances
            # répétées sont contre-productives : chaque renvoi du plan remet à zéro le
            # traitement ATC et finit par un rejet OPERATION_INVALID_FOR_OBJECT_TYPE (code 24).
            try:
                still = float(item.get("ground_speed", 99.0)) < 1.0
            except (TypeError, ValueError):
                still = False
            unstick = False
            if phase in ("local_circuit", "outbound", "return"):
                with _ai_pending_lock:
                    current = _ai_object_records.get(object_id)
                    if current is not None:
                        if not still:
                            current["still_since"] = None
                        elif current.get("still_since") is None:
                            current["still_since"] = now
                        elif (now - float(current["still_since"]) > 240.0 and
                              int(current.get("unstick_count", 0)) < 2 and
                              now - float(current.get("flightplan_sent_at", 0.0) or 0.0) > 180.0):
                            current["unstick_count"] = int(current.get("unstick_count", 0)) + 1
                            current["still_since"] = now
                            unstick = True
                if unstick:
                    try:
                        path = (trip.get("outbound_path") if phase == "outbound" else
                                trip.get("inbound_path") if phase == "return" else
                                (record.get("airborne_plan") or {}).get("atc_path"))
                        if path:
                            log.warning("Avion IA %s immobile depuis plus de 240 s avant le décollage : plan renvoyé", object_id)
                            _send_ai_flightplan(sm, object_id, path, phase)
                    except Exception as unstick_exc:
                        log.error("Relance du plan IA impossible pour %s : %s", object_id, unstick_exc)
            continue  # ne pas confondre le parking de départ avec une arrivée
        target = trip["destination"] if phase in ("outbound", "local_circuit") else trip["departure"]
        try:
            arrived = reached_airport(item, target)
        except Exception:
            arrived = False
        if not arrived:
            with _ai_pending_lock:
                if object_id in _ai_object_records:
                    _ai_object_records[object_id]["arrival_candidate_since"] = None
            continue
        # Confirmer le stationnement : avion au sol, presque immobile et resté
        # dans l'emprise de l'aérodrome pendant 45 secondes (pas au toucher).
        try:
            ground_speed = float(item.get("ground_speed", 999.0))
        except (TypeError, ValueError):
            ground_speed = 999.0
        if ground_speed > 1.5:
            with _ai_pending_lock:
                if object_id in _ai_object_records:
                    _ai_object_records[object_id]["arrival_candidate_since"] = None
            continue
        with _ai_pending_lock:
            current = _ai_object_records.get(object_id)
            if current is None:
                continue
            candidate_since = current.get("arrival_candidate_since")
            if candidate_since is None:
                current["arrival_candidate_since"] = now
                continue
        if now - float(candidate_since) < 45.0:
            continue
        if phase == "outbound":
            log.info("Avion IA %s arrivé et stationné à %s ; lancement du vol retour", object_id, target.icao)
            try:
                _send_ai_flightplan(sm, object_id, trip["inbound_path"], "return")
                _emit_ai_result({"type": "aiTrafficFlightPlan", "ok": True,
                                 "object_id": object_id, "phase": "return",
                                 "message": f"Arrivée à {target.icao} confirmée ; retour vers {trip['departure'].icao} lancé."})
            except Exception as exc:
                log.warning("Lancement du retour IA impossible pour %s : %s", object_id, exc)
                _emit_ai_result({"type": "aiTrafficFlightPlan", "ok": False,
                                 "object_id": object_id, "phase": "return", "message": str(exc)})
        else:
            with _ai_pending_lock:
                if object_id in _ai_object_records:
                    _ai_object_records[object_id]["flight_phase"] = "completed"
                    _ai_object_records[object_id]["round_trip"] = None
            _emit_ai_result({"type": "aiTrafficFlightPlan", "ok": True,
                             "object_id": object_id, "phase": "completed",
                             "message": (f"Circuit terminé : avion revenu au parking de {target.icao}." if phase == "local_circuit" else f"Aller-retour terminé : avion revenu au parking de {target.icao}.")})
            log.info("Cycle IA terminé : objet=%s, parking=%s, phase=%s", object_id, target.icao, phase)


def _install_ai_dispatch_hook(sm):
    """Observe les réponses IA tout en conservant le callback original du SDK."""
    if getattr(sm, "_flyfrance_ai_hook_installed", False):
        return

    assigned_id = int(SIMCONNECT_RECV_ID.SIMCONNECT_RECV_ID_ASSIGNED_OBJECT_ID.value)
    exception_id = int(SIMCONNECT_RECV_ID.SIMCONNECT_RECV_ID_EXCEPTION.value)
    original_dispatch = sm.my_dispatch_proc_rd

    def dispatch_with_ai_capture(p_data, cb_data, p_context):
        try:
            # SIMCONNECT_RECV : dwSize, dwVersion, dwID.
            recv_id = int(p_data.contents.dwID)
            if recv_id in (28, 29):  # FACILITY_DATA / FACILITY_DATA_END (protocole MSFS 2020 vérifié)
                manager = _airport_facility_manager
                if manager is not None:
                    try:
                        message_size = int(p_data.contents.dwSize)
                        raw = ctypes.string_at(p_data, message_size)
                        before = set(manager.layouts)
                        manager.handle_message(raw)
                        for icao in set(manager.layouts) - before:
                            layout = manager.layouts[icao]
                            counts = layout.get("counts", {})
                            log.info("Données aérodrome MSFS reçues pour %s : %s points taxi, %s parkings, %s chemins taxi, %s liaisons roulables, %s segments de piste interdits, %s points d'attente ; cache=%s",
                                icao, counts.get("taxi_points", 0), counts.get("parkings", 0),
                                counts.get("taxi_paths", 0), counts.get("usable_edges", 0), counts.get("runway_barriers", 0),
                                counts.get("holding_points", 0), _TRAFFIC_AI_DIR / "airport_data" / f"{icao}_layout.json")
                    except Exception as facility_exc:
                        log.exception("Décodage des données d'aérodrome SimConnect impossible : %s", facility_exc)
            elif recv_id == int(SIMCONNECT_RECV_ID.SIMCONNECT_RECV_ID_SIMOBJECT_DATA.value):
                # Réponse à nos lectures diagnostic : ATC ID + TITLE d'un objet IA.
                data = ctypes.cast(p_data, ctypes.POINTER(ctypes.c_uint32 * 10)).contents
                probe_request_id, probe_object_id, probe_define_count = int(data[3]), int(data[4]), int(data[9])
                with _ai_pending_lock:
                    probe_entry = _ai_atcid_probes.get(probe_request_id)
                    if probe_entry is not None:
                        _ai_atcid_probes.pop(probe_request_id, None)
                if probe_entry is not None:
                    try:
                        probe_size = int(data[0])
                        raw_probe = ctypes.string_at(p_data, probe_size)
                        raw_atc = raw_probe[40:296].split(b"\0", 1)[0].decode("utf-8", errors="replace").strip()
                        raw_title = raw_probe[296:296 + 256].split(b"\0", 1)[0].decode("utf-8", errors="replace").strip()
                        log.info(
                            "Diagnostic immat IA : objet %s #%d — ATC ID lu='%s' (attendu '%s'), TITLE='%s'",
                            probe_entry["object_id"], probe_object_id, raw_atc or "(vide)",
                            probe_entry["reg"], raw_title or "(vide)",
                        )
                        if probe_define_count != 2:
                            log.info("Structure SimConnect inattendue pour le diagnostic immat (defineCount=%s)", probe_define_count)
                    except Exception as probe_exc:
                        log.info(f"Diagnostic immat IA non décodable : {probe_exc}")
            elif recv_id == assigned_id:
                # SIMCONNECT_RECV_ASSIGNED_OBJECT_ID ajoute dwRequestID et dwObjectID.
                data = ctypes.cast(p_data, ctypes.POINTER(ctypes.c_uint32 * 5)).contents
                request_id = int(data[3])
                object_id = int(data[4])
                with _ai_pending_lock:
                    pending = _ai_pending_requests.get(request_id)
                    if pending is not None:
                        pending["object_id"] = object_id
                        pending["completed"] = True
                        log.info(f"Accusé SimConnect IA reçu : request={request_id}, object={object_id}")
            elif recv_id == exception_id:
                # SIMCONNECT_RECV_EXCEPTION : header + dwException + dwSendID + dwIndex.
                data = ctypes.cast(p_data, ctypes.POINTER(ctypes.c_uint32 * 6)).contents
                exception_code, send_id, exception_index = int(data[3]), int(data[4]), int(data[5])
                try:
                    exception_name = SIMCONNECT_EXCEPTION(exception_code).name
                except Exception:
                    exception_name = f"INCONNUE_{exception_code}"
                detail = {
                    "exception_code": exception_code,
                    "exception_name": exception_name,
                    "send_id": send_id,
                    "exception_index": exception_index,
                }
                with _ai_pending_lock:
                    matched = None
                    for pending in _ai_pending_requests.values():
                        if pending.get("send_id") == send_id:
                            matched = pending
                            break
                    flight_pending = _ai_flightplan_pending.get(send_id)
                    if matched is not None:
                        matched["exception"] = detail
                    elif flight_pending is not None:
                        flight_pending["exception"] = detail
                    else:
                        _ai_exception_backlog[send_id] = detail
                log.warning(
                    "Exception SimConnect reçue : %s (code=%s, send_id=%s, index=%s)",
                    exception_name, exception_code, send_id, exception_index,
                )
        except Exception as exc:
            log.exception(f"Capture réponse trafic IA ignorée : {exc}")

        # Appeler le callback C d'origine : aucun événement existant n'est remplacé.
        original_dispatch(p_data, cb_data, p_context)

    callback = sm.dll.DispatchProc(dispatch_with_ai_capture)
    sm._flyfrance_ai_original_dispatch = original_dispatch
    sm._flyfrance_ai_dispatch_proc = callback  # garder la référence ctypes vivante
    sm.my_dispatch_proc_rd = callback
    sm._flyfrance_ai_hook_installed = True
    log.info("Capture des réponses SimConnect IA installée (callback original conservé)")


def _emit_ai_result(payload):
    # L'interface HTML existante ne relaie au module que aiTrafficResult.
    # Normaliser les retours de vol ici évite toute modification du HTML.
    if payload.get('type') in ('aiTrafficFlightAccepted', 'aiTrafficFlightPlan'):
        payload = dict(payload)
        payload['event'] = 'flight'
        payload['original_type'] = payload.get('type')
        payload['type'] = 'aiTrafficResult'
    loop = _loop
    if loop is None or loop.is_closed():
        return
    try:
        asyncio.run_coroutine_threadsafe(broadcast(payload), loop)
    except Exception as exc:
        log.warning(f"Publication résultat trafic IA impossible : {exc}")


def _set_ai_object_atc_id(sm, object_id, registration):
    """Écrit l'immatriculation (ATC ID) directement sur l'objet IA.

    AICreateParkedATCAircraft transmet le tail number pour l'ATC, mais
    MSFS n'applique pas toujours ce numéro à la texture de la livrée :
    la zone immatriculation reste alors un rectangle blanc. Écrire la
    variable ATC ID sur l'objet (SetDataOnSimObject) force MSFS à dessiner
    l'immatriculation sur la livrée (atc_id_enable = 1).
    À appeler depuis le thread SimConnect.
    """
    object_id = int(object_id)
    reg = str(registration or "").strip()
    if object_id <= 0 or not reg:
        return False
    definition = sm.new_def_id()
    definition_value = int(definition.value)
    hr = sm.dll.AddToDataDefinition(
        sm.hSimConnect, definition_value, b"ATC ID", b"",
        SIMCONNECT_DATATYPE.SIMCONNECT_DATATYPE_STRING256, 0.0, SIMCONNECT_UNUSED,
    )
    if not sm.IsHR(hr, 0):
        raise RuntimeError(
            f"AddToDataDefinition ATC ID refusé (HRESULT {int(hr) & 0xffffffff:#010x})"
        )
    buffer = (ctypes.c_char * 256)()  # buffer zero-initialisé : chaîne terminée par 0
    value = reg.encode("ascii", errors="ignore")[:255]
    ctypes.memmove(buffer, value, len(value))
    hr = sm.dll.SetDataOnSimObject(
        sm.hSimConnect, definition_value, object_id, 0,
        1, ctypes.sizeof(buffer), ctypes.cast(buffer, ctypes.c_void_p),
    )
    if not sm.IsHR(hr, 0):
        raise RuntimeError(
            f"SetDataOnSimObject ATC ID refusé (HRESULT {int(hr) & 0xffffffff:#010x})"
        )
    return True


def _send_ai_atcid_probe(sm, object_id, reg):
    """Demande à SimConnect la lecture de ATC ID et TITLE sur l'objet IA.

    Diagnostic : savoir ce que MSFS a réellement retenu (variation et
    immatriculation) quand la livrée reste un rectangle blanc.
    """
    definition_id = sm.new_def_id()
    for name in (b"ATC ID", b"TITLE"):
        hr = sm.dll.AddToDataDefinition(
            sm.hSimConnect, int(definition_id.value), name, None,
            SIMCONNECT_DATATYPE.SIMCONNECT_DATATYPE_STRING256, 0.0, SIMCONNECT_UNUSED,
        )
        if not sm.IsHR(hr, 0):
            raise RuntimeError(
                f"AddToDataDefinition {name.decode()} refusé pour le diagnostic immat "
                f"(HRESULT {int(hr) & 0xffffffff:#010x})"
            )
    request_id = sm.new_request_id()
    # Ordre du wrapper ctypes : hSimConnect, RequestID, DefineID, ObjectID,
    # Period, Flags, origin, interval, limit.
    hr = sm.dll.RequestDataOnSimObject(
        sm.hSimConnect, int(request_id.value), int(definition_id.value), int(object_id),
        int(SIMCONNECT_PERIOD.SIMCONNECT_PERIOD_ONCE.value), 0, 0, 0, 0,
    )
    if not sm.IsHR(hr, 0):
        raise RuntimeError(
            f"RequestDataOnSimObject refusé pour le diagnostic immat objet {object_id} "
            f"(HRESULT {int(hr) & 0xffffffff:#010x})"
        )
    with _ai_pending_lock:
        _ai_atcid_probes[int(request_id.value)] = {"object_id": int(object_id), "reg": str(reg or "")}


def _send_ai_waypoint_list(sm, object_id, waypoints):
    """Envoie un circuit fermé (AI WAYPOINT LIST) à un avion IA en vol."""
    definition = getattr(sm, "_ff_waypoint_definition", None)
    if definition is None:
        definition = sm.new_def_id()
        hr = sm.dll.AddToDataDefinition(
            sm.hSimConnect, int(definition.value), b"AI WAYPOINT LIST", b"number",
            SIMCONNECT_DATATYPE.SIMCONNECT_DATATYPE_WAYPOINT, 0.0, SIMCONNECT_UNUSED,
        )
        if not sm.IsHR(hr, 0):
            raise RuntimeError(
                f"AddToDataDefinition AI WAYPOINT LIST refusé (HRESULT {int(hr) & 0xffffffff:#010x})"
            )
        sm._ff_waypoint_definition = definition
    definition_value = int(definition.value)
    object_id = int(object_id)
    # Après sa création, l'objet appartient encore au pilote IA interne. Le
    # circuit est une commande de notre client SimConnect : il faut donc
    # transférer ce contrôle avant de lui écrire les waypoints, sinon MSFS peut
    # accepter le paquet mais laisser l'avion ralentir jusqu'à l'arrêt.
    release_request = sm.new_request_id()
    hr = sm.dll.AIReleaseControl(sm.hSimConnect, object_id, int(release_request.value))
    if not sm.IsHR(hr, 0):
        raise RuntimeError(
            f"AIReleaseControl refusé objet {object_id} "
            f"(HRESULT {int(hr) & 0xffffffff:#010x})"
        )
    array_items = [AI_WaypointMsfs(
        Latitude=float(w.Latitude), Longitude=float(w.Longitude), Altitude=float(w.Altitude),
        Flags=int(w.Flags), ktsSpeed=float(w.ktsSpeed), percentThrottle=float(w.percentThrottle),
    ) for w in waypoints]
    if not array_items:
        raise ValueError("Liste de waypoints vide")
    # IMPORTANT : construire un VRAI tableau ctypes (pas une liste Python) ;
    # ctypes.cast() sur une liste lève « argument 1: TypeError: wrong type ».
    array = (AI_WaypointMsfs * len(array_items))(*array_items)
    hr = sm.dll.SetDataOnSimObject(
        sm.hSimConnect, definition_value, object_id, 0,
        len(array), ctypes.sizeof(AI_WaypointMsfs),
        array,
    )
    if not sm.IsHR(hr, 0):
        raise RuntimeError(
            f"SetDataOnSimObject AI WAYPOINT LIST refusé objet {object_id} "
            f"(HRESULT {int(hr) & 0xffffffff:#010x})"
        )
    return len(array)


def _process_ai_patrol_waypoints(sm, read_traffic=None):
    """Envoie (avec quelques tentatives) le circuit de patrouille aux avions créés
    en vol ; appelé périodiquement dans le thread SimConnect."""
    global _ai_patrol_probe_schedule
    # Télémétrie : après l'envoi du circuit, on revalide 3 fois (60 s, 3 min, 8 min)
    # que l'avion progresse réellement (vitesse sol > 40 kt au cap attendu).
    current_ts = time.time()
    due_probes = [p for p in _ai_patrol_probe_schedule if current_ts >= p["due"]]
    for probe in due_probes:
        _ai_patrol_probe_schedule.remove(probe)
        if probe["object_id"] not in _ai_object_ids:
            continue
        if not callable(read_traffic):
            continue
        try:
            items = read_traffic()
            own = next((it for it in items if int(it.get("id", -1)) == probe["object_id"]), None)
            if own is None:
                log.warning("Patrouille objet %s introuvable dans le trafic à la sonde %d s", probe["object_id"], probe["delay_s"])
                continue
            gs = float(own.get("ground_speed", float("nan")))
            alt = float(own.get("altitude", float("nan")))
            hdg = float(own.get("heading", float("nan")))
            state = "OK" if gs > 40.0 else "IMMOBILE ou trop lent"
            log.info("Patrouille objet %s (%s) sonde %d s : vitesse_sol=%.1f kt, altitude=%.0f ft, cap=%.0f° — %s",
                     probe["object_id"], probe.get("tail", "?"), probe["delay_s"], gs, alt, hdg, state)
            if gs <= 40.0 and probe["delay_s"] >= 180:
                _emit_ai_result({
                    "type": "aiTrafficResult", "ok": False, "object_id": probe["object_id"], "phase": "patrol-stalled",
                    "message": f"Patrouille {probe.get('tail', probe['object_id'])} immobile détectée ({gs:.0f} kt après {probe['delay_s']} s) — circuit non suivi par MSFS.",
                })
        except Exception as probe_exc:
            log.debug("Sonde patrouille objet %s échec : %s", probe["object_id"], probe_exc)
    if not _ai_patrol_waypoints_pending:
        return
    now = time.time()
    for object_id, entry in list(_ai_patrol_waypoints_pending.items()):
        if now < entry["due"]:
            continue
        if object_id not in _ai_object_ids:
            _ai_patrol_waypoints_pending.pop(object_id, None)
            continue
        try:
            count = _send_ai_waypoint_list(sm, object_id, entry["waypoints"])
            _ai_patrol_waypoints_pending.pop(object_id, None)
            log.info("Circuit de patrouille envoyé à l'objet %s : %d waypoints (%d tours, dernier bouclé)",
                     object_id, count, entry.get("laps", 0))
            for delay_s in (60, 180, 480):
                _ai_patrol_probe_schedule.append({
                    "object_id": object_id, "tail": entry.get("tail"),
                    "delay_s": delay_s, "due": time.time() + delay_s,
                })
            _emit_ai_result({
                "type": "aiTrafficResult", "ok": True,
                "object_id": object_id, "phase": "patrol",
                "message": f"Patrouille active : {count} waypoints envoyés, boucle fermée.",
            })
        except Exception as wpt_exc:
            entry["attempts"] += 1
            if entry["attempts"] >= entry["max_attempts"]:
                _ai_patrol_waypoints_pending.pop(object_id, None)
                log.warning("Envoi du circuit de patrouille objet %s abandonné : %s", object_id, wpt_exc)
                # Sans circuit, l'avion IA reste figé à 0 kt : on le retire.
                try:
                    _queue_ai_remove_aircraft(object_id)
                except Exception as rm_exc:
                    log.debug("Retrait du patrouilleur sans circuit échoué : %s", rm_exc)
                _emit_ai_result({
                    "type": "aiTrafficResult", "ok": False,
                    "object_id": object_id, "phase": "patrol",
                    "message": f"Circuit de patrouille non accepté par MSFS : {wpt_exc} — avion retiré.",
                })
            else:
                entry["due"] = time.time() + 3.0
                log.info("Envoi du circuit de patrouille objet %s réessayé (%d/%d) : %s",
                         object_id, entry["attempts"], entry["max_attempts"], wpt_exc)


def _process_ai_atcid_retries(sm):
    """Réécrit ATC ID sur les objets IA si les premières écritures ont été
    ignorées par le rendu ; appelé dans le thread SimConnect."""
    # Lectures diagnostic différées : ATC ID / TITLE réels des objets IA.
    now_probe = time.time()
    for probe in list(_ai_atcid_probe_schedule):
        if now_probe < probe["due"]:
            continue
        _ai_atcid_probe_schedule.remove(probe)
        if probe["object_id"] not in _ai_object_ids:
            continue
        try:
            _send_ai_atcid_probe(sm, probe["object_id"], probe["reg"])
        except Exception as probe_exc:
            log.info(f"Diagnostic immat IA objet {probe['object_id']} impossible : {probe_exc}")
    if not _ai_atcid_retry_pending:
        return
    now = time.time()
    for object_id, entry in list(_ai_atcid_retry_pending.items()):
        if now < entry["due"]:
            continue
        if object_id not in _ai_object_ids:
            _ai_atcid_retry_pending.pop(object_id, None)
            continue
        with _ai_pending_lock:
            record = _ai_object_records.get(object_id) or {}
        if record.get("removing"):
            _ai_atcid_retry_pending.pop(object_id, None)
            continue
        if entry["attempts"] >= entry["max_attempts"]:
            log.warning(f"Immatriculation IA toujours invisible après {entry['attempts']} écritures sur l'objet {object_id} ({entry['reg']})")
            _ai_atcid_retry_pending.pop(object_id, None)
            continue
        entry["attempts"] += 1
        entry["due"] = now + 12.0
        try:
            if _set_ai_object_atc_id(sm, object_id, entry["reg"]):
                log.info(f"Immatriculation IA réécrite (essai {entry['attempts']}/{entry['max_attempts']}) sur l'objet {object_id} : {entry['reg']}")
        except Exception as atc_exc:
            log.info(f"Réécriture immatriculation IA objet {object_id} attendue par MSFS : {atc_exc}")


def _process_ai_traffic(sm, read_traffic=None):
    """Traite les créations/suppressions IA dans le thread SimConnect existant."""
    global _ai_last_create_started
    _process_ai_flightplans(sm, read_traffic)
    # Réécritures différées de l'immatriculation sur les objets IA.
    try:
        _process_ai_atcid_retries(sm)
    except Exception as atcid_exc:
        log.debug(f"Rattrapage immatriculation IA ignoré : {atcid_exc}")
    # Circuits de patrouille différés (avions créés directement en vol).
    try:
        _process_ai_patrol_waypoints(sm, read_traffic)
    except Exception as patrol_exc:
        log.debug(f"Rattrapage circuit patrouille ignoré : {patrol_exc}")
    # Suppressions : AIRemoveObject ne touche qu'aux ObjectID suivis dans notre registre.
    try:
        remove_command = _ai_remove_queue.get_nowait()
    except queue.Empty:
        remove_command = None
    if remove_command:
        object_id = int(remove_command["object_id"])
        try:
            request = sm.new_request_id()
            request_id = int(request.value)
            hr = sm.dll.AIRemoveObject(sm.hSimConnect, object_id, request_id)
            if not sm.IsHR(hr, 0):
                raise RuntimeError(f"SimConnect refuse la suppression (HRESULT {int(hr) & 0xffffffff:#010x})")
            with _ai_pending_lock:
                record = _ai_object_records.pop(object_id, None)
                _ai_object_ids.discard(object_id)
                _ai_atcid_retry_pending.pop(object_id, None)
                _ai_patrol_waypoints_pending.pop(object_id, None)
            label = (record or remove_command.get("record") or {}).get("tail_number", f"Objet {object_id}")
            message = f"Ordre de suppression envoyé à MSFS pour {label} (objet {object_id})"
            log.info(message)
            _emit_ai_result({"type": "aiTrafficRemoved", "ok": True, "object_id": object_id, "message": message})
        except Exception as exc:
            with _ai_pending_lock:
                if object_id in _ai_object_records:
                    _ai_object_records[object_id]["removing"] = False
            message = f"Suppression de l'avion IA {object_id} impossible : {exc}"
            log.warning(message)
            _emit_ai_result({"type": "aiTrafficRemoved", "ok": False, "object_id": object_id, "message": message})

    # Une seule creation a la fois : MSFS doit terminer l'allocation de la place
    # avant que FlyFranceVFR ne lui demande l'avion suivant.
    command = None
    now_for_spacing = time.time()
    with _ai_pending_lock:
        creation_in_flight = bool(_ai_pending_requests)
    if (not creation_in_flight and
            now_for_spacing - _ai_last_create_started >= AI_CREATE_SPACING_SECONDS):
        try:
            command = _ai_command_queue.get_nowait()
        except queue.Empty:
            command = None

    if command:
        try:
            # Le titre SimObject est celui résolu pour le modèle explicitement
            # demandé (DR400, C172 ou DA40NG). Ne pas le remplacer par un avion tiers
            # déjà présent sur le parking : cela pouvait changer le modèle créé.
            request = sm.new_request_id()
            request_id = int(request.value)
            pending = {
                "command": command,
                "created_at": time.time(),
                "object_id": None,
                "completed": False,
                "published": False,
                "send_id": None,
                "exception": None,
            }
            with _ai_pending_lock:
                _ai_pending_requests[request_id] = pending
            _ai_last_create_started = time.time()
            if command.get("mode") == "patrol":
                # Avion créé directement en vol : la liste de waypoints (circuit
                # fermé) sera envoyée dès l'accusé ASSIGNED_OBJECT_ID reçu.
                # IMPORTANT : AICreateNonATCAircraft attend SIMCONNECT_DATA_INITPOSITION
                # PAR VALEUR (argtypes de la DLL) — un byref() plante le bridge.
                init = command["init"]
                hr = sm.dll.AICreateNonATCAircraft(
                    sm.hSimConnect,
                    command["title"].encode("utf-8"),
                    command["tail_number"].encode("ascii"),
                    SIMCONNECT_DATA_INITPOSITION(
                        Latitude=float(init["lat"]),
                        Longitude=float(init["lon"]),
                        Altitude=float(init["alt"]),
                        Pitch=0.0, Bank=0.0,
                        Heading=float(init["heading"]),
                        OnGround=0,
                        Airspeed=int(init["speed"]),
                    ),
                    request_id,
                )
            else:
                hr = sm.dll.AICreateParkedATCAircraft(
                    sm.hSimConnect,
                    command["title"].encode("utf-8"),
                    command["tail_number"].encode("ascii"),
                    command["airport_icao"].encode("ascii"),
                    request_id,
                )
            if not sm.IsHR(hr, 0):
                with _ai_pending_lock:
                    _ai_pending_requests.pop(request_id, None)
                raise RuntimeError(f"SimConnect refuse la demande (HRESULT {int(hr) & 0xffffffff:#010x})")

            # Associer les exceptions SimConnect au paquet réellement envoyé.
            last_packet = ctypes.c_uint32(0)
            packet_hr = sm.dll.GetLastSentPacketID(sm.hSimConnect, ctypes.byref(last_packet))
            if sm.IsHR(packet_hr, 0):
                with _ai_pending_lock:
                    pending["send_id"] = int(last_packet.value)
                    pending["exception"] = _ai_exception_backlog.pop(int(last_packet.value), None)
                log.info(f"Demande IA envoyée : request={request_id}, send_id={last_packet.value}")
            else:
                log.warning(f"Impossible de lire le SendID SimConnect pour la demande IA (HRESULT {int(packet_hr) & 0xffffffff:#010x})")

            _emit_ai_result({
                "type": "aiTrafficQueued",
                "command_id": command["command_id"],
                "model": command["model"],
                "airport_icao": command["airport_icao"],
                "tail_number": command["tail_number"],
                "simobject_title": command["title"],
                "livery_source": command.get("livery_source"),
                "message": f"Demande envoyée à MSFS pour « {command['title']} » ; attente de l'identifiant objet…",
            })
            log.info(f"Création trafic IA demandée : {command['title']} à {command['airport_icao']} ({command['tail_number']})")
        except Exception as exc:
            log.warning(f"Création trafic IA impossible : {exc}")
            _emit_ai_result({
                "type": "aiTrafficResult",
                "ok": False,
                "command_id": command["command_id"],
                "model": command["model"],
                "airport_icao": command["airport_icao"],
                "tail_number": command["tail_number"],
                "message": str(exc),
            })

    now = time.time()
    completed = []
    with _ai_pending_lock:
        for request_id, pending in list(_ai_pending_requests.items()):
            if pending["completed"] and not pending["published"]:
                pending["published"] = True
                completed.append((request_id, pending, True))
            elif not pending["completed"] and now - pending["created_at"] > 25:
                pending["published"] = True
                completed.append((request_id, pending, False))
        for request_id, pending, _ok in completed:
            _ai_pending_requests.pop(request_id, None)

    for _request_id, pending, ok in completed:
        command = pending["command"]
        if ok:
            object_id = int(pending["object_id"])
            _ai_object_ids.add(object_id)
            # Immatriculation : MSFS néglige le tail number de la demande de
            # création sur la texture ; on écrit ATC ID sur l'objet créé pour
            # que la livrée affiche F-XXXX au lieu d'un rectangle blanc.
            try:
                if _set_ai_object_atc_id(sm, object_id, command["tail_number"]):
                    log.info(f"Immatriculation IA écrite sur l'objet {object_id} : {command['tail_number']}")
                    # MSFS génère la texture d'immatriculation pendant le chargement
                    # de l'avion : réécrire plus tard si la première écriture est
                    # passée trop tôt pour être prise en compte par le rendu.
                    _ai_atcid_retry_pending[object_id] = {
                        "reg": command["tail_number"], "due": time.time() + 8.0,
                        "attempts": 1, "max_attempts": 3,
                    }
                    _ai_atcid_probe_schedule.append(
                        {"object_id": object_id, "reg": command["tail_number"], "due": time.time() + 10.0}
                    )
            except Exception as atc_exc:
                log.warning(f"Immatriculation IA non appliquée à l'objet {object_id} ({command['tail_number']}) : {atc_exc}")
                _ai_atcid_retry_pending[object_id] = {
                    "reg": command["tail_number"], "due": time.time() + 8.0,
                    "attempts": 0, "max_attempts": 3,
                }
            # Précharger automatiquement le graphe de l'aérodrome dès la création
            # du premier avion IA, pour qu'il soit prêt au lancement du circuit.
            # Inutile pour une patrouille en vol (pas de roulage au sol).
            facility_manager = _airport_facility_manager
            if facility_manager is not None and command.get("mode") != "patrol":
                try:
                    facility_manager.request_airport(sm, command["airport_icao"])
                    log.info("Demande automatique des voies/parkings MSFS lancée pour %s", command["airport_icao"])
                except Exception as facility_exc:
                    log.warning("Préchargement des données d'aérodrome %s impossible : %s",
                                command["airport_icao"], facility_exc)
            is_patrol = command.get("mode") == "patrol"
            with _ai_pending_lock:
                _ai_object_records[object_id] = {
                    "object_id": object_id, "model": command["model"],
                    "airport_icao": command["airport_icao"],
                    "tail_number": command["tail_number"], "title": command["title"],
                    "pilot_id": (command.get("pilot") or {}).get("id"),
                    "pilot": dict(command.get("pilot") or {}),
                    "livery_source": command.get("livery_source"),
                    "created_at": float(command.get("created_at", time.time())),
                    "flight_phase": "patrol" if is_patrol else "parked",
                    "patrol": dict(command.get("patrol") or {}),
                    "missing_traffic_samples": 0,
                    "traffic_missing_reported": False,
                    "last_traffic_position": None,
                    "removing": False,
                }
                if is_patrol:
                    # MSFS n'accepte la liste de waypoints qu'une fois l'objet
                    # chargé : envoi différé, avec quelques tentatives de secours.
                    _ai_patrol_waypoints_pending[object_id] = {
                        "waypoints": command.get("waypoints") or [],
                        "laps": ((len(command.get("waypoints") or []) // max(1, int(((command.get("patrol") or {}).get("points")) or 12))) or 1) if isinstance(command.get("patrol"), dict) else 1,
                        "tail": command.get("tail_number"),
                        "due": time.time() + 4.0,
                        "attempts": 0, "max_attempts": 6,
                    }
            # Le simulateur choisit lui-même une place compatible et libre.
            # On compare ensuite la position observee aux autres avions visibles
            # pour reperer les superpositions evidentes dans le perimetre SimConnect.
            position_note = "position du parking en cours de verification"
            try:
                traffic_items = read_traffic() if callable(read_traffic) else []
                own = next((item for item in traffic_items if int(item.get("id", -1)) == object_id), None)
                if own:
                    distances = []
                    for other in traffic_items:
                        if int(other.get("id", -1)) == object_id:
                            continue
                        try:
                            dlat = (float(own["lat"]) - float(other["lat"])) * 111320.0
                            dlon = (float(own["lon"]) - float(other["lon"])) * 111320.0 * math.cos(math.radians(float(own["lat"])))
                            distance = math.hypot(dlat, dlon)
                            if distance < 100.0:
                                distances.append(distance)
                        except (KeyError, TypeError, ValueError):
                            continue
                    nearest = min(distances) if distances else None
                    position_note = (
                        f"position observée ({own['lat']:.6f}, {own['lon']:.6f}), "
                        f"altitude={own.get('altitude', float('nan')):.1f} ft, "
                        f"au_sol={own.get('on_ground')}, vitesse_sol={own.get('ground_speed', float('nan')):.1f} kt, "
                        f"cap={own.get('heading', float('nan')):.1f}°, "
                        + (f"avion le plus proche à {nearest:.1f} m" if nearest is not None else "aucun autre avion proche détecté")
                    )
                    if nearest is not None and nearest < 8.0:
                        log.warning("Position IA potentiellement superposée : %s, objet %s, distance %.1f m", command["tail_number"], object_id, nearest)
                    else:
                        log.info("Position IA contrôlée : %s, objet %s — %s", command["tail_number"], object_id, position_note)
            except Exception as position_exc:
                log.debug("Contrôle position parking IA différé : %s", position_exc)
            message = (
                (f"{command['model']} en patrouille au-dessus de {command['airport_icao']} — "
                 f"objet SimConnect {object_id}, rayon {command.get('patrol', {}).get('radius_nm', '?')} NM, "
                 f"altitude {command.get('patrol', {}).get('altitude_ft', '?')} ft ({position_note})")
                if is_patrol else
                (f"{command['model']} créé au parking de {command['airport_icao']} — "
                 f"objet SimConnect {object_id} ({position_note})")
            )
            log.info(message)
            _emit_ai_result({
                "type": "aiTrafficResult", "ok": True,
                "command_id": command["command_id"], "model": command["model"],
                "airport_icao": command["airport_icao"], "tail_number": command["tail_number"],
                "object_id": object_id, "created_at": float(command.get("created_at", time.time())),
                "pilot_id": (command.get("pilot") or {}).get("id"),
                "pilot": dict(command.get("pilot") or {}),
                "phase": "created-patrol" if is_patrol else "created-parked",
                "message": message,
            })
        else:
            exception = pending.get("exception")
            if exception:
                message = (
                    f"MSFS a renvoyé l'exception SimConnect {exception.get('exception_name', exception['exception_code'])} "
                    f"(index {exception['exception_index']}) pour « {command['title']} ». "
                    "Consulte bridge.log pour le détail ; la création a été refusée par le simulateur."
                )
            else:
                message = (
                    f"Aucun accusé ASSIGNED_OBJECT_ID reçu pour « {command['title']} » après 25 s. "
                    "La demande a été envoyée, mais MSFS n'a pas confirmé la création. "
                    "Le titre SimObject, l'aérodrome et les places de parking restent à vérifier."
                )
            log.warning(message)
            _emit_ai_result({
                "type": "aiTrafficResult", "ok": False,
                "command_id": command["command_id"], "model": command["model"],
                "airport_icao": command["airport_icao"], "tail_number": command["tail_number"],
                "simobject_title": command["title"], "exception": exception,
                "message": message,
            })


async def ws_handler(websocket):
    connected_clients.add(websocket)
    log.info(f"Client WS connecté : {websocket.remote_address}")
    try:
        async for message in websocket:
            try:
                msg = json.loads(message)
                if msg.get('type') == 'save':
                    save_path = get_base_dir() / 'flyfrancevfr_save.json'
                    with open(save_path, 'w', encoding='utf-8') as f:
                        json.dump(msg['data'], f, ensure_ascii=False, indent=2)
                    log.info(f"💾 Sauvegarde : {save_path}")
                elif msg.get('type') == 'load':
                    save_path = get_base_dir() / 'flyfrancevfr_save.json'
                    old_save_path = get_base_dir() / 'flyfrance_save.json'
                    if not save_path.exists() and old_save_path.exists():
                        shutil.copy2(old_save_path, save_path)
                    if save_path.exists():
                        with open(save_path, 'r', encoding='utf-8') as f:
                            data = json.load(f)
                        await websocket.send(json.dumps({'type':'savedata','data':data}))
                        log.info(f"📂 Sauvegarde envoyée")
                    else:
                        await websocket.send(json.dumps({'type':'savedata','data':None}))
                elif msg.get('type') == 'aiCreateParked':
                    try:
                        queued = _queue_ai_parked_aircraft(msg.get('model'), msg.get('airport_icao'))
                        await websocket.send(json.dumps({
                            'type': 'aiTrafficAccepted', 'ok': True, **queued,
                            'message': 'Demande prise en compte par le Bridge.'
                        }, ensure_ascii=False))
                    except Exception as exc:
                        await websocket.send(json.dumps({
                            'type': 'aiTrafficAccepted', 'ok': False,
                            'message': str(exc)
                        }, ensure_ascii=False))
                elif msg.get('type') == 'aiCreatePatrol':
                    try:
                        queued = _queue_ai_patrol_aircraft(
                            msg.get('model'), msg.get('airport'),
                            msg.get('radius_nm'), msg.get('altitude_ft')
                        )
                        await websocket.send(json.dumps({
                            'type': 'aiTrafficAccepted', 'ok': True, **queued,
                            'message': 'Demande de patrouille en vol prise en compte par le Bridge.'
                        }, ensure_ascii=False))
                    except Exception as exc:
                        await websocket.send(json.dumps({
                            'type': 'aiTrafficAccepted', 'ok': False,
                            'message': str(exc)
                        }, ensure_ascii=False))
                elif msg.get('type') == 'aiRemoveObject':
                    try:
                        queued = _queue_ai_remove_aircraft(msg.get('object_id'))
                        await websocket.send(json.dumps({
                            'type': 'aiTrafficRemoveAccepted', 'ok': True, **queued,
                            'message': 'Suppression prise en compte par le Bridge.'
                        }, ensure_ascii=False))
                    except Exception as exc:
                        await websocket.send(json.dumps({
                            'type': 'aiTrafficRemoveAccepted', 'ok': False,
                            'object_id': msg.get('object_id'), 'message': str(exc)
                        }, ensure_ascii=False))
                elif msg.get('type') == 'aiStartLocalCircuit':
                    try:
                        if not _status.get('sim'):
                            raise RuntimeError("SimConnect n'est pas connecté")
                        queued = _queue_ai_local_circuit(
                            msg.get('object_id'), msg.get('airport'),
                            msg.get('runway_heading'), msg.get('circuit_direction', 'left'),
                            msg.get('runway_designator', ''), msg.get('holding_full', '')
                        )
                        await websocket.send(json.dumps({
                            'type': 'aiTrafficResult', 'event': 'flight', 'original_type': 'aiTrafficFlightAccepted', 'ok': True, **queued,
                            'phase': 'local_circuit',
                            'message': f"Circuit VFR préparé à {queued['airport_icao']} ({queued.get('laps')} tours de piste) ; transmission à l'ATC MSFS."
                        }, ensure_ascii=False))
                    except Exception as exc:
                        await websocket.send(json.dumps({
                            'type': 'aiTrafficResult', 'event': 'flight', 'original_type': 'aiTrafficFlightAccepted', 'ok': False,
                            'object_id': msg.get('object_id'), 'phase': 'local_circuit', 'message': str(exc)
                        }, ensure_ascii=False))
                elif msg.get('type') == 'aiStartRoundTrip':
                    try:
                        if not _status.get('sim'):
                            raise RuntimeError("SimConnect n'est pas connecté")
                        queued = _queue_ai_round_trip(
                            msg.get('object_id'), msg.get('departure'), msg.get('destination')
                        )
                        await websocket.send(json.dumps({
                            'type': 'aiTrafficResult', 'event': 'flight', 'original_type': 'aiTrafficFlightAccepted', 'ok': True, **queued,
                            'phase': 'outbound',
                            'message': 'Aller-retour préparé ; attente du thread SimConnect.'
                        }, ensure_ascii=False))
                    except Exception as exc:
                        await websocket.send(json.dumps({
                            'type': 'aiTrafficResult', 'event': 'flight', 'original_type': 'aiTrafficFlightAccepted', 'ok': False,
                            'object_id': msg.get('object_id'), 'message': str(exc)
                        }, ensure_ascii=False))
                elif msg.get('type') == 'trafficIACommand':
                    try:
                        if _traffic_engine is None:
                            raise RuntimeError("Moteur Traffic IA non chargé ; vérifier traffic_AI/traffic_ia_engine.py")
                        action = str(msg.get('action', '')).strip()
                        if action == 'enable':
                            if not _status.get('sim'):
                                raise RuntimeError("SimConnect n'est pas connecté")
                            _traffic_engine.set_enabled(True)
                        elif action == 'disable':
                            _traffic_engine.set_enabled(False)
                            # Nettoyage physique effectué dans le thread SimConnect
                            for object_id in _traffic_engine.take_objects_to_remove():
                                _ai_remove_queue.put({'object_id': object_id, 'command_id': secrets.token_hex(8)})
                        elif action == 'density':
                            _traffic_engine.set_density(str(msg.get('value', 'auto')))
                        elif action == 'follow':
                            _traffic_engine.select_follow(msg.get('pilot_id'))
                        elif action == 'status':
                            pass
                        else:
                            raise ValueError("Action Traffic IA inconnue")
                        await websocket.send(json.dumps({'type':'trafficIAStatus','ok':True,
                            'status':_traffic_engine.status(), 'message':'Commande Traffic IA appliquée.'}, ensure_ascii=False))
                    except Exception as exc:
                        await websocket.send(json.dumps({'type':'trafficIAStatus','ok':False,
                            'message':str(exc), 'status':_traffic_engine.status() if _traffic_engine else None}, ensure_ascii=False))
                elif msg.get('type') == 'radioListenStart':
                    get_radio_recognizer().start()
                elif msg.get('type') == 'radioListenStop':
                    get_radio_recognizer().stop()
            except Exception as e:
                log.warning(f"Erreur message WS : {e}")
    finally:
        connected_clients.discard(websocket)


# ── SimConnect thread ─────────────────────────────────────────────────────────

def simconnect_thread():
    global _prev_on_ground, _vs_buffer, _registration_verify_target, _registration_verify_deadline, _airport_facility_manager
    RECONNECT = 5

    while True:
        sm = None
        try:
            log.info("Connexion à SimConnect...")
            sm = SimConnect()
            _airport_facility_manager = AirportFacilityManager(_TRAFFIC_AI_DIR / "airport_data")
            _install_ai_dispatch_hook(sm)
            aq = AircraftRequests(sm, _time=100)
            xpdr_state_request = Request((b"TRANSPONDER STATE:1", b"Enum"), sm, _time=100)
            try:
                read_traffic = _setup_traffic_reader(sm)
                log.info("Lecture du trafic IA SimConnect activee")
            except Exception as e:
                log.warning(f"Lecture du trafic IA indisponible : {e}")
                read_traffic = lambda radius_m=12000: []
            invalid_samples = 0
            _status["sim"] = False
            log.info("SimConnect ouvert, attente d'un vol MSFS charge...")
            update_tray()

            while True:
                try:
                    _process_ai_traffic(sm, read_traffic)
                    fuel_cmd = _take_fuel_command()
                    if fuel_cmd:
                        try:
                            applied = _apply_fuel_percent(aq, fuel_cmd["percent"])
                            msg = f"Carburant MSFS regle a {fuel_cmd['percent']:.0f}% ({len(applied)} reservoir(s))"
                            _set_fuel_result(True, msg)
                            log.info(msg)
                        except Exception as e:
                            msg = f"Synchronisation carburant echouee : {e}"
                            _set_fuel_result(False, msg)
                            log.warning(msg)

                    payload_cmd = _take_payload_command()
                    if payload_cmd:
                        try:
                            stations, total_kg = _apply_payload(aq, payload_cmd["weights_kg"])
                            msg = f"Charge MSFS reglee a {total_kg:.0f} kg ({stations} station(s))"
                            _set_payload_result(True, msg)
                            log.info(msg)
                        except Exception as e:
                            msg = f"Synchronisation charge echouee : {e}"
                            _set_payload_result(False, msg)
                            log.warning(msg)

                    registration_cmd = _take_registration_command()
                    if registration_cmd:
                        try:
                            reg, keys = _apply_registration(aq, registration_cmd["registration"])
                            with _sim_command_lock:
                                _registration_verify_target = reg
                                # MSFS peut différer la mise à jour de ATC ID pendant
                                # le chargement de l'avion ou le rafraîchissement de la
                                # livrée. Ne pas annoncer un faux échec au bout de 8 s.
                                _registration_verify_deadline = time.time() + 90.0
                            msg = f"Immatriculation envoyee a MSFS: {reg} ({', '.join(keys)}) - attente confirmation telemetrie"
                            _set_registration_result(None, msg)
                            log.info(msg)
                        except Exception as e:
                            msg = f"Synchronisation immatriculation echouee : {e}"
                            _set_registration_result(False, msg)
                            log.warning(msg)

                    lat   = aq.get("PLANE_LATITUDE")
                    lon   = aq.get("PLANE_LONGITUDE")
                    alt   = aq.get("PLANE_ALTITUDE")
                    hdg   = aq.get("PLANE_HEADING_DEGREES_MAGNETIC")
                    hdg_true = _aq_num(aq, "PLANE_HEADING_DEGREES_TRUE")
                    speed = aq.get("AIRSPEED_INDICATED")
                    ground_speed = aq.get("GROUND_VELOCITY")
                    vs    = aq.get("VERTICAL_SPEED")
                    wind_speed = aq.get("AMBIENT_WIND_VELOCITY")
                    wind_dir = aq.get("AMBIENT_WIND_DIRECTION")
                    visibility = aq.get("AMBIENT_VISIBILITY")
                    precip_state = aq.get("AMBIENT_PRECIP_STATE")
                    temperature = aq.get("AMBIENT_TEMPERATURE")
                    qnh = aq.get("SEA_LEVEL_PRESSURE")
                    zulu_time = aq.get("ZULU_TIME")
                    com1 = 0.0
                    com2 = 0.0
                    gnd   = aq.get("SIM_ON_GROUND")
                    parking_brake = None
                    for brake_key in ("BRAKE_PARKING_POSITION", "PARKING_BRAKE_POSITION"):
                        try:
                            parking_brake = aq.get(brake_key)
                            if parking_brake is not None:
                                break
                        except Exception:
                            pass
                    eng   = aq.get("GENERAL_ENG_COMBUSTION:1")
                    rpm   = aq.get("GENERAL_ENG_RPM:1")
                    fuel_qty = aq.get("FUEL_TOTAL_QUANTITY")
                    fuel_cap = aq.get("FUEL_TOTAL_CAPACITY")
                    total_weight = aq.get("TOTAL_WEIGHT")
                    max_weight = aq.get("MAX_GROSS_WEIGHT")

                    raw = aq.get("TITLE")
                    title = raw.decode('utf-8') if isinstance(raw, bytes) else str(raw or "")
                    # Caracteristiques de l'avion (cache par titre, relecture si incomplet) + debit carburant
                    try:
                        _c = _ac_info_cache
                        if title and (title != _c.get("title") or (not (_c.get("info") or {}).get("engines") and time.time() - _c.get("ts", 0) > 10)):
                            _c["title"] = title
                            _c["ts"] = time.time()
                            _c["info"] = _read_aircraft_info(aq)
                        ac_info = _c.get("info") or {}
                    except Exception:
                        ac_info = {}
                    try:
                        fuel_flow_gph = _read_fuel_flow_gph(aq, ac_info.get("engines")) if eng else None
                    except Exception:
                        fuel_flow_gph = None
                    atc_id = ""
                    for atc_key in ("ATC ID", "ATC_ID", "ATC TAIL NUMBER", "ATC REGISTRATION"):
                        try:
                            raw_atc_id = aq.get(atc_key)
                            val = raw_atc_id.decode('utf-8') if isinstance(raw_atc_id, bytes) else str(raw_atc_id or "")
                            val = val.strip()
                            if val:
                                atc_id = val
                                break
                        except Exception:
                            pass
                    with _sim_command_lock:
                        target_reg = _registration_verify_target
                        deadline = _registration_verify_deadline
                    if target_reg:
                        try:
                            current_reg = _normalize_registration(atc_id)
                        except Exception:
                            current_reg = ""
                        if current_reg == target_reg:
                            _set_registration_result(True, f"Immatriculation MSFS confirmee: {target_reg}")
                            with _sim_command_lock:
                                _registration_verify_target = None
                                _registration_verify_deadline = 0
                        elif time.time() > deadline:
                            msg = f"MSFS conserve {current_reg or 'non renseignee'} au lieu de {target_reg}"
                            _set_registration_result(False, msg)
                            log.warning(msg)
                            with _sim_command_lock:
                                _registration_verify_target = None
                                _registration_verify_deadline = 0

                    def to_deg(v, is_hdg=False):
                        if v is None: return 0.0
                        v = float(v)
                        if is_hdg and abs(v) < 7.0:
                            v = math.degrees(v) % 360
                        return v

                    lat_f   = to_deg(lat)
                    lon_f   = float(lon) if lon else 0.0
                    alt_f   = float(alt) if alt else 0.0
                    hdg_f   = to_deg(hdg, is_hdg=True)
                    # Variation magnetique (est positive) = cap vrai - cap magnetique, lue dans MSFS
                    magvar = None
                    if hdg_true is not None:
                        magvar = round(((to_deg(hdg_true, is_hdg=True) - hdg_f + 180) % 360) - 180, 1)
                    speed_f = float(speed) if speed else 0.0
                    ground_speed_f = float(ground_speed) if ground_speed else speed_f
                    vs_f    = float(vs) if vs else 0.0
                    wind_speed_f = float(wind_speed) if wind_speed else 0.0
                    wind_dir_f = to_deg(wind_dir, is_hdg=True)
                    visibility_f = float(visibility) if visibility is not None else None
                    precip_state_f = int(float(precip_state)) if precip_state is not None else 0
                    temperature_f = float(temperature) if temperature is not None else None
                    qnh_f = float(qnh) if qnh is not None else None
                    zulu_seconds_f = float(zulu_time) % 86400.0 if zulu_time is not None else None
                    if qnh_f is not None and qnh_f < 200:
                        qnh_f = qnh_f * 33.8639
                    data_valid = bool(title.strip()) and (41.0 <= lat_f <= 52.0) and (-6.0 <= lon_f <= 10.0)
                    if not data_valid:
                        invalid_samples += 1
                        _status["sim"] = False
                        if invalid_samples == 1 or invalid_samples % 20 == 0:
                            log.info(f"MSFS pas encore pret: title='{title}' lat={lat_f:.5f} lon={lon_f:.5f}")
                        if invalid_samples >= 80:
                            log.info("Donnees MSFS invalides trop longtemps, reconnexion SimConnect...")
                            break
                        time.sleep(0.5)
                        continue
                    invalid_samples = 0
                    _status["sim"] = True
                    if _traffic_engine is not None:
                        try:
                            _traffic_engine.note_simconnect(True)
                            _traffic_engine.update_ownship(lat_f, lon_f, alt_f, hdg_f, ground_speed_f, gnd_f)
                        except Exception as engine_exc:
                            log.debug("Actualisation moteur Traffic IA ignorée : %s", engine_exc)
                    com1 = _read_com_frequency(aq, 1)
                    com2 = _read_com_frequency(aq, 2)
                    xpdr_code = _read_transponder_code(aq)
                    xpdr_state = _read_transponder_state(aq, xpdr_state_request)
                    com_tx, com1_tx, com2_tx = _read_com_transmit(aq)
                    com1_f = float(com1) if com1 else 0.0
                    com2_f = float(com2) if com2 else 0.0
                    gnd_f   = bool(gnd)
                    parking_brake_f = bool(float(parking_brake) > 0.5) if parking_brake is not None else False
                    eng_f   = float(eng) if eng else 0.0
                    rpm_f   = float(rpm) if rpm else 0.0
                    engine_on = bool(eng_f > 0.5 or rpm_f > 250)
                    fuel_qty_f = float(fuel_qty) if fuel_qty else 0.0
                    fuel_cap_f = float(fuel_cap) if fuel_cap else 0.0
                    fuel_pct_f = (fuel_qty_f / fuel_cap_f * 100.0) if fuel_cap_f > 0 else 0.0
                    total_weight_f = float(total_weight) if total_weight else 0.0
                    max_weight_f = float(max_weight) if max_weight else 0.0

                    # Garder un buffer des dernières valeurs VS (avant toucher)
                    if not gnd_f:
                        _vs_buffer.append(vs_f)
                        if len(_vs_buffer) > 10:
                            _vs_buffer.pop(0)

                    # Détecter le touchdown (passage en vol → sol)
                    landing_rate = None
                    if gnd_f and not _prev_on_ground and speed_f > 20:
                        # Prendre la médiane des dernières lectures évite les pics SimConnect isolés.
                        samples = [v for v in _vs_buffer[-5:] if math.isfinite(v)]
                        if samples:
                            ordered = sorted(samples)
                            landing_rate = round(ordered[len(ordered) // 2])
                            raw_min = round(min(samples))
                            log.info(f"🛬 TOUCHDOWN ! Landing rate: {landing_rate} ft/min (pic ignoré: {raw_min} ft/min)")
                        _vs_buffer = []
                    _prev_on_ground = gnd_f

                    _status.update(alt=alt_f, spd=speed_f, hdg=hdg_f)
                    update_tray()

                    data = {
                        "aircraft_title": title,
                        "atc_id": atc_id,
                        "lat": lat_f, "lon": lon_f,
                        "altitude": alt_f, "heading": hdg_f, "magvar": magvar,
                        "speed": speed_f, "ground_speed": ground_speed_f, "vs": vs_f,
                        "wind_speed": wind_speed_f,
                        "wind_direction": wind_dir_f,
                        "visibility_m": visibility_f,
                        "precip_state": precip_state_f,
                        "temperature_c": temperature_f,
                        "qnh_hpa": qnh_f,
                        "zulu_seconds": zulu_seconds_f,
                        "com1_active": com1_f,
                        "com2_active": com2_f,
                        "com_transmit": int(com_tx or 0),
                        "com1_transmit": bool(com1_tx),
                        "com2_transmit": bool(com2_tx),
                        "transponder_code": xpdr_code,
                        "transponder_state": xpdr_state,
                        "transponder_alt": xpdr_state == 4,
                        "on_ground": gnd_f,
                        "parking_brake": parking_brake_f,
                        "engine_on": engine_on,
                        "engine_rpm": rpm_f,
                        "ac_info": ac_info,
                        "fuel_flow_gph": fuel_flow_gph,
                        "fuel_percent": fuel_pct_f,
                        "fuel_gallons": fuel_qty_f,
                        "total_weight_lb": total_weight_f,
                        "max_weight_lb": max_weight_f,
                        "traffic": [
                            item for item in read_traffic(75000)
                            if int(item.get("id", -1)) in _ai_object_ids
                            or abs(float(item.get("lat", 0)) - lat_f) > 0.0002
                            or abs(float(item.get("lon", 0)) - lon_f) > 0.0002
                        ],
                        "ts": time.time(),
                    }
                    if landing_rate is not None:
                        data["landing_rate"] = landing_rate

                    with _data_lock:
                        _latest_data.update(data)
                    if int(time.time()) % 5 == 0:
                        log.info(f"Telemetry {title} lat={lat_f:.5f} lon={lon_f:.5f} alt={alt_f:.0f} hdg={hdg_f:.0f}")

                    time.sleep(0.3)

                except Exception as e:
                    log.warning(f"Erreur lecture : {e}")
                    log.debug("Traceback Erreur lecture comple :", exc_info=True)
                    log.warning(traceback.format_exc())  # diagnostic : ligne exacte de l'erreur
                    break

        except Exception as e:
            log.warning(f"SimConnect indisponible : {e}")

        _airport_facility_manager = None
        _status["sim"] = False
        update_tray()
        if sm:
            try: sm.exit()
            except: pass
        log.info(f"Reconnexion dans {RECONNECT}s...")
        time.sleep(RECONNECT)


# ── Boucle asyncio ────────────────────────────────────────────────────────────

async def broadcast_loop():
    last_ts = 0
    while True:
        if _traffic_engine is not None:
            try:
                state = _traffic_engine.note_simconnect(bool(_status.get("sim")))
                if state == "traffic_stopped":
                    _traffic_engine.take_objects_to_remove()
                    await broadcast({'type':'trafficIAStatus','ok':True,'status':_traffic_engine.status(),
                                     'message':'SimConnect perdu plus de 10 secondes : Traffic IA arrêté. Réactivation manuelle nécessaire.'})
            except Exception as engine_exc:
                log.warning("Surveillance SimConnect Traffic IA : %s", engine_exc)
        await asyncio.sleep(0.3)
        with _data_lock:
            if not _latest_data: continue
            ts = _latest_data.get("ts", 0)
            if ts == last_ts: continue
            last_ts = ts
            data = dict(_latest_data)
        await broadcast(data)

async def async_main():
    log.info(f"WebSocket sur ws://{HOST}:{WS_PORT}")
    async with websockets.serve(ws_handler, HOST, WS_PORT):
        await broadcast_loop()

def run_async():
    global _loop
    _loop = asyncio.new_event_loop()
    asyncio.set_event_loop(_loop)
    _loop.run_until_complete(async_main())


# ── Windows app mode ──────────────────────────────────────────────────────────

def app_window_only(_icon=None, _item=None):
    log.info("FlyFranceVFR fonctionne dans l'application Windows WebView2, sans navigateur externe.")

def quit_app(icon, _item):
    _shutdown_process()

def ensure_single_instance():
    global _single_instance_mutex
    if os.name != "nt":
        return True
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    mutex_name = "Global\\FlyFranceVFR_Bridge_SingleInstance"
    _single_instance_mutex = kernel32.CreateMutexW(None, False, mutex_name)
    already_exists = ctypes.get_last_error() == 183
    if already_exists:
        return False
    return True

def run_tray():
    global _tray_icon
    menu = pystray.Menu(
        pystray.MenuItem("Application Windows active", app_window_only, default=True),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Quitter", quit_app),
    )
    _tray_icon = pystray.Icon("FlyFranceVFR", make_icon(False),
                               "FlyFranceVFR — En attente de MSFS...", menu)
    _tray_icon.run()


# ── Main ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    if not ensure_single_instance():
        sys.exit(0)
    threading.Thread(target=run_http_server, daemon=True).start()
    threading.Thread(target=simconnect_thread, daemon=True).start()
    threading.Thread(target=run_async, daemon=True).start()

    if HAS_TRAY:
        run_tray()
    else:
        try:
            threading.Event().wait()
        except KeyboardInterrupt:
            log.info("Arrêt.")




