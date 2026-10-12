package io.github.haardhikk.charm

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.BatteryManager
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import org.json.JSONObject

/**
 * Cheap delight sensors for the page: proximity (peekaboo), ambient light (sleepy / sunglasses) and battery.
 * Runs on its own background thread and posts only when a reading changes (see web/src/bridge.ts → SensorEvent).
 * Call [start] in onResume and [stop] in onPause.
 */
class Extras(private val context: Context) : SensorEventListener {
    private val sensors = context.getSystemService(SensorManager::class.java)
    private var thread: HandlerThread? = null
    private var handler: Handler? = null
    private var post: ((JSONObject) -> Unit)? = null

    private val proximity = ProximityState()
    private val light = LightHysteresis()
    private val battery = BatteryState()
    private var lastLux = -1f
    private var proximityRange = 5f

    /** The settled light level (read from any thread, Senses.kt), null until the first reading or without a sensor. */
    @Volatile var lightLevel: LightLevel? = null
        private set

    private val tick = object : Runnable {
        // The light sensor reports only on change, so a steady reading is re-fed once a second for the 2 s holds.
        override fun run() {
            if (lastLux >= 0) feedLight(lastLux)
            handler?.postDelayed(this, LIGHT_TICK_MS)
        }
    }

    private val batteryReceiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) {
            val level = i.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
            val scale = i.getIntExtra(BatteryManager.EXTRA_SCALE, 100)
            if (level < 0 || scale <= 0) return
            val status = i.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
            val charging = status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL
            val temp = i.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0) / 10f
            battery.update(level * 100 / scale, charging, temp)?.let { emit(ExtrasMessage.battery(it)) }
        }
    }

    fun start(post: (JSONObject) -> Unit) {
        if (thread != null) return
        this.post = post
        proximity.reset()
        light.reset()
        battery.reset() // a fresh start (or a reloaded page) gets every current state again
        lastLux = -1f
        lightLevel = null
        val t = HandlerThread("charm-extras").also { it.start() }
        val h = Handler(t.looper)
        thread = t
        handler = h
        sensors.getDefaultSensor(Sensor.TYPE_PROXIMITY)?.let {
            proximityRange = it.maximumRange
            sensors.registerListener(this, it, SensorManager.SENSOR_DELAY_NORMAL, h)
        }
        sensors.getDefaultSensor(Sensor.TYPE_LIGHT)?.let {
            sensors.registerListener(this, it, 1_000_000, h) // 1 Hz is plenty
        }
        context.registerReceiver(batteryReceiver, IntentFilter(Intent.ACTION_BATTERY_CHANGED), null, h)
        h.postDelayed(tick, LIGHT_TICK_MS)
    }

    fun stop() {
        val t = thread ?: return
        sensors.unregisterListener(this)
        runCatching { context.unregisterReceiver(batteryReceiver) }
        handler?.removeCallbacksAndMessages(null)
        t.quitSafely()
        thread = null
        handler = null
        post = null
    }

    override fun onSensorChanged(e: SensorEvent) {
        when (e.sensor.type) {
            Sensor.TYPE_PROXIMITY ->
                proximity.reading(e.values[0], proximityRange)?.let { emit(ExtrasMessage.proximity(it)) }
            Sensor.TYPE_LIGHT -> {
                lastLux = e.values[0]
                feedLight(lastLux)
            }
        }
    }

    override fun onAccuracyChanged(sensor: Sensor, accuracy: Int) = Unit

    private fun feedLight(lux: Float) {
        light.update(lux, SystemClock.uptimeMillis())?.let {
            lightLevel = it
            emit(ExtrasMessage.light(it, lux))
        }
    }

    private fun emit(json: JSONObject) {
        post?.invoke(json)
    }

    companion object {
        private const val LIGHT_TICK_MS = 1000L
    }
}

/** Binary near/far, reported only when it flips. */
class ProximityState {
    private var near: Boolean? = null
    private val seen = HashSet<Float>() // distinct distances this sensor reports (kept across [reset]: a sensor trait)

    fun reset() {
        near = null
    }

    /** One sensor reading: the new state if it changed, else null. */
    fun reading(distance: Float, maxRange: Float): Boolean? {
        if (!distance.isFinite()) return null
        if (seen.size <= 2) seen += distance
        return update(isNear(distance, maxRange, seen))
    }

    /** The new state if it changed, else null. */
    fun update(isNear: Boolean): Boolean? {
        if (isNear == near) return null
        near = isNear
        return isNear
    }

    companion object {
        /**
         * Most phones report 0 (near) or the maximum range (far); some report centimetres. A binary sensor (only two
         * distinct values seen so far) is near on its lower value, whatever its far value is (e.g. 0 and 3 with a
         * 5 cm range would otherwise read near forever).
         */
        fun isNear(distance: Float, maxRange: Float, seen: Set<Float> = emptySet()) =
            if (seen.size == 2) distance < seen.max() else distance < minOf(maxRange, NEAR_CM)
        private val NEAR_CM = DeviceProfile.CURRENT.sensors.proximityNearCm
    }
}

enum class LightLevel(val wire: String) { DARK("dark"), NORMAL("normal"), BRIGHT("bright") }

/**
 * Ambient light with hysteresis: dark below 10 lux and bright above 5000 lux, each only after holding for 2 s;
 * leaving dark needs 30 lux and leaving bright needs to fall under 3000 lux (also held 2 s), so a lamp flicker never jitters.
 */
class LightHysteresis {
    var level = LightLevel.NORMAL
        private set
    private var reported = false
    private var candidate: LightLevel? = null
    private var candidateSince = 0L

    fun reset() {
        level = LightLevel.NORMAL
        reported = false
        candidate = null
    }

    private fun target(lux: Float): LightLevel = when (level) {
        LightLevel.DARK -> if (lux < DARK_EXIT) LightLevel.DARK else if (lux > BRIGHT_ENTER) LightLevel.BRIGHT else LightLevel.NORMAL
        LightLevel.BRIGHT -> if (lux > BRIGHT_EXIT) LightLevel.BRIGHT else if (lux < DARK_ENTER) LightLevel.DARK else LightLevel.NORMAL
        LightLevel.NORMAL -> if (lux < DARK_ENTER) LightLevel.DARK else if (lux > BRIGHT_ENTER) LightLevel.BRIGHT else LightLevel.NORMAL
    }

    /** The new level if it changed (or the first settled reading), else null. */
    fun update(lux: Float, nowMs: Long): LightLevel? {
        val t = target(lux)
        if (t == level) {
            candidate = null
            if (!reported) {
                reported = true
                return level
            }
            return null
        }
        if (candidate != t) {
            candidate = t
            candidateSince = nowMs
            return null
        }
        if (nowMs - candidateSince < HOLD_MS) return null
        level = t
        candidate = null
        reported = true
        return level
    }

    companion object {
        val DARK_ENTER = DeviceProfile.CURRENT.sensors.lightDarkEnter
        val DARK_EXIT = DeviceProfile.CURRENT.sensors.lightDarkExit
        val BRIGHT_ENTER = DeviceProfile.CURRENT.sensors.lightBrightEnter
        val BRIGHT_EXIT = DeviceProfile.CURRENT.sensors.lightBrightExit
        const val HOLD_MS = 2000L
    }
}

data class BatteryReading(val level: Int, val charging: Boolean, val temp: Float)

/** Battery level and charging, reported on change; temperature only when it moves by at least 1 °C. */
class BatteryState {
    private var last: BatteryReading? = null

    fun reset() {
        last = null
    }

    fun update(level: Int, charging: Boolean, temp: Float): BatteryReading? {
        val prev = last
        if (prev != null && prev.level == level && prev.charging == charging && kotlin.math.abs(prev.temp - temp) < 1f) return null
        return BatteryReading(level, charging, temp).also { last = it }
    }
}

/** Page messages for the extras (see web/src/bridge.ts → parseSensor). */
object ExtrasMessage {
    fun proximity(near: Boolean): JSONObject = JSONObject().put("type", "proximity").put("near", near)

    fun light(level: LightLevel, lux: Float): JSONObject =
        JSONObject().put("type", "light").put("level", level.wire).put("lux", Math.round(lux).toInt())

    fun battery(b: BatteryReading): JSONObject =
        JSONObject().put("type", "battery").put("level", b.level).put("charging", b.charging).put("temp", b.temp.toDouble())
}
