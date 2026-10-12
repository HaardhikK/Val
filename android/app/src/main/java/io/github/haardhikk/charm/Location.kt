package io.github.haardhikk.charm

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.pm.PackageManager
import android.location.GnssStatus
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import org.json.JSONObject

/**
 * GPS fixes for the offline map and Val's senses, straight from the GPS chip (no Google services, no network location:
 * Charm has no internet). Each fix goes to the page as {"type":"fix","lat","lon","acc","ageMs","heading"?};
 * ageMs is how old the fix already is (the chip's last known fix can be minutes old), so the page never shows it as fresh.
 * Heading is the direction of travel, sent only while walking (GPS has no heading when standing still).
 * While GPS is on, the satellites it hears go to the page once a second as {"type":"sky","total","used","best"}.
 * GPS runs while anyone wants it ([want]: the open map, or a "where are we" question) and the activity is in front.
 * Main thread only, except [last] and [sky], which any thread may read.
 */
class LocationFeed(
    private val activity: Activity,
    private val toPage: (JSONObject) -> Unit,
) : LocationListener {

    enum class Start { STARTED, ASKING, DENIED, GPS_OFF }

    private val manager = activity.getSystemService(LocationManager::class.java)
    private var running = false
    private var asks = 0 // permission requests this app start: a refusal never loops (see [mayAsk])
    private val wants = HashSet<String>()
    private var lastSkySentMs = 0L
    private var skyLogs = 0

    /** The newest fix (live, or the chip's last known one), for Senses.kt. */
    @Volatile var last: Location? = null
        private set

    /** What the GPS chip hears right now; null while GPS is off. */
    @Volatile var sky: SkySummary? = null
        private set

    /** Called on the main thread with every live fix. */
    var onFix: ((Location) -> Unit)? = null

    val hasPermission: Boolean
        get() = activity.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED

    val wanted: Boolean get() = wants.isNotEmpty()

    /** [last], or the chip's last known fix when GPS has not run yet this session (any thread). */
    @SuppressLint("MissingPermission") // checked first
    fun newest(): Location? {
        val l = last
        if (l != null || !hasPermission) return l
        return runCatching { manager.getLastKnownLocation(LocationManager.GPS_PROVIDER) }.getOrNull()?.also { last = it }
    }

    private val gnss = object : GnssStatus.Callback() {
        override fun onSatelliteStatusChanged(status: GnssStatus) {
            val n = status.satelliteCount
            val s = SkySummary.of(
                IntArray(n) { status.getConstellationType(it) },
                FloatArray(n) { status.getCn0DbHz(it) },
                BooleanArray(n) { status.usedInFix(it) },
            )
            sky = s
            val now = SystemClock.uptimeMillis()
            if (now - lastSkySentMs < SKY_INTERVAL_MS) return
            lastSkySentMs = now
            toPage(JSONObject().put("type", "sky").put("total", s.total).put("used", s.used).put("best", s.best))
            if (BuildConfig.DEBUG && skyLogs++ % SKY_LOG_EVERY == 0) Log.d(TAG, "hop sky total=${s.total} used=${s.used} best=${s.best}")
        }

        override fun onStopped() {
            sky = null
        }
    }

    /**
     * [who] wants GPS on (or no longer); GPS runs while anyone does. Returns how starting went (STARTED also when it
     * was already running, or when nobody wants it any more). [explicit] marks a user action (opening the map): after
     * a refusal it may ask for the permission one more time.
     */
    fun want(who: String, on: Boolean, explicit: Boolean = false): Start {
        if (on) wants += who else wants -= who
        if (wants.isEmpty()) {
            stop()
            return Start.STARTED
        }
        return start(explicit)
    }

    /** Resumes GPS after onPause (or a granted permission) if someone still wants it. */
    fun resume() {
        if (wanted) start(explicit = false)
    }

    /** The permission was refused: nobody can have GPS, so forget who wanted it (onResume must not re-report it). */
    fun denied() {
        wants.clear()
        stop()
    }

    /** Starts GPS updates, or asks for the permission first ([resume] again from onRequestPermissionsResult). */
    @SuppressLint("MissingPermission") // checked just above each call
    private fun start(explicit: Boolean): Start {
        if (running) return Start.STARTED
        if (!hasPermission) {
            if (!mayAsk(asks, explicit)) {
                denied()
                toPage(JSONObject().put("type", "fixError").put("reason", "denied"))
                return Start.DENIED
            }
            asks++
            // Android 12+ ignores a fine-location request that does not also ask for coarse.
            activity.requestPermissions(
                arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION),
                REQUEST_CODE,
            )
            return Start.ASKING
        }
        if (!manager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
            toPage(JSONObject().put("type", "fixError").put("reason", "gpsOff"))
            return Start.GPS_OFF
        }
        running = true
        // A recent fix from before (up to 10 min old) puts the dot on the map at once; the GPS refines it.
        manager.getLastKnownLocation(LocationManager.GPS_PROVIDER)?.let { known ->
            val prev = last
            if (prev == null || known.elapsedRealtimeNanos > prev.elapsedRealtimeNanos) last = known
            if (fixAgeMs(SystemClock.elapsedRealtimeNanos(), known.elapsedRealtimeNanos) < MAX_LAST_KNOWN_AGE_MS) send(known)
        }
        manager.requestLocationUpdates(LocationManager.GPS_PROVIDER, INTERVAL_MS, 0f, this, Looper.getMainLooper())
        manager.registerGnssStatusCallback(activity.mainExecutor, gnss)
        return Start.STARTED
    }

    /** Stops GPS (onPause, or nobody wants it); who wants it is kept for [resume]. */
    fun stop() {
        if (!running) return
        running = false
        manager.removeUpdates(this)
        manager.unregisterGnssStatusCallback(gnss)
        sky = null
    }

    override fun onLocationChanged(location: Location) {
        last = location
        send(location)
        onFix?.invoke(location)
    }

    override fun onProviderDisabled(provider: String) {
        toPage(JSONObject().put("type", "fixError").put("reason", "gpsOff"))
    }

    private fun send(l: Location) {
        val heading = if (l.hasBearing() && l.hasSpeed() && l.speed > MIN_SPEED_FOR_HEADING) l.bearing.toDouble() else null
        val ageMs = fixAgeMs(SystemClock.elapsedRealtimeNanos(), l.elapsedRealtimeNanos)
        toPage(fixMessage(l.latitude, l.longitude, if (l.hasAccuracy()) l.accuracy.toDouble() else 50.0, heading, ageMs))
    }

    companion object {
        private const val TAG = "Charm"
        const val REQUEST_CODE = 11

        /** Ask once per app start, and once more on the next explicit map open after a refusal; never in a loop. */
        fun mayAsk(asks: Int, explicit: Boolean): Boolean = asks == 0 || (explicit && asks == 1)

        /** How old a fix is, from the elapsed-realtime clock; never negative. */
        fun fixAgeMs(nowNanos: Long, fixNanos: Long): Long = ((nowNanos - fixNanos) / 1_000_000).coerceAtLeast(0)

        fun fixMessage(lat: Double, lon: Double, acc: Double, heading: Double?, ageMs: Long): JSONObject {
            val msg = JSONObject().put("type", "fix").put("lat", lat).put("lon", lon).put("acc", acc).put("ageMs", ageMs)
            if (heading != null) msg.put("heading", heading)
            return msg
        }
        private const val INTERVAL_MS = 1000L
        private const val MAX_LAST_KNOWN_AGE_MS = 10 * 60 * 1000L
        private const val MIN_SPEED_FOR_HEADING = 0.7f // m/s, a slow walk
        private const val SKY_INTERVAL_MS = 1000L
        private const val SKY_LOG_EVERY = 10 // one debug line per ~10 s of sky messages
    }
}
