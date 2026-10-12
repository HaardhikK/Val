package io.github.haardhikk.charm

import kotlin.math.abs
import kotlin.math.hypot

/** Which side of the phone a knock came from, in screen terms (portrait). */
enum class KnockSide(val wire: String) { LEFT("left"), RIGHT("right"), TOP("top"), BOTTOM("bottom") }

/**
 * "Knock on the table": finds short, sharp jolts in the raw accelerometer while the phone lies still and face up, and
 * groups them (1, 2, 3 knocks). Pure logic, no Android types, fed at the sensor's fastest rate on a background thread.
 *
 * A knock is: phone flat and quiet for [QUIET_MS], then a z-axis high-pass spike above [PEAK_MIN] that is back below
 * [RELEASE] within [MAX_DUR_MS], with the gyro staying under [GYRO_MAX] (a pickup or a spin tilts the phone; a knock
 * does not). Allocation-free per sample: a running baseline (exponential average) is the high-pass, the rest is state.
 *
 * [push] returns [NONE], [KNOCK] (one more knock: read [count], [side], [peak]) or [GROUP] (the pause after the last
 * knock ended the group: read [count] and [side]). [log] receives one line per candidate spike (debug builds only).
 */
class KnockDetector(private val log: ((String) -> Unit)? = null) {
    // Results of the last KNOCK or GROUP.
    var count = 0
        private set
    var side: KnockSide? = null
        private set
    var peak = 0f
        private set

    private var lastT = -1L
    private var bx = 0f
    private var by = 0f
    private var bz = 0f

    // The spike being measured (a candidate), if any.
    private var inSpike = false
    private var spikeStart = 0L
    private var spikePeak = 0f
    private var spikeHx = 0f
    private var spikeHy = 0f
    private var spikeGyro = 0f
    private var spikeQuiet = false

    private var lastNoiseAt = Long.MIN_VALUE / 2 // last loud sample that was not a knock or its ringing
    private var ringUntil = Long.MIN_VALUE / 2
    private var lastKnockAt = Long.MIN_VALUE / 2
    private var touchAt = Long.MIN_VALUE / 2
    private var muteUntil = Long.MIN_VALUE / 2
    private var pending = 0
    private var pendingSide: KnockSide? = null

    /** A finger touched or left the screen (that jolts the phone too): spikes near it are not knocks. */
    fun touched(tMs: Long) {
        touchAt = tMs
    }

    /** Our own vibration or voice shakes the phone: ignore everything until [untilMs]. */
    fun mute(untilMs: Long) {
        if (untilMs > muteUntil) muteUntil = untilMs
    }

    /** Forget everything (the phone was lifted, or the sensor stopped): a later knock starts fresh. */
    fun reset() {
        lastT = -1L
        inSpike = false
        pending = 0
        pendingSide = null
    }

    /** One raw accelerometer sample (m/s², gravity included) and the latest gyro magnitude (rad/s). */
    fun push(tMs: Long, ax: Float, ay: Float, az: Float, gyroMag: Float): Int {
        if (lastT < 0) { // first sample: start the baseline here
            lastT = tMs
            bx = ax; by = ay; bz = az
            lastNoiseAt = tMs // a fresh start needs QUIET_MS of calm first
            return NONE
        }
        val dt = (tMs - lastT).coerceIn(0L, 100L).toFloat()
        lastT = tMs
        val hx = ax - bx
        val hy = ay - by
        val hz = az - bz
        // The baseline follows slow changes only, and freezes during a spike so the spike never leaks into it.
        if (!inSpike) {
            val k = dt / (BASELINE_TAU_MS + dt)
            bx += hx * k; by += hy * k; bz += hz * k
        }
        val flat = bz > FLAT_Z && hypot(bx, by) < FLAT_TILT
        if (!flat) {
            inSpike = false
            pending = 0
            lastNoiseAt = tMs
            return NONE
        }

        var result = NONE
        // A pause after the last knock closes the group.
        if (pending > 0 && !inSpike && tMs - lastKnockAt > GROUP_GAP_MS) {
            count = pending
            side = pendingSide
            pending = 0
            pendingSide = null
            result = GROUP
        }

        val mag = abs(hz)
        if (!inSpike) {
            if (mag > TRIGGER) {
                inSpike = true
                spikeStart = tMs
                spikePeak = mag
                spikeHx = hx; spikeHy = hy
                spikeGyro = gyroMag
                spikeQuiet = tMs - lastNoiseAt >= QUIET_MS
            } else if (hypot(hx, hy) > QUIET_LEVEL || mag > QUIET_LEVEL) {
                if (tMs > ringUntil) lastNoiseAt = tMs // ringing right after a knock is part of that knock
            }
            return result
        }

        // Inside a spike: track its peak and the sideways push at the peak.
        if (mag > spikePeak) {
            spikePeak = mag
            spikeHx = hx; spikeHy = hy
        }
        if (gyroMag > spikeGyro) spikeGyro = gyroMag
        if (mag > RELEASE && tMs - spikeStart <= MAX_DUR_MS * 3) return result // still ringing (give up when far too long)
        inSpike = false
        return if (judge(tMs)) KNOCK else result // a group never closes inside a spike, so both cannot happen at once
    }

    /** The spike just ended at [end]: is it a knock? Logs every candidate with its verdict. */
    private fun judge(end: Long): Boolean {
        val dur = end - spikeStart
        val verdict = when {
            spikeStart < muteUntil -> "muted"
            abs(spikeStart - touchAt) < TOUCH_GUARD_MS -> "touch"
            !spikeQuiet -> "noisy"
            spikePeak < PEAK_MIN -> "weak"
            dur > MAX_DUR_MS -> "long"
            spikeGyro > GYRO_MAX -> "gyro"
            spikeStart - lastKnockAt < DEBOUNCE_MS -> "bounce"
            else -> "ok"
        }
        val ok = verdict == "ok"
        if (ok) {
            val s = sideOf(spikeHx, spikeHy, spikePeak)
            if (pending == 0) pendingSide = s
            pending = (pending + 1).coerceAtMost(MAX_COUNT)
            lastKnockAt = spikeStart
            ringUntil = end + RING_MS
            count = pending
            side = s
            peak = spikePeak
        } else if (verdict != "bounce") {
            lastNoiseAt = end
            if (verdict == "long" || verdict == "gyro") pending = 0 // handled, not knocked: drop the group
        }
        log?.invoke(
            "hop knock peak=${fmt(spikePeak)} dur=$dur gyro=${fmt(spikeGyro)} side=${sideOf(spikeHx, spikeHy, spikePeak)?.wire ?: "none"} " +
                "verdict=$verdict n=${if (ok) pending else 0}",
        )
        return ok
    }

    companion object {
        const val NONE = 0
        const val KNOCK = 1
        const val GROUP = 2

        // ---- Tuning (m/s², ms, rad/s). Tune on the phone with the `hop knock` debug lines; the levels are per phone (DeviceProfile). ----
        /** Baseline time constant: the high-pass keeps anything faster than this. */
        const val BASELINE_TAU_MS = 150f
        /** Face up and still: baseline z above this, and its sideways part below FLAT_TILT. */
        val FLAT_Z = DeviceProfile.CURRENT.sensors.knockFlatZ
        val FLAT_TILT = DeviceProfile.CURRENT.sensors.knockFlatTilt
        /** A spike starts above TRIGGER and ends below RELEASE (z, high-passed). */
        val TRIGGER = DeviceProfile.CURRENT.sensors.knockTrigger
        val RELEASE = DeviceProfile.CURRENT.sensors.knockRelease
        /** Its peak must reach PEAK_MIN. */
        val PEAK_MIN = DeviceProfile.CURRENT.sensors.knockPeakMin
        /** A knock is short; a pickup or a slide lasts longer. */
        const val MAX_DUR_MS = 60L
        /** A knock barely turns the phone. */
        val GYRO_MAX = DeviceProfile.CURRENT.sensors.knockGyroMax
        /** Calm needed before a knock: no sample above QUIET_LEVEL for QUIET_MS (rejects shaking and handling). */
        val QUIET_LEVEL = DeviceProfile.CURRENT.sensors.knockQuietLevel
        const val QUIET_MS = 150L
        /** The table rings after a knock: loud samples this long after it do not count as noise. */
        const val RING_MS = 150L
        const val DEBOUNCE_MS = 120L
        /** Knocks closer than this are one group. */
        const val GROUP_GAP_MS = 600L
        const val TOUCH_GUARD_MS = 250L
        const val MAX_COUNT = 5
        /** A side is named only when the sideways push is at least this share of the z peak. */
        const val SIDE_MIN_RATIO = 0.35f
        /** +1: a push towards +x means the knock came from the right; -1 flips it (check on the phone). */
        val SIDE_SIGN = DeviceProfile.CURRENT.sensors.knockSideSign

        fun sideOf(hx: Float, hy: Float, peakZ: Float): KnockSide? {
            if (hypot(hx, hy) < SIDE_MIN_RATIO * peakZ) return null
            return if (abs(hx) >= abs(hy)) {
                if (hx * SIDE_SIGN > 0) KnockSide.RIGHT else KnockSide.LEFT
            } else {
                if (hy * SIDE_SIGN > 0) KnockSide.TOP else KnockSide.BOTTOM
            }
        }

        private fun fmt(v: Float) = "%.2f".format(java.util.Locale.ROOT, v)
    }
}
