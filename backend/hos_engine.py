"""
HOS (Hours of Service) state machine for FMCSA 49 CFR Part 395.
Property-carrying driver, 70hr/8-day cycle, no sleeper berth split.

All internal time is in absolute minutes from trip epoch (midnight of day 1).
"""
from dataclasses import dataclass, field
from typing import Optional


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

@dataclass
class TripInput:
    current_cycle_used_hrs: float
    segments: list          # [{"distance_miles": float, "duration_sec": float}, ...]
    pickup_coords: dict     # {"lat": float, "lng": float, "label": str}
    dropoff_coords: dict
    waypoint_coords: list   # [current, pickup, dropoff] — each {lat, lng, label}
    shift_start_min: int = 360  # default 6:00 AM


@dataclass
class TimelineEvent:
    status: str             # "off_duty" | "driving" | "on_duty_nd"
    start_min: int
    end_min: int
    location_label: str
    lat: float
    lng: float
    miles_mark: float       # odometer at start of this event
    event_type: str         # "off_duty_start" | "pre_trip" | "driving" | "pickup" |
                            # "dropoff" | "fuel" | "rest" | "break"
    cycle_snapshot: int = 0  # cycle_min_used at end of this event
    miles_covered: float = 0.0  # miles driven during this event (driving events only)


# ---------------------------------------------------------------------------
# Simulation state (module-level so helpers can mutate it without threading risk
# — this is a synchronous, single-threaded call)
# ---------------------------------------------------------------------------

class _State:
    def __init__(self, trip: TripInput):
        self.current_time_min: int = 0
        self.driving_min_today: int = 0
        self.window_start_min: Optional[int] = None
        self.window_expires_min: Optional[int] = None
        self.cumul_driving_since_break: int = 0
        self.cycle_min_used: int = int(trip.current_cycle_used_hrs * 60)
        self.miles_since_fuel: float = 0.0
        self.total_miles: float = 0.0
        self.timeline: list = []
        self.stops: list = []
        self.cycle_warning: Optional[str] = None
        self.halted: bool = False
        # Track current geographic position
        self.current_lat: float = trip.waypoint_coords[0]["lat"]
        self.current_lng: float = trip.waypoint_coords[0]["lng"]
        self.current_label: str = trip.waypoint_coords[0]["label"]


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def run_simulation(trip: TripInput) -> dict:
    s = _State(trip)

    # 1. Off-duty block before shift starts (midnight → shift_start_min)
    if trip.shift_start_min > 0:
        _emit(s, "off_duty", trip.shift_start_min, "off_duty_start")
        s.current_time_min = trip.shift_start_min  # advance to shift start

    # 2. Open first shift (pre-trip inspection + window)
    _open_shift(s)

    if s.halted:
        return _finalize(s, trip)

    # 3. Drive current → pickup
    seg0 = trip.segments[0]
    _process_driving_segment(
        s,
        distance_miles=seg0["distance_miles"],
        duration_sec=seg0["duration_sec"],
        dest_coords=trip.pickup_coords,
    )

    if s.halted:
        return _finalize(s, trip)

    # 4. Pickup stop (60 min On Duty ND)
    _inject_fixed_stop(s, 60, "pickup", trip.pickup_coords, "Pickup")
    s.current_lat = trip.pickup_coords["lat"]
    s.current_lng = trip.pickup_coords["lng"]
    s.current_label = trip.pickup_coords["label"]

    if s.halted:
        return _finalize(s, trip)

    # 5. Drive pickup → dropoff
    seg1 = trip.segments[1]
    _process_driving_segment(
        s,
        distance_miles=seg1["distance_miles"],
        duration_sec=seg1["duration_sec"],
        dest_coords=trip.dropoff_coords,
    )

    if s.halted:
        return _finalize(s, trip)

    # 6. Dropoff stop (60 min On Duty ND)
    _inject_fixed_stop(s, 60, "dropoff", trip.dropoff_coords, "Dropoff")
    s.current_lat = trip.dropoff_coords["lat"]
    s.current_lng = trip.dropoff_coords["lng"]
    s.current_label = trip.dropoff_coords["label"]

    # 7. Fill remainder of final calendar day to midnight
    _fill_to_midnight(s)

    return _finalize(s, trip)


# ---------------------------------------------------------------------------
# Core driving loop
# ---------------------------------------------------------------------------

def _process_driving_segment(s: _State, distance_miles: float, duration_sec: float, dest_coords: dict):
    """Advance through a driving segment, injecting HOS-mandated stops as needed."""
    remaining_miles = distance_miles
    remaining_sec = duration_sec

    # Interpolation helper: fraction of segment completed so far
    def _interp_coords(fraction: float) -> tuple:
        lat = s.current_lat + (dest_coords["lat"] - s.current_lat) * fraction
        lng = s.current_lng + (dest_coords["lng"] - s.current_lng) * fraction
        return lat, lng

    fraction_done = 0.0

    while remaining_miles > 0.001:
        # --- Priority checks (inject stop and continue) ---

        # 1. Cycle exhausted
        if s.cycle_min_used >= 4200:
            day_num = s.current_time_min // 1440 + 1
            s.cycle_warning = f"Driver exhausts 70-hr cycle on Day {day_num}"
            _fill_to_midnight(s)
            s.halted = True
            return

        # 2. 14-hr window expired
        if s.window_expires_min is not None and s.current_time_min >= s.window_expires_min:
            _inject_rest(s)
            continue

        # 3. 11-hr driving limit reached
        if s.driving_min_today >= 660:
            _inject_rest(s)
            continue

        # 4. Fuel stop needed
        if s.miles_since_fuel >= 1000:
            _inject_fuel_stop(s)
            continue

        # 5. 30-min break needed
        if s.cumul_driving_since_break >= 480:
            _inject_break(s)
            continue

        # --- Compute how far we can drive before the next forced stop ---

        # Pace in min/mile (recalculate each iteration to avoid drift)
        if remaining_miles < 0.001:
            break
        pace_min_per_mile = (remaining_sec / 60.0) / remaining_miles

        # Headroom in each constraint (minutes)
        drive_limit_remaining = 660 - s.driving_min_today
        break_remaining = 480 - s.cumul_driving_since_break
        fuel_remaining_min = (1000.0 - s.miles_since_fuel) * pace_min_per_mile
        segment_remaining_min = remaining_sec / 60.0
        cycle_remaining_min = max(0.0, 4200 - s.cycle_min_used)

        if s.window_expires_min is not None:
            window_remaining = s.window_expires_min - s.current_time_min
        else:
            window_remaining = float("inf")

        # Tightest constraint
        can_drive_min = min(
            drive_limit_remaining,
            break_remaining,
            fuel_remaining_min,
            window_remaining,
            segment_remaining_min,
            cycle_remaining_min,
        )
        can_drive_min = max(can_drive_min, 0)

        if can_drive_min < 0.5:
            # Effectively zero — a constraint is right at the boundary; re-check
            # Advance time by 1 min to avoid infinite loop
            can_drive_min = 1.0

        can_drive_miles = can_drive_min / pace_min_per_mile if pace_min_per_mile > 0 else remaining_miles
        can_drive_miles = min(can_drive_miles, remaining_miles)
        can_drive_min = can_drive_miles * pace_min_per_mile

        # Round to int minutes (floor) to keep timeline clean
        drive_min_int = max(1, int(can_drive_min))
        drive_miles = drive_min_int / pace_min_per_mile if pace_min_per_mile > 0 else can_drive_miles
        drive_miles = min(drive_miles, remaining_miles)

        # Compute interpolated coordinates at end of this chunk
        new_fraction = fraction_done + (drive_miles / distance_miles)
        new_fraction = min(new_fraction, 1.0)
        end_lat, end_lng = _interp_coords(new_fraction)

        # Emit driving event
        _emit(s, "driving", drive_min_int, "driving",
              miles_covered=drive_miles,
              end_lat=end_lat, end_lng=end_lng)

        # Advance state
        s.current_time_min += drive_min_int
        s.driving_min_today += drive_min_int
        s.cumul_driving_since_break += drive_min_int
        s.cycle_min_used += drive_min_int
        s.total_miles += drive_miles
        s.miles_since_fuel += drive_miles
        remaining_miles -= drive_miles
        remaining_sec -= drive_min_int * 60.0
        remaining_sec = max(remaining_sec, 0)
        fraction_done = new_fraction
        # Backfill snapshot now that cycle is updated
        s.timeline[-1].cycle_snapshot = s.cycle_min_used

        # Update current position
        s.current_lat = end_lat
        s.current_lng = end_lng

        # Check if cycle was exhausted during this driving chunk
        if s.cycle_min_used >= 4200 and remaining_miles > 0.001:
            day_num = s.current_time_min // 1440 + 1
            s.cycle_warning = f"Driver exhausts 70-hr cycle on Day {day_num}"
            _fill_to_midnight(s)
            s.halted = True
            return

    # Arrival at destination
    s.current_lat = dest_coords["lat"]
    s.current_lng = dest_coords["lng"]
    s.current_label = dest_coords["label"]


# ---------------------------------------------------------------------------
# Stop injectors
# ---------------------------------------------------------------------------

def _open_shift(s: _State):
    """Begin a new driving shift: set 14-hr window, add pre-trip inspection."""
    s.window_start_min = s.current_time_min
    s.window_expires_min = s.current_time_min + 840
    # Pre-trip inspection: 30 min On Duty ND
    _emit(s, "on_duty_nd", 30, "pre_trip")
    s.cycle_min_used += 30
    s.current_time_min += 30


def _inject_rest(s: _State):
    """Inject a mandatory 10-hr (600-min) off-duty rest, then open next shift."""
    _emit(s, "off_duty", 600, "rest")
    s.stops.append(_make_stop(s, "rest", "10-hr Rest", 600))
    s.current_time_min += 600
    # Reset daily accumulators
    s.driving_min_today = 0
    s.window_start_min = None
    s.window_expires_min = None
    s.cumul_driving_since_break = 0
    # Open next shift
    _open_shift(s)


def _inject_fuel_stop(s: _State):
    """Inject a 30-min fuel stop (On Duty ND)."""
    _emit(s, "on_duty_nd", 30, "fuel")
    s.stops.append(_make_stop(s, "fuel", "Fuel Stop", 30))
    s.cycle_min_used += 30
    s.miles_since_fuel = 0.0
    s.cumul_driving_since_break = 0  # 30 min non-driving resets break counter
    s.current_time_min += 30


def _inject_break(s: _State):
    """Inject a mandatory 30-min break (On Duty ND)."""
    _emit(s, "on_duty_nd", 30, "break")
    s.stops.append(_make_stop(s, "break", "30-min Break", 30))
    s.cycle_min_used += 30
    s.cumul_driving_since_break = 0
    s.current_time_min += 30


def _inject_fixed_stop(s: _State, duration_min: int, stop_type: str, coords: dict, label: str):
    """Inject a fixed-duration On Duty ND stop (pickup or dropoff)."""
    _emit(s, "on_duty_nd", duration_min, stop_type)
    s.stops.append({
        "type": stop_type,
        "label": label,
        "location": coords["label"],
        "lat": coords["lat"],
        "lng": coords["lng"],
        "day": s.current_time_min // 1440 + 1,
        "time_of_day_min": s.current_time_min % 1440,
        "duration_min": duration_min,
        "miles_mark": round(s.total_miles, 1),
    })
    s.cycle_min_used += duration_min
    s.cumul_driving_since_break = 0  # ≥30 min non-driving resets break counter
    s.current_time_min += duration_min


def _fill_to_midnight(s: _State):
    """Fill the remainder of the current calendar day with Off Duty."""
    day_boundary = ((s.current_time_min // 1440) + 1) * 1440
    remaining = day_boundary - s.current_time_min
    if remaining > 0:
        _emit(s, "off_duty", remaining, "off_duty_start")
        s.current_time_min += remaining


# ---------------------------------------------------------------------------
# Timeline helpers
# ---------------------------------------------------------------------------

def _emit(s: _State, status: str, duration_min: int, event_type: str,
          miles_covered: float = 0.0, end_lat: float = None, end_lng: float = None):
    """Append a TimelineEvent to the timeline."""
    event = TimelineEvent(
        status=status,
        start_min=s.current_time_min,
        end_min=s.current_time_min + duration_min,
        location_label=s.current_label,
        lat=s.current_lat,
        lng=s.current_lng,
        miles_mark=round(s.total_miles, 1),
        event_type=event_type,
        cycle_snapshot=s.cycle_min_used,
        miles_covered=round(miles_covered, 2),
    )
    s.timeline.append(event)


def _make_stop(s: _State, stop_type: str, label: str, duration_min: int) -> dict:
    return {
        "type": stop_type,
        "label": label,
        "location": s.current_label,
        "lat": s.current_lat,
        "lng": s.current_lng,
        "day": s.current_time_min // 1440 + 1,
        "time_of_day_min": s.current_time_min % 1440,
        "duration_min": duration_min,
        "miles_mark": round(s.total_miles, 1),
    }


def _finalize(s: _State, trip: TripInput) -> dict:
    return {
        "timeline": s.timeline,
        "stops": s.stops,
        "total_miles": round(s.total_miles, 1),
        "polyline": [],  # polyline comes from routing module, passed through view
        "cycle_warning": s.cycle_warning,
    }
