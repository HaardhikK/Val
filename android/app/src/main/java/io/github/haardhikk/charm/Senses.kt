package io.github.haardhikk.charm

import android.content.Context
import android.location.Location
import android.os.BatteryManager
import android.os.Process
import android.os.SystemClock
import android.util.Log
import org.json.JSONObject
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.TextStyle
import java.util.Locale
import kotlin.math.acos
import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.tan

/**
 * What Val knows about its world right now: the clock, the sun, the battery, the light, GPS and satellites, and how long
 * it has been awake. [Senses.snapshot] is cheap (no sensor is switched on for it); the formatting below is pure and
 * unit-tested. Everything here is sensor data: it reaches the chat model only as a line labelled as data (prompt-injection guard).
 */
data class Snapshot(
    val local: LocalDateTime,
    val batteryPct: Int?,
    val charging: Boolean?,
    /** "dark" / "normal" / "bright" from the light sensor, null until it settled (or no sensor). */
    val light: String?,
    /** Sun elevation in degrees at our position (Dresden without a fix). */
    val sunElevation: Double,
    val fix: Fix?,
    val place: Places.Near?,
    val district: String?,
    val sky: SkySummary?,
    val awakeMs: Long,
) {
    data class Fix(
        val lat: Double,
        val lon: Double,
        val accM: Double,
        val ageS: Long,
        /** Height above sea level (approx.), null when the fix has none. */
        val altitudeM: Double?,
        val vAccM: Double?,
        val speedMps: Double?,
        val bearingDeg: Double?,
    )
}

/** Satellites the GPS chip hears right now (GnssStatus), summed up. */
data class SkySummary(val total: Int, val used: Int, val best: Int, val byConstellation: Map<String, Int>) {
    companion object {
        /** Android's GnssStatus.CONSTELLATION_* values (1..7), named for speech. */
        private val NAMES = mapOf(1 to "GPS", 2 to "SBAS", 3 to "GLONASS", 4 to "QZSS", 5 to "BeiDou", 6 to "Galileo", 7 to "NavIC")

        /** From parallel lists of constellation type, C/N0 (dB-Hz) and used-in-fix, one entry per satellite. */
        fun of(constellations: IntArray, cn0: FloatArray, used: BooleanArray): SkySummary {
            val n = minOf(constellations.size, cn0.size, used.size)
            val heard = (0 until n).filter { cn0[it] > 0f } // a satellite in the almanac with no signal is not "seen"
            val by = heard.groupingBy { NAMES[constellations[it]] ?: "other" }.eachCount().toSortedMap()
            return SkySummary(
                total = heard.size,
                used = heard.count { used[it] },
                best = heard.maxOfOrNull { cn0[it] }?.roundToInt() ?: 0,
                byConstellation = by,
            )
        }
    }
}

/** Sun elevation after NOAA's solar calculator (the same formula as web/src/delight/sun.ts, which owns rise and set times). */
object SunMath {
    private const val RAD = Math.PI / 180
    private const val DAY_MS = 86_400_000.0

    /** Degrees above the horizon (negative below) at an instant. */
    fun elevation(epochMs: Long, lat: Double, lon: Double): Double {
        val jd = epochMs / DAY_MS + 2440587.5
        val t = (jd - 2451545) / 36525
        val l0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360
        val m = 357.52911 + t * (35999.05029 - 0.0001537 * t)
        val e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t)
        val c = sin(m * RAD) * (1.914602 - t * (0.004817 + 0.000014 * t)) + sin(2 * m * RAD) * (0.019993 - 0.000101 * t) + sin(3 * m * RAD) * 0.000289
        val omega = 125.04 - 1934.136 * t
        val lambda = l0 + c - 0.00569 - 0.00478 * sin(omega * RAD)
        val meanObliq = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60
        val obliq = meanObliq + 0.00256 * cos(omega * RAD)
        val decl = asin(sin(obliq * RAD) * sin(lambda * RAD))
        val y = tan(obliq / 2 * RAD).let { it * it }
        val eqTime = 4 / RAD * (
            y * sin(2 * l0 * RAD) - 2 * e * sin(m * RAD) + 4 * e * y * sin(m * RAD) * cos(2 * l0 * RAD) -
                0.5 * y * y * sin(4 * l0 * RAD) - 1.25 * e * e * sin(2 * m * RAD)
            )
        val utcMin = ((epochMs % DAY_MS.toLong()) + DAY_MS.toLong()) % DAY_MS.toLong() / 60_000.0
        val trueSolarMin = ((utcMin + eqTime + 4 * lon) % 1440 + 1440) % 1440
        val hourAngle = trueSolarMin / 4 - 180
        val cosZenith = (sin(lat * RAD) * sin(decl) + cos(lat * RAD) * cos(decl) * cos(hourAngle * RAD)).coerceIn(-1.0, 1.0)
        return 90 - acos(cosZenith) / RAD
    }
}

/**
 * Named places from the map's OSM data (assets/charm/map/derived/pois.json, built by scripts/build-map-data.py),
 * with a grid index for "what is near us". Pure; parsing takes a few hundred ms, so it is loaded once, lazily.
 */
class Places private constructor(
    private val names: Array<String>,
    private val cats: Array<String>,
    private val cat: IntArray,
    private val lat: DoubleArray,
    private val lon: DoubleArray,
    private val districts: IntArray,
) {
    data class Near(val name: String, val category: String, val distanceM: Int)

    private val grid = HashMap<Long, IntArray>().also { g ->
        val tmp = HashMap<Long, MutableList<Int>>()
        for (i in names.indices) if (weight(cats[cat[i]]) != null) tmp.getOrPut(key(row(lat[i]), col(lon[i]))) { ArrayList() }.add(i)
        for ((k, v) in tmp) g[k] = v.toIntArray()
    }

    val size: Int get() = names.size

    /** The best-named place within [MAX_NEAR_M]: a sight beats a closer bus stop or street. Null when nothing is near. */
    fun nearest(la: Double, lo: Double): Near? {
        val r = row(la)
        val c = col(lo)
        var best = -1
        var bestScore = Double.MAX_VALUE
        var bestDist = 0.0
        for (dr in -1..1) for (dc in -1..1) {
            val ids = grid[key(r + dr, c + dc)] ?: continue
            for (i in ids) {
                val d = distanceM(la, lo, lat[i], lon[i])
                if (d > MAX_NEAR_M) continue
                val s = d * weight(cats[cat[i]])!!
                if (s < bestScore) {
                    best = i
                    bestScore = s
                    bestDist = d
                }
            }
        }
        return if (best < 0) null else Near(names[best], cats[cat[best]], bestDist.roundToInt())
    }

    /** The nearest district-like area name ("Innere Altstadt") within [MAX_DISTRICT_M], or null. */
    fun district(la: Double, lo: Double): String? {
        var best: String? = null
        var bestD = MAX_DISTRICT_M
        for (i in districts) {
            val d = distanceM(la, lo, lat[i], lon[i])
            if (d < bestD) {
                bestD = d
                best = names[i]
            }
        }
        return best
    }

    companion object {
        const val MAX_NEAR_M = 400.0
        const val MAX_DISTRICT_M = 2_000.0
        private const val CELL_LAT = 0.004 // about 445 m
        private const val CELL_LON = 0.0064 // about 450 m at Dresden's latitude
        private const val M_PER_DEG = 111_320.0

        /** How much a category's distance counts: smaller wins. Null = never named (unnamed toilets, water taps). */
        private fun weight(category: String): Double? = when (category) {
            "sight" -> 0.5
            "park", "university", "area" -> 0.8
            "building", "hospital" -> 1.0
            "station", "hotel", "pharmacy", "police", "supermarket" -> 1.2
            "food" -> 1.5
            "street" -> 1.6
            "toilets", "drinking_water" -> null
            else -> 1.5
        }

        /** "area" also holds squares and pedestrian zones; a district has a name that is not a square, street or garden. */
        private val NOT_DISTRICT = Regex(
            "(platz|markt|hof|stra(ss|ß)e|gasse|weg|allee|ring|brücke|ufer|garten|park|passage|terrasse|zeile|siedlung)\\b|^(am|an|auf|im|in|zum|zur|an der|unter) ",
            RegexOption.IGNORE_CASE,
        )

        internal fun isDistrictName(name: String) = !NOT_DISTRICT.containsMatchIn(name)

        private fun row(la: Double) = floor(la / CELL_LAT).toLong()
        private fun col(lo: Double) = floor(lo / CELL_LON).toLong()
        private fun key(r: Long, c: Long) = (r shl 32) xor (c and 0xffffffffL)

        fun distanceM(la1: Double, lo1: Double, la2: Double, lo2: Double): Double =
            hypot((la1 - la2) * M_PER_DEG, (lo1 - lo2) * M_PER_DEG * cos((la1 + la2) / 2 * Math.PI / 180))

        /** pois.json: {"v":1,"cats":[...],"pois":[[name, cat, lat, lon], ...]}; a malformed entry is skipped. */
        fun parse(json: String): Places {
            val root = JSONObject(json)
            val catArr = root.getJSONArray("cats")
            val cats = Array(catArr.length()) { catArr.optString(it) }
            val arr = root.getJSONArray("pois")
            val names = ArrayList<String>(arr.length())
            val cat = IntArray(arr.length())
            val lat = DoubleArray(arr.length())
            val lon = DoubleArray(arr.length())
            var n = 0
            for (i in 0 until arr.length()) {
                val p = arr.optJSONArray(i) ?: continue
                val name = p.optString(0).trim()
                val c = p.optInt(1, -1)
                val la = p.optDouble(2)
                val lo = p.optDouble(3)
                if (name.isEmpty() || c !in cats.indices || la.isNaN() || lo.isNaN()) continue
                names += name
                cat[n] = c
                lat[n] = la
                lon[n] = lo
                n++
            }
            val area = cats.indexOf("area")
            val districts = (0 until n).filter { cat[it] == area && isDistrictName(names[it]) }.toIntArray()
            return Places(names.toTypedArray(), cats, cat.copyOf(n), lat.copyOf(n), lon.copyOf(n), districts)
        }
    }
}

/** Snapshot → command args (filled in for the page's rule replies, assistant.ts) and the one chat context line. Pure. */
object SenseFormat {
    /** Commands answered from the snapshot; native fills their args (Router.kt matches the words). */
    val COMMANDS = setOf("clock", "battery", "place", "sky", "altitude", "speed", "dark", "awake")

    /** Fixes older than this are "where we were", not "where we are". */
    const val FRESH_FIX_S = 120L
    /** Speed and heading only from a fix this fresh. */
    const val FRESH_SPEED_S = 10L
    /** A fix this old is still worth a "last I knew…". */
    const val OLD_FIX_S = 30 * 60L
    /** Below this, the phone is standing still (GPS speed jitters by about this much). */
    const val MOVING_MPS = 0.5
    /** Longest place name in the chat line (it is OSM data, not ours). */
    private const val CHAT_NAME = 28

    /** Fixes less accurate than this do not answer "where are we" without first trying for a better one. */
    const val PLACE_ACC_M = 150.0

    /** True when [name] needs GPS switched on first: no fresh enough fix (or no satellite list) in the snapshot. */
    fun needsGps(name: String, s: Snapshot): Boolean = when (name) {
        "place" -> s.fix.let { it == null || it.ageS > FRESH_FIX_S || it.accM > PLACE_ACC_M }
        "altitude" -> s.fix.let { it == null || it.ageS > FRESH_FIX_S || it.altitudeM == null }
        "speed" -> s.fix.let { it == null || it.ageS > FRESH_SPEED_S }
        "sky" -> s.sky == null
        else -> false
    }

    fun args(name: String, s: Snapshot): JSONObject {
        val o = JSONObject()
        when (name) {
            "clock" -> o.put("hhmm", "%02d:%02d".format(Locale.ROOT, s.local.hour, s.local.minute))
                .put("weekday", s.local.dayOfWeek.getDisplayName(TextStyle.FULL, Locale.ENGLISH))
                .put("day", s.local.dayOfMonth)
                .put("month", s.local.month.getDisplayName(TextStyle.FULL, Locale.ENGLISH))
                .put("year", s.local.year)
                .put("hour", s.local.hour)
            "battery" -> {
                s.batteryPct?.let { o.put("level", it) }
                s.charging?.let { o.put("charging", it) }
            }
            "place" -> place(o, s)
            "sky" -> sky(o, s.sky)
            "altitude" -> {
                val f = s.fix?.takeIf { it.ageS <= FRESH_FIX_S }
                f?.altitudeM?.let { o.put("m", roundTo(it, 5)) }
                f?.vAccM?.let { o.put("acc", roundTo(it, 5).coerceAtLeast(5)) }
                if (f == null) sky(o, s.sky)
            }
            "speed" -> {
                val f = s.fix?.takeIf { it.ageS <= FRESH_SPEED_S }
                if (f == null) sky(o, s.sky)
                else {
                    val mps = f.speedMps ?: 0.0
                    o.put("fix", true).put("moving", mps >= MOVING_MPS).put("kmh", Math.round(mps * 36) / 10.0)
                    if (mps >= MOVING_MPS) f.bearingDeg?.let { o.put("heading", compass(it)) }
                }
            }
            "dark" -> {
                o.put("sunElevation", Math.round(s.sunElevation * 10) / 10.0)
                s.light?.let { o.put("light", it) }
            }
            "awake" -> o.put("minutes", s.awakeMs / 60_000)
        }
        return o
    }

    private fun place(o: JSONObject, s: Snapshot) {
        val f = s.fix
        if (f == null || f.ageS > OLD_FIX_S) {
            o.put("fix", false)
            sky(o, s.sky)
            return
        }
        o.put("fix", true).put("ageS", f.ageS).put("acc", roundTo(f.accM, 5).coerceAtLeast(5))
        if (f.ageS > FRESH_FIX_S) sky(o, s.sky) // "last I knew…": also say why there is nothing newer
        s.place?.let { o.put("near", it.name).put("category", it.category).put("distanceM", roundTo(it.distanceM.toDouble(), 10)) }
        s.district?.takeIf { it != s.place?.name }?.let { o.put("district", it) }
    }

    private fun sky(o: JSONObject, sky: SkySummary?) {
        if (sky == null) return
        o.put("seen", sky.total).put("used", sky.used).put("best", sky.best)
    }

    private fun roundTo(v: Double, step: Int) = (Math.round(v / step) * step).toInt()

    /** Eight compass words for a bearing in degrees. */
    fun compass(deg: Double): String {
        val names = arrayOf("north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west")
        return names[(((deg % 360) + 360) % 360 / 45 + 0.5).toInt() % 8]
    }

    /** "dark outside", "twilight", "daylight": the sun's height, not the room's light. */
    fun daylight(elevation: Double) = when {
        elevation < -6 -> "dark outside"
        elevation < 0 -> "twilight"
        else -> "daylight"
    }

    /**
     * One short line of facts for the chat model, e.g. "Saturday 22:10, dark outside, near Zwinger (Innere Altstadt),
     * battery 64%." Only what is known; a place only from a fix younger than [FRESH_FIX_S] × 5.
     */
    fun chatLine(s: Snapshot): String {
        val parts = ArrayList<String>()
        parts += "${s.local.dayOfWeek.getDisplayName(TextStyle.FULL, Locale.ENGLISH)} ${"%02d:%02d".format(Locale.ROOT, s.local.hour, s.local.minute)}"
        parts += daylight(s.sunElevation)
        val f = s.fix
        if (f != null && f.ageS <= FRESH_FIX_S * 5) {
            val near = s.place?.name?.let(::clip)
            val district = s.district?.takeIf { it != s.place?.name }?.let(::clip)
            when {
                near != null && district != null -> parts += "near $near ($district)"
                near != null -> parts += "near $near"
                district != null -> parts += "in $district"
            }
        }
        // No battery here: the small chat model parroted it ("what's the day today" → "my battery is 64%").
        return parts.joinToString(", ") + "."
    }

    /** Place names come from map data: no tags or line breaks, and short. */
    private fun clip(name: String) = name.replace(Regex("[<>\\n\\r]"), " ").trim().take(CHAT_NAME)
}

/** Assembles a [Snapshot] from the phone. Reads only what other parts already keep warm; never starts a sensor. */
class Senses(private val context: Context, private val extras: Extras, private val gps: LocationFeed) {
    private val battery = context.getSystemService(BatteryManager::class.java)

    /** Loaded on first use (on the work thread); null if the map data was not bundled. */
    private val places: Places? by lazy {
        runCatching { Places.parse(context.assets.open(POIS).bufferedReader().use { it.readText() }) }
            .onFailure { Log.w(TAG, "places not loaded", it) }.getOrNull()
            .also { if (BuildConfig.DEBUG) Log.d(TAG, "hop senses places=${it?.size ?: 0}") }
    }

    /** Loads the places ahead of the first question (call off the main thread). */
    fun warm() {
        places
    }

    /** Call off the main thread: the first call may load the places. [sky] defaults to what the GPS hears now. */
    fun snapshot(sky: SkySummary? = gps.sky): Snapshot {
        val nowMs = System.currentTimeMillis()
        val last = gps.newest()
        val fix = last?.let(::fix)
        val near = fix?.takeIf { it.ageS <= SenseFormat.OLD_FIX_S }?.let { places?.nearest(it.lat, it.lon) }
        val district = fix?.takeIf { it.ageS <= SenseFormat.OLD_FIX_S }?.let { places?.district(it.lat, it.lon) }
        val pct = battery?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)?.takeIf { it in 0..100 }
        return Snapshot(
            local = LocalDateTime.ofInstant(Instant.ofEpochMilli(nowMs), ZoneId.systemDefault()),
            batteryPct = pct,
            charging = battery?.isCharging,
            light = extras.lightLevel?.wire,
            sunElevation = SunMath.elevation(nowMs, fix?.lat ?: DRESDEN_LAT, fix?.lon ?: DRESDEN_LON),
            fix = fix,
            place = near,
            district = district,
            sky = sky,
            awakeMs = SystemClock.elapsedRealtime() - Process.getStartElapsedRealtime(),
        )
    }

    private fun fix(l: Location): Snapshot.Fix {
        val ageS = (SystemClock.elapsedRealtimeNanos() - l.elapsedRealtimeNanos) / 1_000_000_000
        return Snapshot.Fix(
            lat = l.latitude,
            lon = l.longitude,
            accM = if (l.hasAccuracy()) l.accuracy.toDouble() else 50.0,
            ageS = ageS.coerceAtLeast(0),
            // GPS gives height above the WGS84 ellipsoid; the geoid in Dresden sits about 45 m above it.
            altitudeM = if (l.hasAltitude()) l.altitude - DRESDEN_GEOID_M else null,
            vAccM = if (l.hasVerticalAccuracy()) l.verticalAccuracyMeters.toDouble() else null,
            speedMps = if (l.hasSpeed()) l.speed.toDouble() else null,
            bearingDeg = if (l.hasBearing()) l.bearing.toDouble() else null,
        )
    }

    companion object {
        private const val TAG = "Charm"
        private const val POIS = "charm/map/derived/pois.json"
        private const val DRESDEN_LAT = 51.0504
        private const val DRESDEN_LON = 13.7373
        /** EGM96 geoid height over the WGS84 ellipsoid around Dresden (≈ 45–46 m). */
        private const val DRESDEN_GEOID_M = 45.5
    }
}
