#!/usr/bin/env python3
"""Self-check for transit.bin (format in scripts/build-transit.py): loads it back, checks the
structure, and prints the next 3 departures of a line from a stop (default: line 1 from Postplatz).

Requirements: Python 3.12 standard library only.
Run:  .venv/bin/python -I scripts/check-transit.py [--line 1] [--stop Postplatz] [--date YYYYMMDD] [--time HH:MM]
"""

import argparse
import datetime as dt
import json
import struct
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DEFAULT_DIR = REPO /".cache" / "downloads" / "map" / "derived"


class Reader:
    def __init__(self, data):
        self.d, self.o = data, 0

    def take(self, fmt, n=1):
        size = struct.calcsize("<" + fmt)
        out = [struct.unpack_from("<" + fmt, self.d, self.o + i * size) for i in range(n)]
        self.o += size * n
        return out


def load(path):
    r = Reader(path.read_bytes())
    if r.d[:4] != b"CHTR":
        sys.exit("bad magic")
    r.o = 4
    version, base = r.take("HI")[0]
    n_stops, n_routes, n_trips, n_st, n_tr = r.take("5I")[0]
    t = {"version": version, "baseDate": base}
    t["stops"] = r.take("ff", n_stops)
    t["routes"] = r.take("HBHIIH", n_routes)
    n_rs = sum(x[2] for x in t["routes"])
    t["routeStops"] = [x[0] for x in r.take("I", n_rs)]
    t["trips"] = r.take("HHI", n_trips)
    t["stopTimes"] = [x[0] for x in r.take("H", n_st)]
    t["transfers"] = r.take("IIH", n_tr)
    t["offsets"] = [x[0] for x in r.take("I", n_stops + 1)]
    t["pairs"] = r.take("IH", t["offsets"][-1])
    if r.o != len(r.d):
        sys.exit(f"trailing or missing bytes: read {r.o} of {len(r.d)}")
    # Structure checks: offsets line up, trips FIFO and sorted, pairs point back at the stop.
    for ri, (_, _, ns, rso, tro, nt) in enumerate(t["routes"]):
        prev = None
        for k in range(nt):
            mask, _, sto = t["trips"][tro + k]
            if not mask or mask >> 14:
                sys.exit(f"route {ri}: bad day mask")
            times = t["stopTimes"][sto:sto + ns]
            if len(times) != ns or any(b < a for a, b in zip(times, times[1:])):
                sys.exit(f"route {ri}: stop times not monotone")
            if prev and any(a < b for a, b in zip(times, prev)):
                sys.exit(f"route {ri}: trip overtakes its predecessor")
            prev = times
    for s in range(n_stops):
        for ri, pos in t["pairs"][t["offsets"][s]:t["offsets"][s + 1]]:
            rt = t["routes"][ri]
            if t["routeStops"][rt[3] + pos] != s:
                sys.exit(f"stop {s}: offset pair does not point back")
    return t


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", type=Path, default=DEFAULT_DIR)
    ap.add_argument("--line", default="1")
    ap.add_argument("--stop", default="Postplatz")
    ap.add_argument("--date", help="YYYYMMDD (default: today)")
    ap.add_argument("--time", default="12:00", help="HH:MM")
    a = ap.parse_args()
    t = load(a.dir / "transit.bin")
    names = json.loads((a.dir / "transit-stops.json").read_text(encoding="utf-8"))
    base = dt.datetime.strptime(str(t["baseDate"]), "%Y%m%d").date()
    day = dt.datetime.strptime(a.date, "%Y%m%d").date() if a.date else dt.date.today()
    d = (day - base).days
    if not 0 <= d < 14:
        sys.exit(f"{day} is outside the 14 days from {base}")
    hh, mm = map(int, a.time.split(":"))
    now = hh * 60 + mm
    print(f"ok: v{t['version']} base {t['baseDate']}, {len(t['stops'])} stops, {len(t['routes'])} routes, "
          f"{len(t['trips'])} trips, {len(t['transfers'])} transfers")

    stops = [i for i, n in enumerate(names["stops"]) if a.stop.lower() in n.lower()]
    deps = []
    for s in stops:
        for ri, pos in t["pairs"][t["offsets"][s]:t["offsets"][s + 1]]:
            line, _, ns, rso, tro, nt = t["routes"][ri]
            if names["lines"][line] != a.line or pos == ns - 1:
                continue
            for k in range(nt):
                mask, hs, sto = t["trips"][tro + k]
                # Today's trips, plus yesterday's still running past midnight.
                for back in (0, 1):
                    if d - back < 0 or not mask >> (d - back) & 1:
                        continue
                    when = t["stopTimes"][sto + pos] - 1440 * back
                    if when >= now:
                        deps.append((when, names["stops"][s], names["headsigns"][hs]))
    deps.sort()
    print(f"next 3 departures of line {a.line} from '{a.stop}' on {day} after {a.time}:")
    for when, stop, hs in deps[:3]:
        print(f"  {when // 60:02d}:{when % 60:02d}  {stop}  -> {hs}")
    if not deps:
        sys.exit("none found")


if __name__ == "__main__":
    main()
