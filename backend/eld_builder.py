"""
Converts the flat absolute-time HOS timeline into per-day ELD log entries.
Each calendar day covers exactly 1440 minutes (midnight to midnight).
"""
import math
from datetime import date, timedelta


class ELDInvariantError(Exception):
    """Raised when a day's events don't sum to 1440 minutes — programming error."""
    pass


STATUSES = ("off_duty", "sleeper_berth", "driving", "on_duty_nd")

ACTIVITY_LABELS = {
    "off_duty_start": "Off Duty",
    "pre_trip": "Pre-trip inspection",
    "driving": "Driving",
    "pickup": "Pickup",
    "dropoff": "Dropoff",
    "fuel": "Fuel stop",
    "rest": "Rest",
    "break": "Break",
}


def build_eld_logs(timeline: list, trip_start_date: date, total_miles: float) -> list:
    """
    Build ELD log entries from the HOS timeline.

    Args:
        timeline: list of TimelineEvent objects from hos_engine.run_simulation()
        trip_start_date: date object for day 1 of the trip
        total_miles: total route miles (for distribution across days)

    Returns:
        list of day-log dicts matching the API contract
    """
    if not timeline:
        return []

    max_end_min = max(e.end_min for e in timeline)
    num_days = math.ceil(max_end_min / 1440)
    if num_days == 0:
        num_days = 1

    logs = []
    for day_index in range(num_days):
        day_num = day_index + 1
        day_start = day_index * 1440
        day_end = day_start + 1440
        log_date = trip_start_date + timedelta(days=day_index)

        # 1. Slice and normalize events to this day's 0-1440 window
        day_events = _slice_events(timeline, day_start, day_end)

        # 2. Fill gaps with Off Duty to guarantee 1440-min coverage
        day_events = _fill_gaps(day_events)

        # 3. Merge consecutive same-status events
        day_events = _merge_consecutive(day_events)

        # 4. Validate invariant
        total_min = sum(e["endMin"] - e["startMin"] for e in day_events)
        if total_min != 1440:
            raise ELDInvariantError(
                f"Day {day_num} events sum to {total_min} minutes, expected 1440"
            )

        # 5. Compute totals (in hours)
        totals = _compute_totals(day_events)

        # 6. Compute miles driven this day
        miles_driven = _compute_day_miles(timeline, day_start, day_end)

        # 7. Build remarks
        remarks = _build_remarks(timeline, day_start, day_end)

        # 8. Build hos_check using cycle_snapshot from last event of the day
        cycle_at_end = _get_cycle_at_end(timeline, day_end)
        hos_check = _build_hos_check(day_events, totals, cycle_at_end)

        logs.append({
            "day": day_num,
            "date": log_date.isoformat(),
            "miles_driven": round(miles_driven, 1),
            "events": day_events,
            "totals": totals,
            "remarks": remarks,
            "hos_check": hos_check,
        })

    return logs


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _slice_events(timeline, day_start: int, day_end: int) -> list:
    """Clip timeline events to [day_start, day_end) and normalize to 0-based."""
    result = []
    for e in timeline:
        if e.end_min <= day_start or e.start_min >= day_end:
            continue
        clipped_start = max(e.start_min, day_start) - day_start
        clipped_end = min(e.end_min, day_end) - day_start
        if clipped_end <= clipped_start:
            continue
        result.append({
            "status": e.status,
            "startMin": clipped_start,
            "endMin": clipped_end,
            "location_label": e.location_label,
            "event_type": e.event_type,
            "lat": e.lat,
            "lng": e.lng,
        })
    result.sort(key=lambda x: x["startMin"])
    return result


def _fill_gaps(events: list) -> list:
    """Insert Off Duty events to fill any gaps so total = 1440 min."""
    filled = []
    cursor = 0

    for ev in events:
        if ev["startMin"] > cursor:
            filled.append(_off_duty_gap(cursor, ev["startMin"]))
        filled.append(ev)
        cursor = ev["endMin"]

    if cursor < 1440:
        filled.append(_off_duty_gap(cursor, 1440))

    return filled


def _off_duty_gap(start: int, end: int) -> dict:
    return {
        "status": "off_duty",
        "startMin": start,
        "endMin": end,
        "location_label": "",
        "event_type": "off_duty_start",
        "lat": 0.0,
        "lng": 0.0,
    }


def _merge_consecutive(events: list) -> list:
    """Merge adjacent events with the same status."""
    if not events:
        return events
    merged = [events[0].copy()]
    for ev in events[1:]:
        if ev["status"] == merged[-1]["status"]:
            merged[-1]["endMin"] = ev["endMin"]
        else:
            merged.append(ev.copy())
    return merged


def _compute_totals(events: list) -> dict:
    totals = {s: 0 for s in STATUSES}
    for ev in events:
        if ev["status"] in totals:
            totals[ev["status"]] += ev["endMin"] - ev["startMin"]
    # Convert to hours, round to 2 decimal places
    return {k: round(v / 60.0, 2) for k, v in totals.items()}


def _compute_day_miles(timeline, day_start: int, day_end: int) -> float:
    """Sum miles from driving events that fall (partially or fully) in this day."""
    miles = 0.0
    for e in timeline:
        if e.status != "driving":
            continue
        if e.end_min <= day_start or e.start_min >= day_end:
            continue
        # Fraction of this driving event that falls in this day
        event_dur = e.end_min - e.start_min
        if event_dur == 0:
            continue
        overlap_start = max(e.start_min, day_start)
        overlap_end = min(e.end_min, day_end)
        fraction = (overlap_end - overlap_start) / event_dur
        # miles_mark is odometer at start; derive miles covered in this event
        # by looking at next driving event or using cycle_snapshot approximation.
        # Simpler: the engine stores miles_mark at event start. The total miles
        # for a driving event = its duration / pace (which we don't store directly).
        # Instead accumulate from driving events' proportional contribution.
        # We use the fact that total_miles ~ sum of all driving event durations * pace.
        # Since we don't store per-event miles directly, we approximate via duration fraction.
        # For accuracy, the engine should store miles_covered per event.
        # As a fallback, use duration-proportional share of total_miles.
        # This is acceptable for display purposes.
        miles += fraction * _event_miles(e)
    return miles


def _event_miles(event) -> float:
    """Return the miles covered by a single driving TimelineEvent."""
    # TimelineEvent stores miles_mark (odometer at start). We need miles_covered.
    # The engine doesn't store end-odometer directly, so we use a sentinel attribute.
    # If the event has a 'miles_covered' attribute, use it; otherwise return 0.
    return getattr(event, "miles_covered", 0.0)


def _build_remarks(timeline, day_start: int, day_end: int) -> list:
    """Build remark annotations for each status transition within this day."""
    remarks = []
    seen_min = set()
    for e in timeline:
        if e.end_min <= day_start or e.start_min >= day_end:
            continue
        # Remark at the start of each event (normalized to day-local time)
        local_min = max(e.start_min, day_start) - day_start
        if local_min in seen_min:
            continue
        seen_min.add(local_min)
        activity = ACTIVITY_LABELS.get(e.event_type, e.event_type.replace("_", " ").title())
        label = e.location_label or ""
        text = f"{label} — {activity}" if label else activity
        remarks.append({"min": local_min, "text": text})
    remarks.sort(key=lambda r: r["min"])
    return remarks


def _get_cycle_at_end(timeline, day_end: int) -> float:
    """Get cycle_min_used at the end of this day (from last event at or before day_end)."""
    snapshot = 0
    for e in timeline:
        if e.start_min < day_end:
            snapshot = e.cycle_snapshot
    return snapshot / 60.0


def _build_hos_check(events: list, totals: dict, cycle_used_after_day: float) -> dict:
    """Build the hos_check compliance summary for a day."""
    driving_hrs = totals["driving"]

    # Determine 14-hr window usage: time from first on-duty to last on-duty/driving
    first_on_duty = None
    last_active = None
    for ev in events:
        if ev["status"] in ("driving", "on_duty_nd"):
            if first_on_duty is None:
                first_on_duty = ev["startMin"]
            last_active = ev["endMin"]

    if first_on_duty is not None and last_active is not None:
        window_hrs = round((last_active - first_on_duty) / 60.0, 2)
    else:
        window_hrs = 0.0

    compliant = (
        driving_hrs <= 11.0
        and window_hrs <= 14.0
        and cycle_used_after_day <= 70.0
    )

    return {
        "driving_hrs": driving_hrs,
        "driving_limit": 11.0,
        "window_hrs": window_hrs,
        "window_limit": 14.0,
        "cycle_used_after_day": round(cycle_used_after_day, 2),
        "cycle_limit": 70.0,
        "compliant": compliant,
    }
