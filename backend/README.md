# Backend — System Architecture

Django 4.2 + Django REST Framework. Stateless — no database, no sessions, no auth. A single POST endpoint accepts trip parameters, runs the HOS simulation, and returns ELD log data.

---

## Request Lifecycle

```mermaid
sequenceDiagram
    participant C as Client
    participant V as PlanTripView
    participant R as routing.py
    participant ORS as OpenRouteService
    participant H as hos_engine.py
    participant E as eld_builder.py

    C->>V: POST /api/plan-trip/
    V->>V: TripInputSerializer.validate()
    alt invalid input
        V-->>C: 400 { error, field }
    end

    V->>R: geocode(current_location)
    V->>R: geocode(pickup_location)
    V->>R: geocode(dropoff_location)
    R->>ORS: GET /geocode/search ×3
    ORS-->>R: GeoJSON features [lng, lat]
    R-->>V: { lat, lng, label } ×3

    V->>R: get_directions([current, pickup, dropoff])
    R->>ORS: POST /v2/directions/driving-hgv
    ORS-->>R: encoded polyline + way_points
    R-->>V: { total_miles, polyline, segments[2] }

    V->>H: run_simulation(TripInput)
    H-->>V: { timeline, stops, total_miles, cycle_warning }

    V->>E: build_eld_logs(timeline, date, miles)
    E-->>V: [ { day, events, totals, hos_check } ]

    V-->>C: 200 { route, eld_logs [, cycle_warning] }
```

---

## Module Dependency

```mermaid
graph TD
    subgraph Django
        URL[config/urls.py] --> VIEW[trip_planner/views.py]
        SER[trip_planner/serializers.py] --> VIEW
    end

    subgraph Pure Python
        VIEW --> ROU[routing.py]
        VIEW --> HOS[hos_engine.py]
        VIEW --> ELD[eld_builder.py]
        HOS --> ELD
    end

    subgraph External
        ROU -->|geocode / directions| ORS[OpenRouteService API]
    end
```

---

## Modules

### `routing.py`
Pure Python, no Django imports. Wraps OpenRouteService.

- **`geocode(text, field_name)`** — `GET /geocode/search`. ORS returns GeoJSON `[lng, lat]`; swapped to `{lat, lng, label}`. Raises `RoutingError` on HTTP error or empty result.
- **`get_directions(waypoints)`** — `POST /v2/directions/driving-hgv` (falls back to `driving-car` on 404). ORS returns a Google-encoded polyline string (1e5 precision, not GeoJSON) — decoded inline with `_decode_polyline()`. Legs are split using `way_points` indices from the ORS response; leg distances are scaled proportionally from haversine ratios to preserve ORS road-distance accuracy.

```mermaid
flowchart LR
    A[location text] --> B[GET /geocode/search]
    B --> C["swap [lng,lat] → {lat,lng}"]
    C --> D["{lat, lng, label}"]

    E["[current, pickup, dropoff]"] --> F[POST /v2/directions/driving-hgv]
    F -->|404| G[POST /v2/directions/driving-car]
    F --> H[decode encoded polyline]
    G --> H
    H --> I[split legs via way_points indices]
    I --> J[scale leg distances via haversine ratio]
    J --> K["{ total_miles, polyline, segments[2] }"]
```

---

### `hos_engine.py`
Pure Python. FMCSA 49 CFR §395.3 state machine. **All time is in absolute minutes from trip epoch (midnight of day 1).**

State variables tracked per simulation run:

| Variable | Max | Resets on |
|---|---|---|
| `driving_min_today` | 660 (11 hr) | 10-hr rest |
| `window_expires_min` | `window_start + 840` (14 hr) | 10-hr rest |
| `cumul_driving_since_break` | 480 (8 hr) | any non-driving event ≥ 30 min |
| `cycle_min_used` | 4200 (70 hr) | never |
| `miles_since_fuel` | 1000 | fuel stop |

#### Simulation Flow

```mermaid
flowchart TD
    START([start]) --> OD[emit Off Duty\n0 → shift_start_min]
    OD --> OPEN[open_shift\nset 14-hr window + pre-trip 30min]
    OPEN --> SEG0[drive segment 0\ncurrent → pickup]
    SEG0 --> PU[inject pickup stop\n60 min On Duty ND]
    PU --> SEG1[drive segment 1\npickup → dropoff]
    SEG1 --> DO[inject dropoff stop\n60 min On Duty ND]
    DO --> FILL[fill remainder of day\nwith Off Duty]
    FILL --> END([return timeline + stops])

    HALT([cycle_warning\nhalted]) -.->|halted flag set| SEG0
    HALT -.->|halted flag set| SEG1
```

#### Driving Loop Priority (per iteration)

```mermaid
flowchart TD
    LOOP([top of loop\nremaining_miles > 0]) --> C1{cycle_min_used\n≥ 4200?}
    C1 -->|yes| WARN[set cycle_warning\nfill to midnight\nhalt]
    C1 -->|no| C2{current_time\n≥ window_expires?}
    C2 -->|yes| REST[inject 10-hr rest\nopen_shift]
    REST --> LOOP
    C2 -->|no| C3{driving_min_today\n≥ 660?}
    C3 -->|yes| REST
    C3 -->|no| C4{miles_since_fuel\n≥ 1000?}
    C4 -->|yes| FUEL[inject 30-min\nfuel stop]
    FUEL --> LOOP
    C4 -->|no| C5{cumul_driving\n≥ 480?}
    C5 -->|yes| BRK[inject 30-min break]
    BRK --> LOOP
    C5 -->|no| DRIVE[compute can_drive_min\n= min of all constraints\nemit driving event]
    DRIVE --> LOOP
```

Fixed stops (hardcoded durations, not user-configurable):

| Event | Status | Duration |
|---|---|---|
| Pre-trip inspection | On Duty ND | 30 min |
| Pickup | On Duty ND | 60 min |
| Dropoff | On Duty ND | 60 min |
| Fuel stop | On Duty ND | 30 min |
| 30-min break | On Duty ND | 30 min |
| Rest | Off Duty | 600 min (10 hr) |

Output: flat list of `TimelineEvent` objects spanning absolute minutes from epoch.

---

### `eld_builder.py`
Pure Python. Converts the flat absolute-time timeline into per-calendar-day ELD log entries.

```mermaid
flowchart TD
    TL[flat timeline\nTimelineEvent list] --> DAYS[for each calendar day]
    DAYS --> SLICE[slice events into\nday window 0–1440\nnormalize to 0-based]
    SLICE --> FILL[fill gaps with\nOff Duty events]
    FILL --> MERGE[merge consecutive\nsame-status events]
    MERGE --> ASSERT{sum == 1440?}
    ASSERT -->|no| ERR[ELDInvariantError\n500]
    ASSERT -->|yes| TOTALS[compute per-status\nhour totals]
    TOTALS --> MILES[compute miles driven\nproportional overlap]
    MILES --> REMARKS[build remarks\ntransition annotations]
    REMARKS --> HOS[build hos_check\ndriving / window / cycle]
    HOS --> LOG[day log entry]
    LOG --> OUT[eld_logs list]
```

---

## API Contract

### Request
```
POST /api/plan-trip/
Content-Type: application/json

{
  "current_location":  "Chicago, IL",
  "pickup_location":   "Dallas, TX",
  "dropoff_location":  "Los Angeles, CA",
  "current_cycle_used": 24.5          // hours used this 8-day cycle, 0–70
}
```

### Response (200)
```json
{
  "route": {
    "total_miles": 2407.3,
    "total_days": 3,
    "polyline": [[lat, lng], "..."],
    "stops": [
      {
        "type": "fuel",
        "label": "Fuel Stop",
        "location": "...",
        "lat": 0.0, "lng": 0.0,
        "day": 1,
        "time_of_day_min": 780,
        "duration_min": 30,
        "miles_mark": 998.4
      }
    ]
  },
  "eld_logs": [
    {
      "day": 1,
      "date": "2026-06-16",
      "miles_driven": 621.0,
      "events": [
        { "status": "off_duty",   "startMin": 0,   "endMin": 360 },
        { "status": "on_duty_nd", "startMin": 360, "endMin": 390 },
        { "status": "driving",    "startMin": 390, "endMin": 1050 }
      ],
      "totals": { "off_duty": 6.0, "driving": 11.0, "on_duty_nd": 0.5, "sleeper_berth": 0.0 },
      "remarks": [
        { "min": 0,   "text": "Chicago, IL — Off Duty" },
        { "min": 360, "text": "Chicago, IL — Pre-trip inspection" }
      ],
      "hos_check": {
        "driving_hrs": 11.0,
        "driving_limit": 11.0,
        "window_hrs": 11.5,
        "window_limit": 14.0,
        "cycle_used_after_day": 36.0,
        "cycle_limit": 70.0,
        "compliant": true
      }
    }
  ],
  "cycle_warning": "Driver exhausts 70-hr cycle on Day 2"
}
```

`cycle_warning` is omitted when the cycle limit is not reached.

### Error Response (400)
```json
{ "error": "Could not geocode location: 'xyzzy'", "field": "pickup_location" }
```

---

## Django Configuration

No database (`DATABASES = {}`). No auth app — `UNAUTHENTICATED_USER = None` and empty `DEFAULT_AUTHENTICATION_CLASSES` prevent DRF from importing `django.contrib.auth`.

CORS: `CORS_ALLOW_ALL_ORIGINS = True` in DEBUG mode; `CORS_ALLOWED_ORIGINS` from env in production. `CorsMiddleware` must remain first in `MIDDLEWARE`.

Env vars (loaded from `backend/.env` via python-dotenv):

| Variable | Required | Description |
|---|---|---|
| `ORS_API_KEY` | Yes | OpenRouteService API key |
| `SECRET_KEY` | Prod | Django secret key |
| `DEBUG` | No | `True` (default) or `False` |
| `ALLOWED_HOSTS` | Prod | Comma-separated hostnames |
| `CORS_ALLOWED_ORIGINS` | Prod | Comma-separated frontend origins |

---

## Running Locally

```bash
cd backend
python -m venv venv && venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env          # fill in ORS_API_KEY
python manage.py runserver    # http://localhost:8000
```
