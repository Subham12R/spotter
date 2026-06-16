import os
import math
import requests


ORS_BASE = "https://api.openrouteservice.org"


class RoutingError(Exception):
    def __init__(self, message: str, field: str):
        self.message = message
        self.field = field
        super().__init__(message)


def _api_key() -> str:
    key = os.environ.get("ORS_API_KEY", "")
    if not key:
        raise RoutingError("ORS_API_KEY environment variable is not set", "server")
    return key


# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------

def _decode_polyline(encoded: str) -> list:
    """Decode Google/ORS encoded polyline (1e5 precision) to [[lat, lng], ...]."""
    coords = []
    index = 0
    lat = 0
    lng = 0
    n = len(encoded)
    while index < n:
        # Decode lat then lng
        for is_lng in (False, True):
            shift = 0
            result = 0
            while True:
                b = ord(encoded[index]) - 63
                index += 1
                result |= (b & 0x1f) << shift
                shift += 5
                if b < 32:
                    break
            delta = ~(result >> 1) if (result & 1) else (result >> 1)
            if is_lng:
                lng += delta
            else:
                lat += delta
        coords.append([lat / 1e5, lng / 1e5])
    return coords


def _haversine_miles(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance in miles between two lat/lng points."""
    R = 3958.8  # Earth radius in miles
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlng / 2) ** 2
    return R * 2 * math.asin(math.sqrt(min(a, 1.0)))


def _leg_miles(coords: list) -> float:
    """Sum haversine distances along a sequence of [lat, lng] points."""
    total = 0.0
    for i in range(len(coords) - 1):
        total += _haversine_miles(coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1])
    return total


# ---------------------------------------------------------------------------
# Public API functions
# ---------------------------------------------------------------------------

def geocode(location_text: str, field_name: str) -> dict:
    """Geocode a text location to {lat, lng, label} using ORS Geocoding API."""
    url = f"{ORS_BASE}/geocode/search"
    params = {
        "api_key": _api_key(),
        "text": location_text,
        "size": 1,
    }
    try:
        resp = requests.get(url, params=params, timeout=10)
    except requests.RequestException as exc:
        raise RoutingError("Routing service unavailable", field_name) from exc

    if resp.status_code != 200:
        raise RoutingError(
            f"Geocoding API error ({resp.status_code})", field_name
        )

    features = resp.json().get("features", [])
    if not features:
        raise RoutingError(
            f"Could not geocode location: '{location_text}'", field_name
        )

    # ORS GeoJSON returns [lng, lat] — swap to (lat, lng)
    lng, lat = features[0]["geometry"]["coordinates"]
    label = features[0]["properties"].get("label", location_text)
    return {"lat": float(lat), "lng": float(lng), "label": label}


def get_directions(waypoints: list) -> dict:
    """
    Get route between waypoints [{lat, lng}, ...] via ORS Directions API.

    Returns:
        total_miles, total_duration_sec, polyline ([[lat, lng], ...]), segments
    """
    # ORS expects [[lng, lat], ...] (GeoJSON coordinate order)
    coordinates = [[wp["lng"], wp["lat"]] for wp in waypoints]

    for profile in ("driving-hgv", "driving-car"):
        url = f"{ORS_BASE}/v2/directions/{profile}"
        body = {
            "coordinates": coordinates,
            "instructions": False,
            "geometry": True,
            "units": "mi",
        }
        try:
            resp = requests.post(
                url,
                json=body,
                headers={
                    "Authorization": _api_key(),
                    "Content-Type": "application/json",
                },
                timeout=30,
            )
        except requests.RequestException as exc:
            raise RoutingError("Routing service unavailable", "server") from exc

        if resp.status_code == 404 and profile == "driving-hgv":
            continue  # try car profile
        if resp.status_code != 200:
            try:
                err = resp.json().get("error", {}).get("message", resp.text[:200])
            except Exception:
                err = resp.text[:200]
            raise RoutingError(f"Directions API error: {err}", "server")
        break
    else:
        raise RoutingError("Directions API unavailable", "server")

    data = resp.json()
    route = data["routes"][0]
    summary = route["summary"]

    # Decode Google encoded polyline (1e5 precision) to [[lat, lng], ...]
    polyline = _decode_polyline(route["geometry"])

    # Split into two legs using way_points indices
    # way_points: [start_idx, pickup_idx, dropoff_idx]
    way_points = route.get("way_points", [0, len(polyline) // 2, len(polyline) - 1])
    leg1_coords = polyline[way_points[0]: way_points[1] + 1]
    leg2_coords = polyline[way_points[1]: way_points[2] + 1]

    # Compute haversine distances for each leg (road distance from ORS is more accurate
    # for total, so scale haversine legs to match total)
    ors_total_miles = summary["distance"]   # ORS road distance (authoritative)
    total_dur_sec = summary["duration"]

    hav_leg1 = _leg_miles(leg1_coords)
    hav_leg2 = _leg_miles(leg2_coords)
    hav_total = hav_leg1 + hav_leg2

    if hav_total > 0:
        # Scale legs proportionally to ORS total to preserve road-distance accuracy
        leg1_miles = ors_total_miles * (hav_leg1 / hav_total)
        leg2_miles = ors_total_miles * (hav_leg2 / hav_total)
        leg1_dur = total_dur_sec * (hav_leg1 / hav_total)
        leg2_dur = total_dur_sec - leg1_dur
    else:
        leg1_miles = ors_total_miles / 2
        leg2_miles = ors_total_miles / 2
        leg1_dur = total_dur_sec / 2
        leg2_dur = total_dur_sec / 2

    return {
        "total_miles": ors_total_miles,
        "total_duration_sec": total_dur_sec,
        "polyline": polyline,
        "segments": [
            {"distance_miles": leg1_miles, "duration_sec": leg1_dur},
            {"distance_miles": leg2_miles, "duration_sec": leg2_dur},
        ],
    }
