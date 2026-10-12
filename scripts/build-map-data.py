#!/usr/bin/env python3
"""Build Charm's offline map data from the Dresden OSM extract.

Outputs (in --out, default .cache/downloads/map/derived/ — gitignored, never committed):
  pois.json     searchable places: {"v":1,"cats":[...],"pois":[[name, cat_index, lat, lon], ...]}
  walk.graph    walking graph for A* (little-endian binary, format below)

walk.graph layout:
  0   "CWG1"                      magic
  4   u32 n                       node count
  8   u32 m                       directed edge count (every footpath appears in both directions)
  12  f32 minLat, minLon, maxLat, maxLon   bounding box used for quantization
  28  u32 0                       reserved
  32  u16 coords[2n]              (lat, lon) per node, quantized to the box (0..65535; ~0.4 m)
      u32 offsets[n+1]            CSR row starts into targets
      u32 targets[m]              neighbour node indices
Edge lengths are not stored: they are straight segments (shape points are kept as nodes),
so the page computes them from the coordinates.

Run with the repo's venv (osmium):  .venv/bin/python -I scripts/build-map-data.py
"""

import argparse
import json
import math
import struct
import sys
from pathlib import Path

import osmium

REPO = Path(__file__).resolve().parent.parent
DEFAULT_MAP = REPO / ".cache" / "downloads" / "map"

# ---- Region: change these for another city (and the same box in build-transit.py) ----
# The OSM extract (BBBike) in DEFAULT_MAP, for places and footpaths.
PBF_NAME = "Dresden.osm.pbf"
# The PMTiles extract's box (README → Setup): routes and places outside it cannot be shown.
BBOX = (50.96, 13.57, 51.18, 13.97)  # minLat, minLon, maxLat, maxLon

WALK_HIGHWAYS = {
    "footway", "path", "pedestrian", "living_street", "residential", "service", "track", "steps",
    "unclassified", "tertiary", "tertiary_link", "secondary", "secondary_link", "primary",
    "primary_link", "road", "corridor", "bridleway",
}
NEEDS_FOOT_TAG = {"cycleway"}  # German cycleways are not for walking unless foot= says so
FOOT_OK = {"yes", "designated", "permissive", "official"}
NO_ACCESS = {"no", "private"}

CATS = [
    "station", "sight", "pharmacy", "hospital", "toilets", "drinking_water", "police",
    "building", "university", "food", "supermarket", "hotel", "park", "area", "street",
]
CAT = {c: i for i, c in enumerate(CATS)}
UNNAMED_LABEL = {"toilets": "Toilets", "drinking_water": "Drinking water"}
# Merge duplicates of the same name and category closer than this (platform nodes, street segments).
MERGE_M = {"station": 300.0, "street": 800.0, "building": 50.0}
SIMPLIFY_M = 4.0  # shape points closer than this to the straight segment are dropped


def category(tags) -> str | None:
    amenity = tags.get("amenity")
    railway = tags.get("railway")
    tourism = tags.get("tourism")
    if railway in ("station", "halt", "tram_stop") or tags.get("public_transport") == "station":
        return "station"
    if tags.get("highway") == "bus_stop":
        return "station"
    if amenity == "pharmacy":
        return "pharmacy"
    if amenity in ("hospital", "clinic"):
        return "hospital"
    if amenity == "toilets":
        return "toilets"
    if amenity == "drinking_water" or (tags.get("drinking_water") == "yes" and amenity == "fountain"):
        return "drinking_water"
    if amenity == "police":
        return "police"
    if tourism in ("attraction", "museum", "viewpoint", "gallery", "zoo", "artwork") or amenity in (
        "place_of_worship", "theatre", "arts_centre", "fountain") or "historic" in tags:
        return "sight"
    if amenity in ("university", "college"):
        return "university"
    if amenity in ("cafe", "restaurant", "fast_food", "biergarten", "ice_cream"):
        return "food"
    if tags.get("shop") in ("supermarket", "convenience"):
        return "supermarket"
    if tourism in ("hotel", "hostel"):
        return "hotel"
    if tags.get("leisure") in ("park", "garden"):
        return "park"
    if tags.get("place") in ("suburb", "quarter", "neighbourhood", "city_block", "square") or (
            tags.get("highway") == "pedestrian" and tags.get("area") == "yes"):
        return "area"
    if "building" in tags:
        return "building"
    return None


def walkable(tags) -> bool:
    hw = tags.get("highway")
    foot = tags.get("foot")
    if hw is None or foot == "no" or (tags.get("area") == "yes" and hw != "pedestrian"):
        return False
    if tags.get("access") in NO_ACCESS and foot not in FOOT_OK:
        return False
    if hw in WALK_HIGHWAYS:
        return True
    return hw in NEEDS_FOOT_TAG and foot in FOOT_OK


def inside(lat: float, lon: float) -> bool:
    return BBOX[0] <= lat <= BBOX[2] and BBOX[1] <= lon <= BBOX[3]


LAT0 = (BBOX[0] + BBOX[2]) / 2
M_PER_DEG = 111_320.0
K_LON = math.cos(math.radians(LAT0))


def dist_m(a, b) -> float:
    return math.hypot((a[0] - b[0]) * M_PER_DEG, (a[1] - b[1]) * M_PER_DEG * K_LON)


class Collector(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.pois = []          # (name, cat, lat, lon)
        self.ways = []          # list of node-id lists (walkable ways)
        self.loc = {}           # node id -> (lat, lon) for walkable-way nodes inside the box

    def node(self, n):
        if not n.tags or not n.location.valid():
            return
        lat, lon = n.location.lat, n.location.lon
        if not inside(lat, lon):
            return
        self._poi(n.tags, lat, lon)

    def way(self, w):
        tags = w.tags
        if walkable(tags):
            ids = []
            for nd in w.nodes:
                if not nd.location.valid():
                    ids.append(None)
                    continue
                lat, lon = nd.location.lat, nd.location.lon
                if inside(lat, lon):
                    self.loc[nd.ref] = (lat, lon)
                    ids.append(nd.ref)
                else:
                    ids.append(None)  # leaves the box: split the way here
            run = []
            for i in ids + [None]:
                if i is None:
                    if len(run) >= 2:
                        self.ways.append(run)
                    run = []
                else:
                    run.append(i)
        name = tags.get("name")
        if not name:
            return
        hw = tags.get("highway")
        if hw is not None and not (hw == "pedestrian" and tags.get("area") == "yes"):
            if hw in WALK_HIGHWAYS or hw in NEEDS_FOOT_TAG:  # a named street: one entry per stretch
                mid = w.nodes[len(w.nodes) // 2]
                if mid.location.valid() and inside(mid.location.lat, mid.location.lon):
                    self.pois.append((name.strip(), "street", mid.location.lat, mid.location.lon))
            return
        pts = [(nd.location.lat, nd.location.lon) for nd in w.nodes if nd.location.valid()]
        if not pts:
            return
        lat = sum(p[0] for p in pts) / len(pts)
        lon = sum(p[1] for p in pts) / len(pts)
        if inside(lat, lon):
            self._poi(tags, lat, lon)

    def area(self, a):
        # Ways are handled in way(); this catches multipolygon relations (the Zwinger, Pfunds Molkerei).
        if a.from_way() or not a.tags.get("name"):
            return
        pts = [(n.lat, n.lon) for ring in a.outer_rings() for n in ring if n.location.valid()]
        if pts:
            lat = sum(p[0] for p in pts) / len(pts)
            lon = sum(p[1] for p in pts) / len(pts)
            if inside(lat, lon):
                self._poi(a.tags, lat, lon)

    def _poi(self, tags, lat, lon):
        cat = category(tags)
        if cat is None:
            return
        name = tags.get("name") or tags.get("name:de") or UNNAMED_LABEL.get(cat)
        if not name:
            return
        self.pois.append((name.strip(), cat, lat, lon))


def merge_pois(pois):
    """Merge same-name, same-category duplicates that lie close together (keeps the first position)."""
    out = []
    groups: dict[tuple[str, str], list[int]] = {}
    for name, cat, lat, lon in pois:
        key = (name.casefold(), cat)
        radius = MERGE_M.get(cat, 30.0)
        if cat in UNNAMED_LABEL:
            radius = 15.0
        hit = False
        for idx in groups.get(key, []):
            o = out[idx]
            if dist_m((o[2], o[3]), (lat, lon)) < radius:
                hit = True
                break
        if not hit:
            groups.setdefault(key, []).append(len(out))
            out.append((name, cat, lat, lon))
    return out


def simplify(pts, idx_a, idx_b, keep):
    """Douglas-Peucker on pts[idx_a..idx_b] (planar metres); marks kept indices."""
    stack = [(idx_a, idx_b)]
    while stack:
        a, b = stack.pop()
        if b - a < 2:
            continue
        ax, ay = pts[a]
        bx, by = pts[b]
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        best, bi = -1.0, -1
        for i in range(a + 1, b):
            px, py = pts[i]
            if L2 == 0:
                d = math.hypot(px - ax, py - ay)
            else:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
                d = math.hypot(px - ax - t * dx, py - ay - t * dy)
            if d > best:
                best, bi = d, i
        if best > SIMPLIFY_M:
            keep.add(bi)
            stack.append((a, bi))
            stack.append((bi, b))


def build_graph(ways, loc):
    uses: dict[int, int] = {}
    for w in ways:
        for i, nid in enumerate(w):
            inc = 2 if i == 0 or i == len(w) - 1 else 1
            uses[nid] = uses.get(nid, 0) + inc
    index: dict[int, int] = {}
    coords: list[tuple[float, float]] = []

    def node_of(nid):
        k = index.get(nid)
        if k is None:
            k = index[nid] = len(coords)
            coords.append(loc[nid])
        return k

    edges = set()
    for w in ways:
        cuts = [i for i, nid in enumerate(w) if uses[nid] >= 2]  # endpoints and junctions
        for a, b in zip(cuts, cuts[1:]):
            seg = w[a:b + 1]
            pts = [(loc[n][0] * M_PER_DEG, loc[n][1] * M_PER_DEG * K_LON) for n in seg]
            keep = {0, len(seg) - 1}
            simplify(pts, 0, len(seg) - 1, keep)
            ks = sorted(keep)
            for i, j in zip(ks, ks[1:]):
                u, v = node_of(seg[i]), node_of(seg[j])
                if u != v:
                    edges.add((min(u, v), max(u, v)))
    return coords, edges


def largest_component(n, edges):
    parent = list(range(n))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for u, v in edges:
        ru, rv = find(u), find(v)
        if ru != rv:
            parent[ru] = rv
    sizes: dict[int, int] = {}
    for i in range(n):
        r = find(i)
        sizes[r] = sizes.get(r, 0) + 1
    best = max(sizes, key=sizes.get)
    return [find(i) == best for i in range(n)]


def write_graph(path: Path, coords, edges):
    n0 = len(coords)
    keep = largest_component(n0, edges)
    # Renumber the kept nodes in a spatial order (rows of ~200 m), so neighbours sit close in memory.
    order = sorted((i for i in range(n0) if keep[i]),
                   key=lambda i: (int((coords[i][0] - BBOX[0]) * M_PER_DEG / 200), coords[i][1]))
    new = {old: k for k, old in enumerate(order)}
    n = len(order)
    adj: list[list[int]] = [[] for _ in range(n)]
    for u, v in edges:
        if u in new and v in new:
            adj[new[u]].append(new[v])
            adj[new[v]].append(new[u])
    offsets = [0]
    targets: list[int] = []
    for lst in adj:
        lst.sort()
        targets.extend(lst)
        offsets.append(len(targets))
    m = len(targets)
    q = []
    for old in order:
        lat, lon = coords[old]
        q.append(round((lat - BBOX[0]) / (BBOX[2] - BBOX[0]) * 65535))
        q.append(round((lon - BBOX[1]) / (BBOX[3] - BBOX[1]) * 65535))
    head = b"CWG1" + struct.pack("<II4fI", n, m, *BBOX, 0)
    body = struct.pack(f"<{2 * n}H", *q)  # 4n bytes: the u32 arrays after it stay aligned
    data = head + body + struct.pack(f"<{n + 1}I", *offsets) + struct.pack(f"<{m}I", *targets)
    path.write_bytes(data)
    return n, m, n0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--pbf", type=Path, default=DEFAULT_MAP / PBF_NAME)
    ap.add_argument("--out", type=Path, default=DEFAULT_MAP / "derived")
    args = ap.parse_args(argv)
    if not args.pbf.is_file():
        sys.exit(f"missing {args.pbf}")
    args.out.mkdir(parents=True, exist_ok=True)

    c = Collector()
    c.apply_file(str(args.pbf), locations=True)

    pois = merge_pois(c.pois)
    pois.sort(key=lambda p: (CAT[p[1]], p[0]))
    doc = {"v": 1, "cats": CATS,
           "pois": [[name, CAT[cat], round(lat, 5), round(lon, 5)] for name, cat, lat, lon in pois]}
    poi_path = args.out / "pois.json"
    poi_path.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    coords, edges = build_graph(c.ways, c.loc)
    graph_path = args.out / "walk.graph"
    n, m, n0 = write_graph(graph_path, coords, edges)

    counts = {cat: 0 for cat in CATS}
    for p in pois:
        counts[p[1]] += 1
    print(f"pois.json   {poi_path.stat().st_size / 1e6:.2f} MB, {len(pois)} places: "
          + ", ".join(f"{k} {v}" for k, v in counts.items()))
    print(f"walk.graph  {graph_path.stat().st_size / 1e6:.2f} MB, {n} nodes ({n / max(n0, 1):.1%} of {n0} "
          f"in the largest connected part), {m // 2} footpath segments")


if __name__ == "__main__":
    main()
