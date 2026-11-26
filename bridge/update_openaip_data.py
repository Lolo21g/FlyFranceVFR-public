# -*- coding: utf-8 -*-
"""
update_openaip_data.py

Recree les fichiers data/fr_*.geojson a partir de l'API OpenAIP
(aerodromes, espaces aeriens, navaids, points de report, obstacles pour la France).

Concu pour etre importe et appele EN PROCESS par msfs_bridge_work.py (pas de
subprocess, pas de dependance a un Python externe installe sur le poste client) :

    from update_openaip_data import run_update
    summary = run_update(base_dir, api_key, log=print)

Hypotheses sur l'API OpenAIP Core (a verifier au premier lancement reel - si un
endpoint renvoie 404/401, le message d'erreur inclut le code HTTP + le corps de
la reponse pour diagnostiquer rapidement) :
  - Base URL   : https://api.core.openaip.net/api
  - Auth       : header "x-openaip-api-key: <cle>"
  - Pagination : parametres ?country=FR&limit=1000&page=N
  - Reponse    : {"items": [...], "totalCount": N, "totalPages": N, "page": N, "limit": N}
    chaque item est un objet "plat" avec un champ "geometry" (GeoJSON) + le reste
    des attributs -> on les reconstruit en Feature GeoJSON {geometry, properties}.
"""

import json
import time
import urllib.request
import urllib.error
from pathlib import Path

BASE_URL = "https://api.core.openaip.net/api"
COUNTRY = "FR"
PAGE_LIMIT = 1000
TIMEOUT = 30
MAX_RETRIES = 3

# endpoint OpenAIP -> nom de fichier de sortie
ENDPOINTS = {
    "airports": "fr_apt.geojson",
    "airspaces": "fr_asp.geojson",
    "navaids": "fr_nav.geojson",
    "reporting-points": "fr_rpp.geojson",
    "obstacles": "fr_obs.geojson",
}


def _http_get_json(url, api_key):
    req = urllib.request.Request(
        url,
        headers={
            "x-openaip-api-key": api_key,
            "User-Agent": "FlyFranceVFR-Bridge/1.0",
            "Accept": "application/json",
        },
    )
    last_err = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                raw = resp.read()
            return json.loads(raw.decode("utf-8"))
        except urllib.error.HTTPError as e:
            body = ""
            try:
                body = e.read().decode("utf-8", "replace")[:500]
            except Exception:
                pass
            last_err = RuntimeError(f"HTTP {e.code} sur {url} : {body or e.reason}")
            if e.code in (401, 403, 404):
                raise last_err  # inutile de retenter, l'erreur ne se resoudra pas seule
        except urllib.error.URLError as e:
            last_err = RuntimeError(f"Erreur reseau sur {url} : {e.reason}")
        except Exception as e:
            last_err = RuntimeError(f"Erreur inattendue sur {url} : {e}")
        if attempt < MAX_RETRIES:
            time.sleep(1.5 * attempt)
    raise last_err


def _item_to_feature(item):
    """Convertit un item OpenAIP (plat) en Feature GeoJSON {geometry, properties}."""
    item = dict(item)  # copie, on ne mute pas l'original
    geometry = item.pop("geometry", None)
    return {"type": "Feature", "geometry": geometry, "properties": item}


def fetch_endpoint(endpoint, api_key, log):
    features = []
    page = 1
    total_pages = 1
    while page <= total_pages:
        url = f"{BASE_URL}/{endpoint}?country={COUNTRY}&limit={PAGE_LIMIT}&page={page}"
        data = _http_get_json(url, api_key)
        items = data.get("items")
        if items is None:
            # au cas ou l'API renverrait directement une FeatureCollection
            if "features" in data:
                features.extend(data["features"])
                break
            raise RuntimeError(f"Reponse inattendue pour {endpoint} (page {page}) : cles={list(data.keys())}")
        features.extend(_item_to_feature(it) for it in items)
        total_pages = data.get("totalPages", 1) or 1
        log(f"  {endpoint} : page {page}/{total_pages} ({len(items)} elements)")
        page += 1
    return features


def _write_geojson(path, features, log):
    fc = {"type": "FeatureCollection", "features": features}
    path.write_text(json.dumps(fc, ensure_ascii=False), encoding="utf-8")
    log(f"  -> {path.name} ecrit ({len(features)} elements, {path.stat().st_size // 1024} Ko)")


def run_update(base_dir, api_key, log=print):
    """
    base_dir : dossier racine de l'app (celui qui contient data/)
    api_key  : cle API OpenAIP
    log      : fonction de log (recoit une ligne de texte a chaque etape)
    Retourne un resume texte. Leve une exception avec un message clair en cas d'echec.
    """
    if not api_key:
        raise RuntimeError("Cle API OpenAIP manquante")

    data_dir = Path(base_dir) / "data"
    data_dir.mkdir(parents=True, exist_ok=True)

    collected = {}
    for endpoint, filename in ENDPOINTS.items():
        log(f"Telechargement {endpoint}...")
        features = fetch_endpoint(endpoint, api_key, log)
        collected[endpoint] = features
        _write_geojson(data_dir / filename, features, log)

    # fr_freqs.json n'est plus utilise (flyfrancevfr.html derive desormais les
    # frequences directement depuis fr_apt.geojson) : on supprime l'ancien fichier
    # s'il traine encore d'une version precedente.
    old_freqs = data_dir / "fr_freqs.json"
    if old_freqs.exists():
        old_freqs.unlink()
        log("  -> ancien fr_freqs.json supprime (plus utilise)")

    # fr_asp_vfr.geojson n'est plus utilise (flyfrancevfr.html s'appuie desormais
    # uniquement sur fr_asp.geojson complet, pour les zones comme pour les SIV) :
    # on supprime l'ancien fichier s'il traine encore d'une version precedente.
    old_asp_vfr = data_dir / "fr_asp_vfr.geojson"
    if old_asp_vfr.exists():
        old_asp_vfr.unlink()
        log("  -> ancien fr_asp_vfr.geojson supprime (plus utilise)")

    summary = (
        f"OK : {len(collected['airports'])} aerodromes, "
        f"{len(collected['airspaces'])} espaces, "
        f"{len(collected['navaids'])} navaids, "
        f"{len(collected['reporting-points'])} points de report, "
        f"{len(collected['obstacles'])} obstacles."
    )
    log(summary)
    return summary


if __name__ == "__main__":
    # Utilisation standalone (debug), hors du bridge : lit la cle depuis l'argument
    # ou variable d'environnement OPENAIP_API_KEY.
    import os
    import sys

    key = (sys.argv[1] if len(sys.argv) > 1 else None) or os.environ.get("OPENAIP_API_KEY")
    if not key:
        print("Usage: python update_openaip_data.py <cle_api>  (ou variable OPENAIP_API_KEY)")
        sys.exit(1)
    run_update(Path(__file__).parent, key, log=print)
