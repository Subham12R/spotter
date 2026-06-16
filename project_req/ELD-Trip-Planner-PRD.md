# Product Requirements Document
## ELD Trip Planner — Full-Stack Assessment

**Version:** 1.0  
**Date:** June 16, 2026  
**Stack:** Django + React  
**Regulation Source:** FMCSA 49 CFR Part 395 (April 2022)

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Goals & Non-Goals](#2-goals--non-goals)
3. [User Stories](#3-user-stories)
4. [HOS Rule Set — Complete Specification](#4-hos-rule-set--complete-specification)
5. [Functional Requirements](#5-functional-requirements)
6. [Technical Requirements](#6-technical-requirements)
7. [API Contract](#7-api-contract)
8. [ELD Log Sheet Requirements](#8-eld-log-sheet-requirements)
9. [Map Requirements](#9-map-requirements)
10. [Acceptance Criteria](#10-acceptance-criteria)
11. [Success Metrics](#11-success-metrics)
12. [Open Questions](#12-open-questions)
13. [Timeline & Phases](#13-timeline--phases)

---

## 1. Problem Statement

Long-haul truck drivers and dispatchers must manually calculate legally compliant driving schedules and fill out FMCSA-mandated Driver's Daily Log sheets. This process is error-prone, time-consuming, and requires deep familiarity with Hours of Service (HOS) regulations. Violations can result in fines, out-of-service orders, and safety incidents.

This application automates trip planning by taking basic trip inputs and producing a legally compliant daily schedule and pre-filled ELD (Electronic Logging Device) log sheets — removing all manual calculation burden.

**Who is affected:** Property-carrying CMV drivers on 70-hour/8-day schedules operating in interstate commerce.

**Cost of not solving it:** Manual miscalculations lead to HOS violations (fines up to $16,000/violation), fleet downtime, and safety risk.

---

## 2. Goals & Non-Goals

### Goals

1. Given trip inputs, produce a route plan that is 100% compliant with FMCSA 70hr/8-day HOS regulations.
2. Render an accurate, FMCSA-spec ELD log sheet for each day of the trip on the frontend.
3. Display the full route on an interactive map with clearly labeled stop markers.
4. Complete the trip planning calculation and return results in under 5 seconds.
5. Handle multi-day trips (up to 7 days) without errors or missing log sheets.

### Non-Goals

- **No user authentication** — single-session, stateless app; no login/accounts.
- **No sleeper berth split-provision support** — simplified model only (full 10-hr off-duty rest).
- **No adverse driving conditions exception** — assume normal conditions throughout.
- **No team driving / co-driver** — single-driver trips only.
- **No real-time traffic data** — route duration estimates are static from the routing API.
- **No PDF export of log sheets** — rendered in-browser only (v1).
- **No intrastate commerce** — interstate routes only.

---

## 3. User Stories

### Primary Persona: Dispatcher / Driver

**US-01 — Trip Input**
As a dispatcher, I want to enter the current location, pickup location, dropoff location, and current cycle hours used so that the system can compute a compliant trip plan without me knowing the HOS rules.

**US-02 — Route Visualization**
As a driver, I want to see my full route on a map with markers for every stop (pickup, dropoff, fuel, rest) so that I know exactly where I will stop and why.

**US-03 — ELD Log Generation**
As a driver, I want to see pre-filled daily log sheets for every day of my trip so that I can verify my schedule is compliant before departure.

**US-04 — Stop Details**
As a dispatcher, I want to see the type, location, and duration of every planned stop so that I can communicate the schedule to the driver.

**US-05 — Cycle Awareness**
As a driver, I want the system to account for my currently used cycle hours so that I don't unknowingly exceed the 70-hour limit mid-trip.

**US-06 — Multi-Day Trips**
As a driver, I want log sheets auto-generated for each day of a multi-day trip so that I have a ready-to-verify log for every driving day.

**Edge Case — US-07**
As a driver whose cycle hours are nearly exhausted (e.g., 68/70 hrs used), I want the system to flag that I can only drive a limited number of hours before requiring a 34-hour restart.

---

## 4. HOS Rule Set — Complete Specification

> **Source:** FMCSA 49 CFR §395.3, April 2022  
> **Assumption:** Property-carrying driver, 70hr/8-day schedule, no adverse conditions, no sleeper berth split.

### 4.1 Daily Driving Limits

| Rule | Limit | CFR Reference | Engine Variable |
|------|-------|---------------|-----------------|
| Maximum driving per shift | 11 hours | §395.3(a)(3) | `driving_hrs_today ≤ 11` |
| 14-hour driving window | 14 consecutive hours from first on-duty | §395.3(a)(2) | `window_start + 14hrs` |
| Mandatory off-duty reset | 10 consecutive hours off-duty | §395.3(a)(1) | `rest_duration ≥ 10hrs` |

**Key rule:** The 14-hour window begins the moment the driver starts ANY work (pre-trip inspection, pickup prep, etc.) — not when they start driving. Driving is not allowed after the 14th hour regardless of remaining driving hours.

### 4.2 30-Minute Break Rule

| Rule | Trigger | Satisfier | CFR Reference |
|------|---------|-----------|---------------|
| 30-minute consecutive break | After 8 **cumulative** driving hours since last qualifying break | Any consecutive 30+ min of non-driving (Off Duty or On Duty ND) | §395.3(a)(3)(ii) |

**Critical implementation notes:**
- "Cumulative" means total driving time added up, not a single continuous stretch.
- A 60-minute pickup stop fully satisfies the break requirement and resets the cumulative counter.
- A 30-minute fuel stop fully satisfies the requirement.
- The break does NOT extend the 14-hour window or add to driving time.
- Two non-consecutive 15-min stops do NOT satisfy the requirement (must be consecutive).

**Engine logic:**
```
cumulative_driving_since_break += segment_driving_min
if cumulative_driving_since_break >= 480:  # 8 hours
    inject 30-min break (off_duty or on_duty_nd)
    cumulative_driving_since_break = 0

# Any non-driving event ≥ 30 consecutive min also resets:
if non_driving_event.duration_min >= 30:
    cumulative_driving_since_break = 0
```

### 4.3 Rolling 70-Hour / 8-Day Cycle Limit

| Rule | Limit | CFR Reference |
|------|-------|---------------|
| Total on-duty hours in any 8 consecutive days | 70 hours | §395.3(b) |
| On-duty = driving + on duty not driving | All counted | §395.2 |
| Optional reset | 34 consecutive hours off-duty resets cycle to 0 | §395.3(c) |

**Input:** User provides `current_cycle_used` in hours.  
**Engine tracks:** `cycle_hours_used += (driving + on_duty_nd)` each day.  
**Guard:** If `cycle_hours_used >= 70`, driver cannot drive until cycle drops below limit.

**Available driving hours before cycle limit:**
```
available_cycle_hrs = 70 - current_cycle_used
# Driver cannot exceed this total on-duty time across the entire trip
```

### 4.4 Duty Status Categories

| Status | ELD Row | Counts Toward Cycle | Counts in 14-hr Window |
|--------|---------|--------------------|-----------------------|
| Off Duty | Row 1 | No | No (pauses window) |
| Sleeper Berth | Row 2 | No | No (not used in v1) |
| Driving | Row 3 | Yes | Yes |
| On Duty Not Driving | Row 4 | Yes | Yes |

### 4.5 Assessment-Specific Fixed Assumptions

| Assumption | Value | Source |
|-----------|-------|--------|
| Driver type | Property-carrying CMV | Assessment spec |
| Cycle type | 70hr/8-day | Assessment spec |
| Adverse conditions | None | Assessment spec |
| Pickup duration | 1 hour (On Duty ND) | Assessment spec |
| Dropoff duration | 1 hour (On Duty ND) | Assessment spec |
| Fuel stop frequency | Every 1,000 miles | Assessment spec |
| Fuel stop duration | 30 minutes (On Duty ND) | Industry standard |
| Pre-trip inspection | 30 minutes (On Duty ND) | FMCSA standard |
| Speed assumption | Derived from ORS API duration | Routing API |

### 4.6 HOS Engine State Machine

```
State variables (tracked per simulation tick):
─────────────────────────────────────────────
driving_min_today          → max 660 (11hrs)
on_duty_min_today          → part of 14hr window
window_start_min           → set on first on-duty of the day; NULL if no activity
window_expires_min         → window_start_min + 840 (14hrs)
cumul_driving_since_break  → max 480 (8hrs) before break injection
cycle_min_used             → max 4200 (70hrs); starts at current_cycle_used * 60
miles_since_fuel           → max 1000; triggers fuel stop injection

Reset triggers:
───────────────
10hr off-duty  → resets driving_min_today, on_duty_min_today, window_start_min
30-min non-driving → resets cumul_driving_since_break
New calendar day → increments day counter
```

### 4.7 Stop Injection Priority Order

When multiple rules trigger simultaneously, inject in this order:

1. **Cycle limit check** — if `cycle_min_used >= 4200`, halt trip (flag needed)
2. **14-hour window expiry** — force 10-hr rest
3. **11-hour driving limit** — force 10-hr rest
4. **Fuel stop** — inject if `miles_since_fuel >= 1000`
5. **30-min break** — inject if `cumul_driving_since_break >= 480`

---

## 5. Functional Requirements

### P0 — Must Ship (Core Flow)

| ID | Requirement | Acceptance Criteria |
|----|-------------|---------------------|
| F-01 | Trip input form with 4 fields | All 4 inputs present, validated, non-empty before submit |
| F-02 | Geocode text inputs to lat/lng | Locations resolve to coordinates via ORS Geocoding API |
| F-03 | Fetch route from current → pickup → dropoff | ORS Directions API returns distance (miles) + duration (hrs) |
| F-04 | HOS engine produces compliant event timeline | All daily limits enforced; no rule violations in output |
| F-05 | Return structured stops list | Each stop has: type, location name, lat/lng, duration_min, day |
| F-06 | Return ELD log data per day | Each day has: events[], totals{}, date, miles_driven |
| F-07 | Display route polyline on Leaflet map | Polyline renders from current → pickup → dropoff |
| F-08 | Drop markers for each stop on map | Each marker has popup with stop type + duration |
| F-09 | Render ELD Canvas log sheet per day | Grid, 4 rows, status bars, remarks, hour labels, totals |
| F-10 | Log sheet totals sum to 24 hours | Sum of all event durations per day = 1440 minutes |

### P1 — Should Ship

| ID | Requirement | Notes |
|----|-------------|-------|
| F-11 | HOS summary panel per day | Show driving hrs used, window used, cycle remaining |
| F-12 | Color-coded map markers by stop type | Fuel=yellow, Rest=blue, Pickup=green, Dropoff=red |
| F-13 | Mobile-responsive layout | Form + map stack vertically on < 768px |
| F-14 | Loading state during API call | Spinner or skeleton while Django processes |
| F-15 | Error state for invalid locations | "Location not found" toast if geocoding fails |
| F-16 | Cycle limit warning | Banner if driver has < 11 hrs remaining in cycle |

### P2 — Future (Post-Assessment)

| ID | Requirement | Notes |
|----|-------------|-------|
| F-17 | PDF export of log sheets | ReportLab or WeasyPrint on backend |
| F-18 | 34-hour restart option | Checkbox input; resets cycle to 0 |
| F-19 | Sleeper berth split provision | Complex pairing logic; skip for v1 |
| F-20 | Saved trip history | Requires auth + database persistence |

---

## 6. Technical Requirements

### 6.1 Backend (Django)

| Requirement | Detail |
|-------------|--------|
| Framework | Django 4.x + Django REST Framework |
| Endpoint | `POST /api/plan-trip/` |
| Input validation | DRF serializer; all 4 fields required |
| HOS engine | Pure Python module `hos_engine.py`; no Django dependencies |
| Routing module | `routing.py` wraps OpenRouteService API calls |
| ELD builder | `eld_builder.py` converts HOS timeline → per-day log data |
| CORS | `django-cors-headers` configured for Vercel frontend origin |
| Environment | ORS API key in `.env`, never hardcoded |
| Error handling | Return 400 with `{ error: "..." }` on bad input or API failure |
| Response time | < 5 seconds for typical trips (< 3,000 miles) |

### 6.2 Frontend (React)

| Requirement | Detail |
|-------------|--------|
| Framework | React 18 + Vite |
| Map library | `react-leaflet` + `leaflet` (OpenStreetMap tiles, no API key) |
| Canvas rendering | Native HTML5 Canvas API (no canvas library dependency) |
| State management | React `useState` / `useEffect` (no Redux needed) |
| HTTP client | `fetch` or `axios` to Django API |
| Layout | Left panel: form (30% width). Right panel: map + logs (70% width) |
| Deployment | Vercel (static export or SPA) |

### 6.3 External APIs

| API | Usage | Free Tier | Key Required |
|-----|-------|-----------|--------------|
| OpenRouteService Directions | Route polyline, distance, duration | 2,000 req/day | Yes (free signup) |
| OpenRouteService Geocoding | Text location → lat/lng | 2,000 req/day | Same key |
| OpenStreetMap (via Leaflet) | Map tile rendering | Unlimited | No |

### 6.4 Hosting

| Layer | Platform | Notes |
|-------|----------|-------|
| Frontend | Vercel | Free tier; auto-deploy from GitHub |
| Backend | Railway | Free tier; no sleep (unlike Render) |
| Database | None (v1) | Stateless; no persistence needed |

---

## 7. API Contract

### Request

```
POST /api/plan-trip/
Content-Type: application/json
```

```json
{
  "current_location": "Chicago, IL",
  "pickup_location": "Dallas, TX",
  "dropoff_location": "Los Angeles, CA",
  "current_cycle_used": 24.5
}
```

### Response — Success (200)

```json
{
  "route": {
    "total_miles": 1847,
    "total_days": 3,
    "polyline": [[41.8781, -87.6298], [32.7767, -96.7970], ...],
    "stops": [
      {
        "type": "pickup",
        "label": "Pickup",
        "location": "Dallas, TX",
        "lat": 32.7767,
        "lng": -96.7970,
        "day": 1,
        "time_of_day_min": 480,
        "duration_min": 60,
        "miles_mark": 921
      },
      {
        "type": "fuel",
        "label": "Fuel Stop",
        "location": "Near Amarillo, TX",
        "lat": 35.2219,
        "lng": -101.8313,
        "day": 2,
        "time_of_day_min": 600,
        "duration_min": 30,
        "miles_mark": 1421
      },
      {
        "type": "rest",
        "label": "10-hr Rest",
        "location": "Rest Stop — Amarillo, TX area",
        "lat": 35.2219,
        "lng": -101.8313,
        "day": 1,
        "time_of_day_min": 900,
        "duration_min": 600,
        "miles_mark": 1100
      },
      {
        "type": "dropoff",
        "label": "Dropoff",
        "location": "Los Angeles, CA",
        "lat": 34.0522,
        "lng": -118.2437,
        "day": 3,
        "time_of_day_min": 720,
        "duration_min": 60,
        "miles_mark": 1847
      }
    ]
  },
  "eld_logs": [
    {
      "day": 1,
      "date": "2026-06-16",
      "miles_driven": 660,
      "events": [
        { "status": "off_duty",   "startMin": 0,    "endMin": 360  },
        { "status": "on_duty_nd", "startMin": 360,  "endMin": 390  },
        { "status": "driving",    "startMin": 390,  "endMin": 870  },
        { "status": "on_duty_nd", "startMin": 870,  "endMin": 900  },
        { "status": "driving",    "startMin": 900,  "endMin": 1080 },
        { "status": "on_duty_nd", "startMin": 1080, "endMin": 1140 },
        { "status": "off_duty",   "startMin": 1140, "endMin": 1440 }
      ],
      "totals": {
        "off_duty": 11.0,
        "sleeper_berth": 0.0,
        "driving": 11.0,
        "on_duty_nd": 2.0
      },
      "remarks": [
        { "min": 0,    "text": "Chicago, IL — Off Duty" },
        { "min": 360,  "text": "Chicago, IL — Pre-trip" },
        { "min": 870,  "text": "Springfield, IL — Fuel" },
        { "min": 1080, "text": "Dallas, TX — Pickup" },
        { "min": 1140, "text": "Dallas, TX — Rest" }
      ],
      "hos_check": {
        "driving_hrs": 11.0,
        "driving_limit": 11.0,
        "window_hrs": 13.0,
        "window_limit": 14.0,
        "cycle_used_after_day": 37.5,
        "cycle_limit": 70.0,
        "compliant": true
      }
    }
  ]
}
```

### Response — Error (400)

```json
{
  "error": "Could not geocode location: 'xyz abc'",
  "field": "pickup_location"
}
```

---

## 8. ELD Log Sheet Requirements

### 8.1 Visual Spec (Canvas)

| Element | Requirement |
|---------|-------------|
| Grid | 24-hour span, Midnight → Midnight |
| Hour labels | Midnight, 1, 2 ... 11, Noon, 13 ... 23, Midnight |
| Tick marks | Major lines every hour; minor ticks every 15 minutes at grid bottom |
| Rows | 4 rows: Off Duty, Sleeper Berth, Driving, On Duty (Not Driving) |
| Status bars | Solid colored horizontal fill in the active row for each event |
| Connectors | Vertical line connecting rows at every status change |
| Total hours | Displayed on right side of each row; sum must equal 24 |
| Remarks | Location annotation at each status change; rotated diagonal text |
| Header | Date, total miles, carrier name, main office, driver name, vehicle no. |

### 8.2 Status Color Coding

| Status | Color |
|--------|-------|
| Off Duty | Blue `#4A7FC1` |
| Sleeper Berth | Purple `#9B8FD4` |
| Driving | Orange/Amber `#E8A020` |
| On Duty (Not Driving) | Green `#4CAF50` |

### 8.3 Validation Rules

| Rule | Enforcement |
|------|-------------|
| All events in a day must sum to 1440 minutes | Backend validation before returning |
| No overlapping events | Events must be contiguous and non-overlapping |
| No event can span midnight | Events are bounded to 0–1440 min of their day |
| Driving total ≤ 660 min (11 hrs) | Backend HOS engine enforces |
| Driving + On Duty ND ≤ 840 min (14 hrs) within window | Backend HOS engine enforces |

### 8.4 Multiple Log Sheets

- One `<ELDLogSheet />` component renders per day in `eld_logs[]`.
- Days are displayed in chronological order below the map.
- A day counter badge ("Day 1 of 3") is shown above each sheet.

---

## 9. Map Requirements

### 9.1 Route Display

| Requirement | Implementation |
|-------------|----------------|
| Route polyline | Decoded from ORS response; drawn as `<Polyline>` on Leaflet |
| Polyline color | `#1a2744` (dark navy) with 4px weight |
| Map bounds | Auto-fit to show full route on load (`fitBounds`) |
| Tile provider | OpenStreetMap (free, no API key) |

### 9.2 Stop Markers

| Stop Type | Marker Color | Popup Content |
|-----------|-------------|---------------|
| Pickup | Green | "Pickup — 1 hr On Duty ND" |
| Dropoff | Red | "Dropoff — 1 hr On Duty ND" |
| Fuel Stop | Yellow | "Fuel Stop — 30 min On Duty ND" |
| 10-hr Rest | Blue | "Rest — 10 hrs Off Duty" |
| 30-min Break | Grey | "Break — 30 min" |

### 9.3 Sidebar Stop List

A scrollable list below the form showing all stops in order:

```
📦 Pickup — Dallas, TX — Day 1, 9:00 AM — 60 min
⛽ Fuel Stop — Amarillo, TX — Day 2, 10:00 AM — 30 min
🛏 Rest — Amarillo, TX — Day 1, 8:00 PM — 10 hrs
📦 Dropoff — Los Angeles, CA — Day 3, 2:00 PM — 60 min
```

---

## 10. Acceptance Criteria

### AC-01: Correct 30-Minute Break Injection

- **Given** a trip segment where cumulative driving reaches 8 hours without any non-driving break ≥ 30 min  
- **When** the HOS engine processes that segment  
- **Then** it injects a 30-minute On Duty ND break and resets the cumulative counter to 0  
- **And** the break does NOT appear if the driver already had a pickup/fuel stop ≥ 30 min within those 8 hours

### AC-02: 14-Hour Window Enforcement

- **Given** a driver starts their shift at minute 0  
- **When** driving + on_duty_nd time combined would exceed 840 minutes from shift start  
- **Then** the engine stops driving and injects a 10-hr rest regardless of driving hours remaining  
- **And** the 14-hour window resets after the 10-hr rest

### AC-03: Cycle Limit Enforcement

- **Given** `current_cycle_used = 65` hours  
- **When** the trip would require > 5 additional on-duty hours  
- **Then** the engine caps driving at the remaining cycle hours available  
- **And** the response includes a warning: `"cycle_warning": "Driver exhausts 70-hr cycle on Day 2"`

### AC-04: ELD Log Sheet Sums to 24 Hours

- **Given** any valid trip day in the response  
- **When** all event durations in `events[]` are summed  
- **Then** the total equals exactly 1440 minutes  
- **And** `totals.off_duty + totals.sleeper_berth + totals.driving + totals.on_duty_nd = 24.0`

### AC-05: Fuel Stops Injected Every 1,000 Miles

- **Given** a trip of 1,500 miles  
- **When** the HOS engine processes the route  
- **Then** at least 1 fuel stop appears at or before mile 1,000  
- **And** a second fuel stop appears at or before mile 1,500 (if driving continues past 1,000 miles)

### AC-06: Map Renders Full Route

- **Given** the API returns a successful response  
- **When** the frontend renders the map  
- **Then** the polyline covers the full route from current → pickup → dropoff  
- **And** all stops are marked with correct colored markers  
- **And** the map auto-zooms to show all markers

### AC-07: ELD Canvas Renders Correctly

- **Given** a day with events of statuses: off_duty, on_duty_nd, driving, off_duty  
- **When** the Canvas draws the log sheet  
- **Then** each event appears as a filled horizontal bar in the correct row  
- **And** vertical connector lines appear at each status transition  
- **And** total hours are shown on the right side of each row

---

## 11. Success Metrics

### Leading Indicators (testable by the evaluator)

| Metric | Target | How to Test |
|--------|--------|-------------|
| Route accuracy | Polyline matches expected path | Visual inspection |
| ELD log sum | Always = 24 hrs | Check `totals` in API response |
| Break injection | Present when 8-hr threshold hit | Use a trip > 8 hrs driving |
| Fuel stop injection | Present every 1,000 miles | Use a 1,500+ mile trip |
| Cycle deduction | Correct remaining cycle | Set `current_cycle_used = 65`, check output |
| Multi-day generation | Correct log count | Use a 1,800-mile trip; expect 2–3 logs |

### Quality Indicators

| Metric | Target |
|--------|--------|
| API response time | < 5 seconds |
| Map load time | < 2 seconds |
| Mobile usability | No horizontal scroll on 375px viewport |
| Form validation | Prevent submission with empty fields |
| UI design score | Clean, professional; matches assessment's "pay attention to design" note |

---

## 12. Open Questions

| # | Question | Owner | Blocking? |
|---|----------|-------|-----------|
| Q1 | What speed (mph) to assume for route segments? ORS gives duration; should we trust it? | Engineering | No — use ORS duration directly |
| Q2 | What timezone should log sheets use for time display? | Assessment spec unclear | No — assume driver home terminal timezone = trip start location |
| Q3 | Should the 30-minute break be `off_duty` or `on_duty_nd`? | FMCSA allows either | No — use `on_duty_nd` for simplicity |
| Q4 | How to handle geocoding if ORS can't find a location? | Engineering | Yes — return 400 with clear error |
| Q5 | Should trips spanning > 7 days hit the 70-hr cycle limit? | Engineering | No — for assessment trips, flag and halt |
| Q6 | Where does the 10-hr rest actually happen geographically? | Design | No — show rest at last known driving location |

---

## 13. Timeline & Phases

### Phase 1 — Core Engine (Days 1–2)
- [ ] `hos_engine.py` — full HOS state machine, unit-tested
- [ ] `routing.py` — ORS API wrapper (geocoding + directions)
- [ ] `eld_builder.py` — timeline → per-day log data
- [ ] `POST /api/plan-trip/` — wired end-to-end

### Phase 2 — Frontend Map (Day 3)
- [ ] React project setup (Vite)
- [ ] `TripForm.jsx` — 4 inputs + submit
- [ ] `RouteMap.jsx` — Leaflet map + polyline + markers
- [ ] `StopsList.jsx` — sidebar stop summary

### Phase 3 — ELD Log Sheets (Days 4–5)
- [ ] `ELDLogSheet.jsx` — full Canvas drawing function
- [ ] Multi-day rendering (one sheet per day)
- [ ] HOS compliance summary panel

### Phase 4 — Polish + Deploy (Days 6–7)
- [ ] UI design pass (responsive layout, colors, typography)
- [ ] Deploy Django to Railway
- [ ] Deploy React to Vercel
- [ ] Record Loom walkthrough (3–5 min)
- [ ] Final accuracy testing across 3 test routes

### Test Routes for Validation

| Route | Miles (approx) | Expected Days | Cycle Used Input |
|-------|---------------|---------------|-----------------|
| Chicago → Dallas → LA | 1,847 | 2–3 | 24.5 hrs |
| NYC → Miami → Houston | 2,400 | 3–4 | 10.0 hrs |
| Seattle → SF → Phoenix | 1,600 | 2 | 55.0 hrs (cycle stress test) |

---

*This PRD covers all requirements needed to build, test, and ship the ELD Trip Planner assessment. The HOS engine (Section 4) is the critical path — everything else is plumbing around it.*
