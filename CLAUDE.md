# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ELD Trip Planner — a full-stack Django + React app that takes truck driver trip inputs and produces FMCSA-compliant schedules with rendered ELD log sheets and route maps. The regulatory spec is FMCSA 49 CFR Part 395 (April 2022), 70-hr/8-day property-carrying cycle.

Both `frontend/` and `backend/` are **empty greenfield directories** — the full spec lives in `project_req/ELD-Trip-Planner-PRD.md`.

---

## Commands

### Backend (Django)
```bash
cd backend
python -m venv venv && venv\Scripts\activate   # first time
pip install -r requirements.txt
python manage.py runserver                      # dev server on :8000
python manage.py test                           # run all tests
pytest hos_engine/tests/                        # single module tests
```

### Frontend (React + Vite)
```bash
cd frontend
npm install
npm run dev       # dev server on :5173
npm run build     # production build
npm run preview   # preview production build
```

### Environment
- Backend requires `.env` with `ORS_API_KEY=<key>` (OpenRouteService, free at openrouteservice.org)
- Frontend may need `.env.local` with `VITE_API_URL=http://localhost:8000` for local dev

---

## Architecture

### Single API Endpoint

```
POST /api/plan-trip/
```

Input: `{ current_location, pickup_location, dropoff_location, current_cycle_used }`  
Output: `{ route: { total_miles, total_days, polyline, stops[] }, eld_logs[] }`

### Backend Modules (Python, no Django dependencies between them)

| File | Purpose |
|------|---------|
| `routing.py` | Wraps OpenRouteService — geocoding (text → lat/lng) and directions (polyline + distance + duration) |
| `hos_engine.py` | HOS state machine — the critical path. Pure Python, unit-testable in isolation. |
| `eld_builder.py` | Converts HOS timeline → per-day ELD log data (events[], totals{}, remarks[]) |

### Frontend Components

| Component | Role |
|-----------|------|
| `TripForm.jsx` | Left panel (30% width) — 4 inputs + submit + stop list |
| `RouteMap.jsx` | Right panel top (35%) — Leaflet map, polyline, colored markers |
| `ELDLogSheet.jsx` | Right panel bottom (35%) — one per day, drawn with native Canvas API |

---

## HOS Engine — Critical Rules

The HOS engine is the load-bearing core. All state is tracked in minutes.

**State variables:**
- `driving_min_today` — max 660 (11 hrs)
- `window_start_min` / `window_expires_min` — 14-hr window from first on-duty; max 840 min
- `cumul_driving_since_break` — max 480 (8 hrs) before 30-min break injection
- `cycle_min_used` — starts at `current_cycle_used * 60`; max 4200 (70 hrs)
- `miles_since_fuel` — max 1000; triggers 30-min fuel stop

**Stop injection priority (when multiple rules trigger simultaneously):**
1. Cycle limit (≥ 4200 min) → halt trip, add `cycle_warning`
2. 14-hr window expiry → inject 10-hr rest
3. 11-hr driving limit → inject 10-hr rest
4. Fuel stop (≥ 1,000 miles) → inject 30-min On Duty ND
5. 30-min break (≥ 8 cumulative driving hrs) → inject 30-min On Duty ND

**Fixed assumptions (hardcoded, not user inputs):**
- Pre-trip inspection: 30 min On Duty ND (start of each driving day)
- Pickup: 60 min On Duty ND
- Dropoff: 60 min On Duty ND
- Fuel stop: 30 min On Duty ND, every 1,000 miles
- Rest: 10 hr Off Duty (resets daily limits)
- 30-min break status: `on_duty_nd` (not off_duty)

**Break counter reset:** Any non-driving event ≥ 30 consecutive minutes resets `cumul_driving_since_break` to 0. Two separate 15-min stops do NOT satisfy it.

**10-hr rest resets:** `driving_min_today`, `on_duty_min_today`, `window_start_min`

---

## ELD Log Sheet Spec

Each day's `events[]` must sum to exactly **1440 minutes** (24 hrs). Events are contiguous, non-overlapping, bounded 0–1440.

**Status colors for Canvas rendering:**
- Off Duty: `#4A7FC1` (blue) — Row 1
- Sleeper Berth: `#9B8FD4` (purple) — Row 2 (unused in v1)
- Driving: `#E8A020` (amber) — Row 3
- On Duty ND: `#4CAF50` (green) — Row 4

Canvas elements: 24-hr grid, hour labels (Midnight/Noon labels at 0 and 12), 15-min minor ticks, horizontal status bars, vertical connector lines at transitions, per-row hour totals on right, diagonal remark text at transitions, header (date, miles, driver/carrier fields).

---

## Map Spec

- Polyline color: `#1a2744` (dark navy), 4px weight
- Map auto-fits bounds to show full route (`fitBounds`)
- Tile provider: OpenStreetMap (no API key)
- Marker colors: Pickup=green, Dropoff=red, Fuel=yellow, Rest=blue, Break=grey

---

## Key Acceptance Criteria

- `AC-04`: ELD totals per day must always sum to exactly 24.0 hrs
- `AC-01`: 30-min break injected after 8 cumulative driving hrs; NOT injected if a pickup/fuel stop ≥ 30 min already occurred within those 8 hrs
- `AC-03`: With `current_cycle_used=65`, response includes `cycle_warning` and caps driving at 5 remaining hrs
- `AC-05`: 1,500-mile trip gets a fuel stop at or before mile 1,000

---

## Deployment

- Frontend → Vercel
- Backend → Railway (configured with `ORS_API_KEY` env var)
- CORS: `django-cors-headers` must allow the Vercel frontend origin

---

## Test Routes (for validation)

| Route | ~Miles | Expected Days | `current_cycle_used` |
|-------|--------|---------------|--------------------|
| Chicago → Dallas → LA | 1,847 | 2–3 | 24.5 |
| NYC → Miami → Houston | 2,400 | 3–4 | 10.0 |
| Seattle → SF → Phoenix | 1,600 | 2 | 55.0 (cycle stress) |
