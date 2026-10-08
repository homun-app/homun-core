"""Pure cron parsing and next-occurrence calculations."""
import datetime as dt_mod
import re
import time
from datetime import datetime, timezone
from typing import Any, Dict, Optional, Set
from homun.application.cron_contracts import CronJob

_INTERVAL_RE = re.compile(
    r"^\s*(?:every\s+)?(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)\s*$",
    re.IGNORECASE,
)
_UNIT_SECONDS = {
    "s": 1, "sec": 1, "secs": 1, "second": 1, "seconds": 1,
    "m": 60, "min": 60, "mins": 60, "minute": 60, "minutes": 60,
    "h": 3600, "hr": 3600, "hrs": 3600, "hour": 3600, "hours": 3600,
    "d": 86400, "day": 86400, "days": 86400,
}

AGENT_RUNNER_UNAVAILABLE = (
    "Cron prompt/skills jobs require an injected agent runner; "
    "no synthetic success is returned without a real execution backend."
)


def parse_schedule(schedule_str: str) -> Dict[str, Any]:
    """Parse schedule into structured kind and details."""
    raw = (schedule_str or "").strip()
    if not raw:
        raise ValueError("schedule string cannot be empty")

    # 1. Event trigger: on event:<name>
    if raw.lower().startswith("on event:"):
        event_name = raw[9:].strip()
        if not event_name:
            raise ValueError("Event name cannot be empty in 'on event:<name>'")
        return {"kind": "event", "event": event_name, "raw": raw}

    # 2. Relative interval: every 2h / 30m
    m = _INTERVAL_RE.match(raw)
    if m:
        seconds = int(float(m.group(1)) * _UNIT_SECONDS[m.group(2).lower()])
        return {"kind": "interval", "seconds": max(1, seconds), "raw": raw}

    # 3. One-shot: at <iso> / once: <iso>
    if raw.lower().startswith("once:") or raw.lower().startswith("at "):
        prefix_len = 5 if raw.lower().startswith("once:") else 3
        iso_part = raw[prefix_len:].strip()
        try:
            dt = datetime.fromisoformat(iso_part.replace("Z", "+00:00"))
            return {"kind": "once", "timestamp": dt.timestamp(), "raw": raw}
        except Exception as exc:
            raise ValueError(f"Invalid one-shot ISO timestamp: {iso_part!r}") from exc

    # 4. Standard cron: 5 or 6 fields
    parts = raw.split()
    if len(parts) in {5, 6}:
        return {"kind": "cron", "cron": raw, "raw": raw}

    raise ValueError(f"Unrecognized schedule format: {raw!r}")


def _parse_cron_field(expr: str, min_v: int, max_v: int) -> Set[int]:
    """Parse a single field of a cron expression into valid integer values."""
    expr = expr.strip()
    res: Set[int] = set()
    for part in expr.split(","):
        part = part.strip()
        if not part:
            continue
        step = 1
        if "/" in part:
            subparts = part.split("/", 1)
            part = subparts[0]
            step = int(subparts[1])
        if part == "*":
            start_v, end_v = min_v, max_v
        elif "-" in part:
            start_s, end_s = part.split("-", 1)
            start_v, end_v = int(start_s), int(end_s)
        else:
            start_v = end_v = int(part)
        for v in range(start_v, end_v + 1, step):
            if min_v <= v <= max_v:
                res.add(v)
    return res


def compute_next_cron(cron_expr: str, now: float) -> float:
    """Compute next matching unix timestamp for a 5- or 6-field cron expression in pure Python."""
    parts = cron_expr.strip().split()
    if len(parts) == 6:
        parts = parts[1:]
    if len(parts) != 5:
        return now + 3600.0

    min_set = _parse_cron_field(parts[0], 0, 59)
    hr_set = _parse_cron_field(parts[1], 0, 23)
    dom_set = _parse_cron_field(parts[2], 1, 31)
    mon_set = _parse_cron_field(parts[3], 1, 12)
    dow_set = _parse_cron_field(parts[4], 0, 7)
    if 7 in dow_set:
        dow_set.add(0)

    curr_dt = datetime.fromtimestamp(now, tz=timezone.utc).replace(second=0, microsecond=0)
    curr_dt += dt_mod.timedelta(minutes=1)

    max_steps = 525600  # 1 year search ceiling
    for _ in range(max_steps):
        if curr_dt.month not in mon_set:
            if curr_dt.month == 12:
                curr_dt = curr_dt.replace(year=curr_dt.year + 1, month=1, day=1, hour=0, minute=0)
            else:
                curr_dt = curr_dt.replace(month=curr_dt.month + 1, day=1, hour=0, minute=0)
            continue

        dow = (curr_dt.weekday() + 1) % 7
        dom_match = curr_dt.day in dom_set
        dow_match = dow in dow_set

        dom_is_star = parts[2] == "*"
        dow_is_star = parts[4] == "*"
        if dom_is_star and dow_is_star:
            day_matches = True
        elif not dom_is_star and not dow_is_star:
            day_matches = dom_match or dow_match
        elif not dom_is_star:
            day_matches = dom_match
        else:
            day_matches = dow_match

        if not day_matches:
            curr_dt = (curr_dt + dt_mod.timedelta(days=1)).replace(hour=0, minute=0)
            continue

        if curr_dt.hour not in hr_set:
            curr_dt = (curr_dt + dt_mod.timedelta(hours=1)).replace(minute=0)
            continue

        if curr_dt.minute in min_set:
            return curr_dt.timestamp()

        curr_dt += dt_mod.timedelta(minutes=1)

    return now + 86400.0


def compute_next_run(job: CronJob, now: Optional[float] = None) -> float:
    """Compute the next due timestamp for a job."""
    curr = time.time() if now is None else float(now)
    parsed = parse_schedule(job.schedule_raw)

    if parsed["kind"] == "interval":
        interval = parsed["seconds"]
        return curr + interval

    if parsed["kind"] == "once":
        return parsed.get("timestamp", curr)

    if parsed["kind"] == "event":
        return 0.0

    if parsed["kind"] == "cron":
        return compute_next_cron(parsed["cron"], curr)

    return curr + 3600.0


