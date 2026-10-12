#!/usr/bin/env python3
"""Build Charm's offline Dresden tram/bus timetable from the VVO-area GTFS cut.

Requirements: Python 3.12 standard library only (no third-party packages).
Input:  .cache/downloads/transit/vvo-gtfs.zip  (gitignored; never committed)
        https://github.com/kiliankoe/vvo/releases/latest/download/vvo-gtfs.zip
        Data: DELFI e.V. via gtfs.de, CC BY 4.0 (attribution in web/CREDITS).
Output: .cache/downloads/map/derived/transit.bin and transit-stops.json

Run with the repo's venv:  .venv/bin/python -I scripts/build-transit.py [--date YYYYMMDD]

transit.bin layout (little-endian, packed, no padding; every offset is an element index, not bytes):
  "CHTR"  u16 version=1  u32 baseDate (YYYYMMDD)
  u32 nStops, nRoutes, nTrips, nStopTimes, nTransfers
  Stops      nStops    x (f32 lat, f32 lon)                      index = transit-stops.json stops[i]
  Routes     nRoutes   x (u16 lineIndex, u8 mode, u16 nStopsInRoute,
                          u32 firstRouteStopOffset, u32 firstTripOffset, u16 nTrips)
             mode: 0 tram, 1 bus, 2 rail, 3 ferry, 4 other
  RouteStops sum(nStopsInRoute) x u32 stopIndex
  Trips      nTrips    x (u16 dayMask, u16 headsignIndex, u32 firstStopTimeOffset)
             sorted by first departure within each route; bit d of dayMask = runs on baseDate + d days
             (14 days, bit 0 = baseDate). Within a route no trip overtakes another (RAPTOR FIFO).
  StopTimes  nStopTimes x u16 minutes after midnight of the service day (may exceed 1440),
             nStopsInRoute values per trip, departure time
  Transfers  nTransfers x (u32 fromStop, u32 toStop, u16 walkSeconds), both directions, sorted by from
  Offsets    (nStops+1) x u32 into the pairs below, then pairs (u32 routeIndex, u16 posInRoute)
             = the routes serving each stop
transit-stops.json: {"stops":[name], "lines":[shortName], "headsigns":[...], "lineColors":["#rrggbb"]}

Known limit: trips of the service day before baseDate that run past midnight are not included.
"""

import argparse
import csv
import datetime as dt
import io
import json
import math
import struct
import sys
import zipfile
from collections import defaultdict
from pathlib import Path
from zoneinfo import ZoneInfo

REPO = Path(__file__).resolve().parent.parent
DEFAULT_OUT = REPO / ".cache" / "downloads" / "map" / "derived"

# ---- Region: change these for another city (and the same box in build-map-data.py) ----
# The GTFS feed (download source and licence in the header above).
DEFAULT_ZIP = REPO /".cache" / "downloads" / "transit" / "vvo-gtfs.zip"
BBOX = (50.96, 13.57, 51.18, 13.97)  # minLat, minLon, maxLat, maxLon (the map's box)
TIMEZONE = "Europe/Berlin"  # the feed's local time (daylight-saving changes)

DAYS = 14
MERGE_M = 80.0
TRANSFER_M = 400.0
DETOUR = 1.3
WALK_MPS = 1.3
MODE_COLORS = ["#e2001a", "#73d700", "#0066b3", "#00a0e1", "#888888"]


def mode_of(route_type: int) -> int:
    if route_type in (0, 900) or 900 <= route_type < 1000:
        return 0
    if route_type in (3, 11) or 700 <= route_type < 900:
        return 1
    if route_type in (1, 2) or 100 <= route_type < 500:
        return 2
    if route_type == 4 or 1000 <= route_type < 1100 or route_type == 1200:
        return 3
    return 4


def dist_m(lat1, lon1, lat2, lon2):
    k = 111_195.0
    x = (lon2 - lon1) * k * math.cos(math.radians((lat1 + lat2) / 2))
    y = (lat2 - lat1) * k
    return math.hypot(x, y)


def rows(z, name):
    with z.open(name) as h:
        yield from csv.DictReader(io.TextIOWrapper(h, "utf-8-sig", newline=""))


def in_box(lat, lon):
    return BBOX[0] <= lat <= BBOX[2] and BBOX[1] <= lon <= BBOX[3]


def minutes(t):
    h, m, _ = t.split(":")
    return int(h) * 60 + int(m)


def active_masks(z, base: dt.date):
    """service_id -> 14-bit mask from calendar.txt plus calendar_dates.txt exceptions."""
    days = [base + dt.timedelta(d) for d in range(DAYS)]
    keys = [d.strftime("%Y%m%d") for d in days]
    wd = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
    masks = defaultdict(int)
    for r in rows(z, "calendar.txt"):
        m = 0
        for i, d in enumerate(days):
            if r["start_date"] <= keys[i] <= r["end_date"] and r[wd[d.weekday()]] == "1":
                m |= 1 << i
        masks[r["service_id"]] = m
    idx = {k: i for i, k in enumerate(keys)}
    for r in rows(z, "calendar_dates.txt"):
        i = idx.get(r["date"])
        if i is None:
            continue
        if r["exception_type"] == "1":
            masks[r["service_id"]] |= 1 << i
        elif r["exception_type"] == "2":
            masks[r["service_id"]] &= ~(1 << i)
    return masks


def merge_stops(z):
    """GTFS stop_id -> merged stop index, for platforms in the box. Same name and (same parent
    station or within 80 m, chained) = one stop. Returns (id_to_idx, names, coords)."""
    raw = {}
    parents = {}
    for r in rows(z, "stops.txt"):
        lat, lon = float(r["stop_lat"]), float(r["stop_lon"])
        if r["location_type"] == "1":
            parents[r["stop_id"]] = (lat, lon)
            continue
        if r["location_type"] not in ("", "0") or not in_box(lat, lon):
            continue
        raw[r["stop_id"]] = (r["stop_name"].strip(), lat, lon, r["parent_station"])
    ids = list(raw)
    parent = {i: i for i in ids}

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    by_name = defaultdict(list)
    for i in ids:
        by_name[raw[i][0]].append(i)
    for group in by_name.values():
        for a in range(len(group)):
            for b in range(a + 1, len(group)):
                ia, ib = raw[group[a]], raw[group[b]]
                if (ia[3] and ia[3] == ib[3]) or dist_m(ia[1], ia[2], ib[1], ib[2]) <= MERGE_M:
                    ra, rb = find(group[a]), find(group[b])
                    if ra != rb:
                        parent[ra] = rb
    clusters = defaultdict(list)
    for i in ids:
        clusters[find(i)].append(i)
    return raw, parents, clusters


def dst_change(first: dt.date, last: dt.date):
    """The first day in [first, last] whose TIMEZONE UTC offset differs from the day before, or None."""
    tz = ZoneInfo(TIMEZONE)
    offset = lambda d: dt.datetime(d.year, d.month, d.day, 12, tzinfo=tz).utcoffset()
    for i in range(1, (last - first).days + 1):
        d = first + dt.timedelta(i)
        if offset(d) != offset(d - dt.timedelta(1)):
            return d
    return None


def build(zip_path: Path, out: Path, base: dt.date):
    z = zipfile.ZipFile(zip_path)
    masks = active_masks(z, base)
    raw, parent_coords, clusters = merge_stops(z)
    platform_cluster = {i: root for root, members in clusters.items() for i in members}

    routes = {r["route_id"]: r for r in rows(z, "routes.txt")}
    trip_meta = {}
    for r in rows(z, "trips.txt"):
        m = masks.get(r["service_id"], 0)
        if m:
            trip_meta[r["trip_id"]] = (r["route_id"], m)

    # Stream stop_times; keep only platforms in the box for trips that run in the window.
    stoptimes = defaultdict(list)  # trip_id -> [(seq, cluster_root, minutes)]
    first_headsign = {}
    for r in rows(z, "stop_times.txt"):
        t = r["trip_id"]
        if t not in trip_meta:
            continue
        seq = int(r["stop_sequence"])
        hs = r.get("stop_headsign", "").strip()
        if hs and (t not in first_headsign or seq < first_headsign[t][0]):
            first_headsign[t] = (seq, hs)
        root = platform_cluster.get(r["stop_id"])
        if root is None:
            continue
        stoptimes[t].append((seq, root, minutes(r["departure_time"] or r["arrival_time"])))

    # Merged stop table, only for stops actually served.
    used_roots = set()
    trips = []  # (line_key, mode, stops tuple, times tuple, mask, headsign)
    for t, sts in stoptimes.items():
        sts.sort()
        seq_stops, seq_times = [], []
        for _, root, mins in sts:
            if seq_stops and seq_stops[-1] == root:  # two platforms of one merged stop in a row
                seq_times[-1] = mins
                continue
            seq_stops.append(root)
            seq_times.append(mins)
        if len(seq_stops) < 2:
            continue
        route_id, mask = trip_meta[t]
        rr = routes[route_id]
        mode = mode_of(int(rr["route_type"]))
        name = rr["route_short_name"].strip() or rr["route_long_name"].strip() or "?"
        color = ("#" + rr["route_color"].lower()) if len(rr.get("route_color", "")) == 6 else MODE_COLORS[mode]
        headsign = first_headsign.get(t, (0, raw[sts[-1][1]][0]))[1]
        used_roots.update(seq_stops)
        trips.append(((name, mode), color, tuple(seq_stops), tuple(seq_times), mask, headsign))

    def stop_coord(root):
        members = clusters[root]
        par = raw[members[0]][3]
        if par in parent_coords and all(raw[m][3] == par for m in members):
            return parent_coords[par]
        return (sum(raw[m][1] for m in members) / len(members), sum(raw[m][2] for m in members) / len(members))

    roots = sorted(used_roots, key=lambda r: (raw[r][0], stop_coord(r)))
    stop_idx = {r: i for i, r in enumerate(roots)}
    stop_names = [raw[r][0] for r in roots]
    stop_xy = [stop_coord(r) for r in roots]

    lines, line_colors, line_idx = [], [], {}
    headsigns, hs_idx = [], {}
    patterns = defaultdict(list)
    for key, color, stops, times, mask, hs in trips:
        if key not in line_idx:
            line_idx[key] = len(lines)
            lines.append(key[0])
            line_colors.append(color)
        if hs not in hs_idx:
            hs_idx[hs] = len(headsigns)
            headsigns.append(hs)
        patterns[(line_idx[key], key[1], tuple(stop_idx[s] for s in stops))].append((times, mask, hs_idx[hs]))

    # Split each stop pattern into FIFO routes (no trip overtakes another), as RAPTOR requires.
    route_list = []  # (line, mode, stops, [trips])
    for (line, mode, stops), ts in sorted(patterns.items()):
        ts.sort(key=lambda x: (x[0][0], x[0]))
        subs = []
        for tr in ts:
            for sub in subs:
                last = sub[-1][0]
                if all(a >= b for a, b in zip(tr[0], last)):
                    sub.append(tr)
                    break
            else:
                subs.append([tr])
        for sub in subs:
            route_list.append((line, mode, stops, sub))

    if len(stop_names) > 0xFFFFFFFF or len(headsigns) > 0xFFFF or len(lines) > 0xFFFF:
        sys.exit("too many entries for the format")

    route_recs, route_stops, trip_recs, stop_times = [], [], [], []
    serving = defaultdict(list)
    for ri, (line, mode, stops, sub) in enumerate(route_list):
        if len(sub) > 0xFFFF or len(stops) > 0xFFFF:
            sys.exit("route too large for the format")
        route_recs.append((line, mode, len(stops), len(route_stops), len(trip_recs), len(sub)))
        for pos, s in enumerate(stops):
            serving[s].append((ri, pos))
        route_stops.extend(stops)
        for times, mask, hs in sub:
            if max(times) > 0xFFFF:
                sys.exit("time out of range")
            trip_recs.append((mask, hs, len(stop_times)))
            stop_times.extend(times)

    # Footpaths: straight line x1.3 at 1.3 m/s, within 400 m, found with a ~400 m grid.
    cell = 0.004
    grid = defaultdict(list)
    for i, (lat, lon) in enumerate(stop_xy):
        grid[(int(lat / cell), int(lon / (cell * 1.6)))].append(i)
    transfers = []
    for i, (lat, lon) in enumerate(stop_xy):
        gy, gx = int(lat / cell), int(lon / (cell * 1.6))
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                for j in grid.get((gy + dy, gx + dx), ()):
                    if j == i:
                        continue
                    d = dist_m(lat, lon, *stop_xy[j])
                    if d <= TRANSFER_M:
                        transfers.append((i, j, min(0xFFFF, round(d * DETOUR / WALK_MPS))))
    transfers.sort()

    offsets, pairs = [0], []
    for s in range(len(stop_names)):
        pairs.extend(serving[s])
        offsets.append(len(pairs))

    buf = bytearray()
    buf += b"CHTR"
    buf += struct.pack("<HI", 1, int(base.strftime("%Y%m%d")))
    buf += struct.pack("<5I", len(stop_names), len(route_recs), len(trip_recs), len(stop_times), len(transfers))
    for lat, lon in stop_xy:
        buf += struct.pack("<ff", lat, lon)
    for r in route_recs:
        buf += struct.pack("<HBHIIH", *r)
    buf += struct.pack(f"<{len(route_stops)}I", *route_stops)
    for t in trip_recs:
        buf += struct.pack("<HHI", *t)
    buf += struct.pack(f"<{len(stop_times)}H", *stop_times)
    for t in transfers:
        buf += struct.pack("<IIH", *t)
    buf += struct.pack(f"<{len(offsets)}I", *offsets)
    for p in pairs:
        buf += struct.pack("<IH", *p)

    out.mkdir(parents=True, exist_ok=True)
    (out / "transit.bin").write_bytes(buf)
    js = json.dumps({"stops": stop_names, "lines": lines, "headsigns": headsigns, "lineColors": line_colors},
                    ensure_ascii=False, separators=(",", ":"))
    (out / "transit-stops.json").write_text(js, encoding="utf-8")

    end = base + dt.timedelta(DAYS - 1)
    print(f"days {base:%Y-%m-%d}..{end:%Y-%m-%d} ({DAYS})")
    change = dst_change(base, end)
    if change:
        print(f"warning: the window crosses a daylight-saving change on {change:%Y-%m-%d}; times on that day are an "
              "hour off (stop times count from midnight, not from noon minus 12 h); rebuild after it", file=sys.stderr)
    print(f"stops {len(stop_names)}  lines {len(lines)}  routes {len(route_recs)}  trips {len(trip_recs)}  "
          f"stopTimes {len(stop_times)}  routeStops {len(route_stops)}  transfers {len(transfers)}  headsigns {len(headsigns)}")
    print(f"transit.bin {len(buf) / 1024:.0f} KB  transit-stops.json {len(js.encode()) / 1024:.0f} KB  -> {out}")
    if len(buf) > 4 * 1024 * 1024 or len(js.encode()) > 300 * 1024:
        print("warning: over the size target (4 MB binary, 300 KB JSON)", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--gtfs", type=Path, default=DEFAULT_ZIP)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--date", help="first service day, YYYYMMDD (default: yesterday, so tonight's after-midnight trips of yesterday's service are in)")
    a = ap.parse_args()
    base = dt.datetime.strptime(a.date, "%Y%m%d").date() if a.date else dt.date.today() - dt.timedelta(days=1)
    if not a.gtfs.exists():
        sys.exit(f"missing {a.gtfs}: download the VVO GTFS cut first (see the header of this script)")
    build(a.gtfs, a.out, base)


if __name__ == "__main__":
    main()
