"""Diagnostic non intrusif du roulage et de l'alignement IA."""
from __future__ import annotations


def runway_axis_deviation(heading_deg: float, runway_heading_deg: float) -> float:
    """Écart angulaire à l'axe de piste (0° ou 180° sont alignés)."""
    heading = float(heading_deg) % 360.0
    runway = float(runway_heading_deg) % 360.0
    delta = abs((heading - runway + 180.0) % 360.0 - 180.0)
    return min(delta, abs(180.0 - delta))


def classify_ground_state(on_ground: bool, ground_speed_kt: float,
                          heading_deg: float | None = None,
                          runway_heading_deg: float | None = None) -> str:
    """Classe une observation sans jamais commander l'avion."""
    if not bool(on_ground):
        return "EN_VOL"
    speed = max(0.0, float(ground_speed_kt))
    if speed <= 1.5:
        return "ARRET"
    if speed <= 15.0:
        return "ROULAGE_LENT"
    if heading_deg is not None and runway_heading_deg is not None:
        deviation = runway_axis_deviation(heading_deg, runway_heading_deg)
        if deviation <= 15.0:
            return "ACCELERATION_DANS_AXE"
        if speed >= 20.0 and deviation > 20.0:
            return "ACCELERATION_HORS_AXE"
    return "DEPLACEMENT_SOL"
