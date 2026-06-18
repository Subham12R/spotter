# ELD Trip Planner — Code Walkthrough

## Demo Input (use this for the live demo)

| Field | Value |
|---|---|
| Current Location | `Chicago, Illinois` |
| Pickup | `Dallas, Texas` |
| Dropoff | `Los Angeles, California` |
| Current Cycle Used | `24.5` hrs of 70 |

**Expected output:** ~1,847 mi · 2–3 driving days · fuel stop around mile 1,000 · ELD logs showing 11 hr drive + 1 hr on-duty per day.

---

## 1. Problem Being Solved

Long-haul truck drivers must comply with **FMCSA 49 CFR Part 395** — federal Hours of Service regulations. Violations cost up to **$16,000 per infraction**.

Manually planning a multi-day route means:
- Tracking cumulative driving hours across an 8-day rolling window (70-hr limit)
- Injecting mandatory 30-min breaks, 10-hr rests, and fuel stops at the right mile marks
- Filling out a paper ELD log sheet for every single day

This app replaces all of that with **four inputs → one click → full compliance report**.

---

## 2. Architecture Overview

```
Browser (React + Vite :5173)
    │
    │  POST /api/plan-trip/
    ▼
Django REST Framework (:8000)
    │
    ├── routing.py          ← geocode addresses, fetch route from ORS
    ├── hos_engine.py       ← HOS state machine (the hard part)
    ├── eld_builder.py      ← convert timeline → per-day ELD log data
    └── views.py            ← wire it all together, return JSON
```

**Key design choice:** the three backend modules have **zero Django dependencies** between them — `hos_engine.py` and `eld_builder.py` are pure Python and fully unit-testable in isolation.

**External APIs:**
- **OpenRouteService** — geocoding (text → lat/lng) + directions (polyline + distance + segment durations)
- **Nominatim** (OpenStreetMap) — frontend autocomplete only, no API key required
- **CartoDB Dark Matter** — Leaflet tile layer, no API key required

---

## 3. Backend — Walk Each File

### `routing.py`

Two public functions:

```python
geocode("Chicago, Illinois", field="current_location")
# → {"lat": 41.85, "lng": -87.65, "label": "Chicago, IL, USA"}

get_directions([current, pickup, dropoff])
# → {"segments": [...], "total_miles": 1847.2, "polyline": [[lat,lng], ...]}
```

`get_directions` calls ORS's `/v2/directions/driving-car` endpoint with three waypoints. ORS returns an encoded polyline + per-segment `distance` and `duration`. We decode the polyline in `_decode_polyline()` using the standard 1e5 Polyline algorithm.

The `segments` list is the critical output — it tells the HOS engine how far and how long each leg is **before** stops are inserted.

---

### `hos_engine.py` — The Core

This is the load-bearing module. It implements a **state machine** that simulates the driver's day minute-by-minute.

**State variables tracked (all in minutes):**

| Variable | Limit | Meaning |
|---|---|---|
| `driving_min_today` | 660 (11 hr) | Driving so far this shift |
| `window_start_min` | — | When the 14-hr window opened |
| `window_expires_min` | +840 from window_start | Hard cutoff — must be in rest by here |
| `cumul_driving_since_break` | 480 (8 hr) | Driving since last qualifying 30-min break |
| `cycle_min_used` | 4200 (70 hr) | Rolling 8-day total |
| `miles_since_fuel` | 1000 | Triggers a fuel stop |

**Stop injection priority** (checked at every chunk boundary):

1. **Cycle limit** ≥ 4200 min → halt trip, emit `cycle_warning`
2. **14-hr window** expired → inject 10-hr `off_duty` rest
3. **11-hr driving** limit → inject 10-hr `off_duty` rest
4. **Fuel** ≥ 1,000 miles → inject 30-min `on_duty_nd` fuel stop
5. **30-min break** ≥ 8 hr cumulative driving → inject 30-min `on_duty_nd` break

**Fixed costs injected automatically (not user inputs):**
- Pre-trip inspection: 30 min On Duty ND (every driving day)
- Pickup: 60 min On Duty ND
- Dropoff: 60 min On Duty ND
- Rest: 10 hr Off Duty (resets driving_min_today, window)
- Break counter reset: any non-driving event ≥ 30 consecutive minutes resets `cumul_driving_since_break` to 0

**Output:** `{ timeline: [TimelineEvent, ...], stops: [...], total_miles, cycle_warning? }`

Each `TimelineEvent` has `status`, `start_min`, `end_min`, `lat`, `lng`, `miles_mark`.

---

### `eld_builder.py`

Takes the raw `timeline` and groups events by calendar day. For each day it produces:

```json
{
  "day": 1,
  "date": "2026-06-18",
  "miles_driven": 482.6,
  "events": [
    { "status": "off_duty", "startMin": 0, "endMin": 360 },
    { "status": "on_duty_nd", "startMin": 360, "endMin": 390 },
    { "status": "driving", "startMin": 390, "endMin": 1050 },
    ...
  ],
  "totals": { "off_duty": 12.0, "driving": 11.0, "on_duty_nd": 1.0, "sleeper_berth": 0.0 },
  "remarks": [{ "min": 390, "text": "Pre-trip / Depart Chicago" }],
  "hos_check": { "driving_hrs": 11, "driving_limit": 11, "window_hrs": 12, "window_limit": 14, "cycle_used_after_day": 35.5, "cycle_limit": 70, "compliant": true }
}
```

**Critical invariant:** `events[].endMin - events[].startMin` summed across all events for a day **always equals exactly 1440** (24 hours × 60 minutes). The canvas renderer depends on this to draw the 24-hour grid correctly.

---

### `views.py` — The Glue

```
POST /api/plan-trip/
  body: { current_location, pickup_location, dropoff_location, current_cycle_used }
```

Pipeline in 4 lines:
```python
current, pickup, dropoff = routing.geocode(...)    # 3 geocode calls
route = routing.get_directions([current, pickup, dropoff])
simulation = hos_engine.run_simulation(trip_input)
eld_logs = eld_builder.build_eld_logs(simulation["timeline"], ...)
```

DRF serializer validates inputs before any API calls are made. All errors from routing or HOS bubble up as `{ "error": "...", "field": "..." }` 400 responses.

---

## 4. Frontend — Walk Each Component

### `App.jsx`

Central state manager. Owns:
- `result` — the full API response
- `eldH` — ELD panel pixel height (controlled by drag handle)
- `startLocation` — saved on submit, prepended to stop list as "Starting Point"

Toaster (`sonner`) handles all error/success feedback — no inline error divs.

---

### `RouteMap.jsx`

Full-screen Leaflet map mounted imperatively with `useRef` + `useEffect`. Two effects:

1. **Mount effect** — creates the map once with CartoDB Dark Matter tiles, `maxBounds` set to `[[-85, -180], [85, 180]]` so the map never scrolls to empty tile space.
2. **Data effect** — fires when `polyline` / `stops` props change. Clears old layers, draws the amber polyline (`#E8A020`, weight 3.5), and places one `divIcon` marker per stop. Each marker is a 32px circle with an SVG icon from the HugeIcons library embedded as an HTML string.

Stop marker colors: pickup=#22c55e, dropoff=#ef4444, fuel=#E8A020, rest=#3b82f6, break=#6b7280.

---

### `TripForm.jsx` + `LocationInput.jsx`

`LocationInput` handles:
- **Nominatim autocomplete** — 480ms debounce, US-only, keyboard nav (↑ ↓ Enter Esc)
- **Browser geolocation** — `navigator.geolocation.getCurrentPosition` → reverse geocode via Nominatim
- **Label icons** — `labelType` prop drives which HugeIcon shows in the field label (MapingIcon / DeliveryBox01Icon / DeliveryTruck01Icon)

`TripForm` is a controlled form. On submit it fires `onSubmit(formData)` up to `App.jsx`.

---

### `StopList.jsx`

Receives `stops` from the API + a synthetic `startLocation` prepended as a "Starting Point" entry. All markers are uniform white icons (no per-type color background) with a vertical line connecting them.

Stop icons: MapingIcon (start), DeliveryBox (pickup), DeliveryTruck (dropoff), FuelStation (fuel), Bed (rest), Coffee (break).

---

### `ELDLogSheet.jsx`

Renders a **Canvas 2D** log sheet — 920 logical px wide, DPR-scaled for retina sharpness. The `drawSheet()` function:

1. Draws the navy header (`#1a2744`) with day badge, date, miles, compliance badge
2. Draws a 4-row status grid (Off Duty / Sleeper Berth / Driving / On Duty ND)
3. Loops `day.events[]` — each event is a horizontal bar at `x = (startMin / 1440) × gridWidth`
4. Draws dashed vertical connector lines at status transitions
5. Draws diagonal remark text at each transition point
6. Draws per-row hour totals in the right column
7. Draws hour labels (M, 1, 2 … N, 1, 2 … M) along the bottom

Status colors match FMCSA convention: Off Duty=`#4A7FC1`, Driving=`#E8A020`, On Duty ND=`#4CAF50`.

`document.fonts.ready` is awaited before drawing so local fonts (Nunito Sans, Playfair Display) are guaranteed loaded.

The ELD panel itself is **vertically draggable** — a pill handle at the top fires `onMouseDown`, tracks `mousemove` delta from `startY`, and updates `eldH` state (clamped 140px–85vh).

---

## 5. HOS Compliance 

With input **Chicago → Dallas → LA, 24.5 hrs used**:

| Day | Driving | On Duty ND | Off Duty | Status |
|---|---|---|---|---|
| 1 | 11.0 hr | 1.0 hr | 12.0 hr | Compliant |
| 2 | 11.0 hr | 1.0 hr | 12.0 hr | Compliant |
| 3 | ~4–6 hr | ~2–3 hr | remainder | Compliant |

**What to point out on the ELD:**
- The amber bar (Driving) starts after the green On Duty ND pre-trip inspection block
- Each day the amber bar doesn't exceed 11 hrs (660 min)
- The blue Off Duty block fills the remaining time to exactly 24 hrs
- The compliance badge in the top-right of each sheet shows ✓ Compliant
- The HOS stats line reads: `Drive 11/11h · Window 12/14h · Cycle 35.5/70h`

**On the map:**
- Amber polyline traces Chicago → Dallas → LA
- Green circle = Pickup in Dallas
- Red circle = Dropoff in Los Angeles
- Amber circles = Fuel stops (one around mile 1,000, one around mile 1,800)
- Blue circles = 10-hr rest stops
- Grey circles = 30-min breaks

---

## 6. Tech Stack Summary

| Layer | Technology |
|---|---|
| Frontend framework | React 18 + Vite |
| Map | Leaflet 1.9 + CartoDB Dark Matter tiles |
| Icons | HugeIcons (`hugeicons-react` v0.4.0) |
| Toast notifications | Sonner v2 |
| Fonts | Playfair Display (display) + Nunito Sans (body) — local TTF |
| Canvas | Native HTML5 Canvas 2D API (no chart library) |
| Backend framework | Django 4 + Django REST Framework |
| Routing API | OpenRouteService (free tier) |
| Geocoding (frontend) | Nominatim / OpenStreetMap (no key) |
| Deployment | Frontend → Vercel · Backend → Railway |

---

