package io.github.haardhikk.charm

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import org.json.JSONObject
import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.sqrt

/**
 * The metal detector: the magnetometer at ~50 Hz on its own background thread, only while the page has the mode on.
 * Sends `{type:"mag", ut, delta}` (µT, see web/src/metal.ts) at most [MetalMeter.SEND_GAP_MS] apart.
 * Prefers the uncalibrated sensor (it reports its hard-iron bias, which [MetalMeter] removes itself).
 */
class MetalDetector(context: Context) : SensorEventListener {
    private val sensors = context.getSystemService(SensorManager::class.java)
    private var thread: HandlerThread? = null
    private var post: ((JSONObject) -> Unit)? = null
    private val meter = MetalMeter()
    private var lastLogMs = 0L

    /** True if a magnetometer was found and registered. */
    fun start(post: (JSONObject) -> Unit): Boolean {
        if (thread != null) return true
        val sensor = sensors.getDefaultSensor(Sensor.TYPE_MAGNETIC_FIELD_UNCALIBRATED)
            ?: sensors.getDefaultSensor(Sensor.TYPE_MAGNETIC_FIELD)
            ?: return false
        this.post = post
        meter.reset()
        lastLogMs = 0L
        val t = HandlerThread("charm-metal").also { it.start() }
        thread = t
        sensors.registerListener(this, sensor, SAMPLE_US, Handler(t.looper))
        return true
    }

    fun stop() {
        val t = thread ?: return
        sensors.unregisterListener(this)
        t.quitSafely()
        thread = null
        post = null
    }

    override fun onSensorChanged(e: SensorEvent) {
        val v = e.values
        val uncalibrated = e.sensor.type == Sensor.TYPE_MAGNETIC_FIELD_UNCALIBRATED && v.size >= 6
        val ms = e.timestamp / 1_000_000
        val r = if (uncalibrated) meter.update(v[0], v[1], v[2], v[3], v[4], v[5], ms) else meter.update(v[0], v[1], v[2], 0f, 0f, 0f, ms)
        r ?: return
        if (BuildConfig.DEBUG && ms - lastLogMs >= 1000) {
            lastLogMs = ms
            Log.d("Charm", "hop mag ut=${Math.round(r.ut)} delta=${Math.round(r.delta)}")
        }
        post?.invoke(JSONObject().put("type", "mag").put("ut", round1(r.ut)).put("delta", round1(r.delta)))
    }

    override fun onAccuracyChanged(sensor: Sensor, accuracy: Int) = Unit

    private fun round1(f: Float) = Math.round(f * 10) / 10.0

    companion object {
        private const val SAMPLE_US = 20_000 // 50 Hz
    }
}

data class MetalReading(val ut: Float, val delta: Float)

/**
 * The pure maths (unit-tested): field strength in µT with the hard-iron bias removed, lightly smoothed, against a
 * slow baseline. The baseline starts at Dresden's ≈49 µT, settles quickly onto the room in the first [WARMUP_MS]
 * (the phone is usually not over metal when the mode opens), then follows only very slowly, and slower still while
 * something strong is near, so holding the phone on a magnet does not erase it. A baseline far above the reading is
 * stale (metal raises the field) and follows down within seconds.
 * [update] returns a reading at most every [SEND_GAP_MS] (≤10 Hz to the page), else null.
 */
class MetalMeter {
    var baseline = EARTH_UT
        private set
    private var smooth = -1f
    private var startMs = -1L
    private var lastMs = -1L
    private var sentMs: Long? = null
    private var lastBias = floatArrayOf(Float.NaN, Float.NaN, Float.NaN)
    private var fallingFast = false

    fun reset() {
        baseline = EARTH_UT
        smooth = -1f
        startMs = -1L
        lastMs = -1L
        sentMs = null
        lastBias = floatArrayOf(Float.NaN, Float.NaN, Float.NaN)
        fallingFast = false
    }

    fun update(x: Float, y: Float, z: Float, bx: Float, by: Float, bz: Float, nowMs: Long): MetalReading? {
        val m = magnitude(x - bx, y - by, z - bz)
        if (!m.isFinite()) return null
        // The sensor's own hard-iron estimate arrives (or changes) after the first readings: until then the raw
        // magnitude is far off (seen on the phone: ≈316 µT vs a real 36). Settle again whenever it moves.
        if (lastBias[0].isNaN() || abs(bx - lastBias[0]) + abs(by - lastBias[1]) + abs(bz - lastBias[2]) > BIAS_JUMP_UT) {
            if (!lastBias[0].isNaN()) {
                // The old baseline was measured with the wrong bias: start over. Only from here if the reading looks
                // like the bare Earth field; otherwise (metal is near right now) from Dresden's field, without the
                // warm-up, so the metal still shows and the baseline does not lock onto it.
                smooth = m
                fallingFast = false
                if (m in PLAUSIBLE_MIN_UT..PLAUSIBLE_MAX_UT) {
                    baseline = m
                    startMs = nowMs
                } else {
                    baseline = EARTH_UT
                    startMs = nowMs - WARMUP_MS
                }
                lastMs = nowMs
            }
            lastBias = floatArrayOf(bx, by, bz)
        }
        if (startMs < 0) {
            startMs = nowMs
            lastMs = nowMs
            smooth = m
        }
        val dt = ((nowMs - lastMs).coerceIn(0, 500)) / 1000f
        lastMs = nowMs
        smooth += (m - smooth) * blend(dt, SMOOTH_TAU_S)
        // Metal almost always raises the field: a baseline well above the reading is stale (it settled next to a
        // laptop, or the calibration shifted), so it follows down quickly until it is back on the reading.
        // A short dip still shows for a moment.
        if (smooth < baseline - STRONG_UT) fallingFast = true
        else if (smooth >= baseline - SETTLED_UT) fallingFast = false
        val tau = when {
            nowMs - startMs < WARMUP_MS -> WARMUP_TAU_S
            fallingFast -> FAST_DOWN_TAU_S
            abs(smooth - baseline) > STRONG_UT -> STRONG_TAU_S
            else -> BASELINE_TAU_S
        }
        baseline += (smooth - baseline) * blend(dt, tau)
        val sent = sentMs
        if (sent != null && nowMs - sent < SEND_GAP_MS) return null
        sentMs = nowMs
        return MetalReading(smooth, abs(smooth - baseline))
    }

    companion object {
        /** Earth's local field (total intensity; ≈49 µT in Dresden). */
        val EARTH_UT = DeviceProfile.CURRENT.sensors.earthFieldUt
        const val SEND_GAP_MS = 100L
        const val WARMUP_MS = 1500L
        const val WARMUP_TAU_S = 0.4f
        const val BASELINE_TAU_S = 60f
        const val STRONG_TAU_S = 300f
        const val STRONG_UT = 15f
        const val SMOOTH_TAU_S = 0.08f
        const val BIAS_JUMP_UT = 5f
        const val FAST_DOWN_TAU_S = 2f
        const val SETTLED_UT = 1f
        /** Readings in this range can be the bare Earth field (anywhere on Earth: ≈25–65 µT). */
        const val PLAUSIBLE_MIN_UT = 25f
        const val PLAUSIBLE_MAX_UT = 65f

        fun magnitude(x: Float, y: Float, z: Float) = sqrt(x * x + y * y + z * z)

        /** Exponential smoothing weight for a step of [dt] seconds with time constant [tau]. */
        fun blend(dt: Float, tau: Float) = 1f - exp(-dt / tau)
    }
}
