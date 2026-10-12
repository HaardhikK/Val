package io.github.haardhikk.charm

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.sin

class KnockTest {
    /** A synthetic 500 Hz accelerometer trace: flat face up with a little sensor noise, plus whatever [extra] adds. */
    private class Trace(val ms: Long) {
        val x = FloatArray((ms / STEP).toInt())
        val y = FloatArray(x.size)
        val z = FloatArray(x.size) { 9.81f }
        val gyro = FloatArray(x.size) { 0.02f }

        init {
            for (i in x.indices) { // deterministic noise, ±0.05 m/s²
                x[i] += 0.05f * sin(i * 1.7f)
                y[i] += 0.05f * sin(i * 2.3f)
                z[i] += 0.05f * sin(i * 3.1f)
            }
        }

        /** A table knock at [atMs]: a ringing z jolt of [amp] that dies out in ~25 ms, with a sideways push. */
        fun knock(atMs: Long, amp: Float = 4f, sx: Float = 0f, sy: Float = 0f) = apply {
            for (k in 0 until (40 / STEP).toInt()) {
                val i = (atMs / STEP).toInt() + k
                if (i >= z.size) break
                val t = k * STEP.toFloat()
                val ring = amp * exp(-t / 6f) * cos(2 * PI.toFloat() * t / 10f)
                z[i] += ring
                x[i] += ring * sx
                y[i] += ring * sy
            }
        }

        /** Something long: a [ms]-long push of [amp] in z (a phone being lifted or slid), with [turn] rad/s of gyro. */
        fun push(atMs: Long, ms: Long, amp: Float, turn: Float = 0f) = apply {
            for (k in 0 until (ms / STEP).toInt()) {
                val i = (atMs / STEP).toInt() + k
                if (i >= z.size) break
                z[i] += amp * sin(PI.toFloat() * k * STEP / ms)
                gyro[i] = turn
            }
        }
    }

    private data class Out(val kind: Int, val n: Int, val side: KnockSide?, val t: Long)

    private fun run(tr: Trace, d: KnockDetector = KnockDetector(), touchAt: Long? = null, muteUntil: Long? = null): List<Out> {
        touchAt?.let(d::touched)
        muteUntil?.let(d::mute)
        val out = mutableListOf<Out>()
        for (i in tr.x.indices) {
            val t = i * STEP
            val r = d.push(t, tr.x[i], tr.y[i], tr.z[i], tr.gyro[i])
            if (r != KnockDetector.NONE) out += Out(r, d.count, d.side, t)
        }
        return out
    }

    private fun groups(o: List<Out>) = o.filter { it.kind == KnockDetector.GROUP }.map { it.n }
    private fun knocks(o: List<Out>) = o.filter { it.kind == KnockDetector.KNOCK }.map { it.n }

    @Test
    fun stillPhoneFiresNothing() = assertEquals(emptyList<Out>(), run(Trace(3000)))

    @Test
    fun oneKnockIsOneGroupOfOne() {
        val o = run(Trace(2500).knock(1000))
        assertEquals(listOf(1), knocks(o))
        assertEquals(listOf(1), groups(o))
        val g = o.first { it.kind == KnockDetector.GROUP }
        assertTrue("group closes after the gap", g.t in 1600..1700)
    }

    @Test
    fun twoAndThreeKnocksAreCounted() {
        assertEquals(listOf(2), groups(run(Trace(3000).knock(1000).knock(1350))))
        assertEquals(listOf(1, 2, 3), knocks(run(Trace(3000).knock(1000).knock(1300).knock(1600))))
        assertEquals(listOf(3), groups(run(Trace(3000).knock(1000).knock(1300).knock(1600))))
    }

    @Test
    fun knocksFarApartAreSeparateGroups() {
        assertEquals(listOf(1, 1), groups(run(Trace(4000).knock(1000).knock(2400))))
    }

    @Test
    fun aKnockTooSoonAfterStartIsNotCounted() {
        // The detector needs QUIET_MS of calm first.
        assertEquals(emptyList<Int>(), knocks(run(Trace(1000).knock(50))))
    }

    @Test
    fun weakTapsAreIgnored() = assertEquals(emptyList<Int>(), knocks(run(Trace(2500).knock(1000, amp = 1.0f))))

    @Test
    fun aLongPushIsNotAKnock() = assertEquals(emptyList<Int>(), knocks(run(Trace(3000).push(1000, 200, 3f))))

    @Test
    fun aJoltWithRotationIsAPickupNotAKnock() {
        val tr = Trace(2500).knock(1000)
        for (i in (1000 / STEP).toInt() until (1040 / STEP).toInt()) tr.gyro[i] = 2f
        assertEquals(emptyList<Int>(), knocks(run(tr)))
    }

    @Test
    fun aKnockRightAfterShakingIsIgnored() {
        val tr = Trace(2500).push(800, 150, 2f).knock(1000) // still moving 50 ms before the spike
        assertEquals(emptyList<Int>(), knocks(run(tr)))
    }

    @Test
    fun aScreenTouchMasksTheJoltItMakes() {
        assertEquals(emptyList<Int>(), knocks(run(Trace(2500).knock(1000), touchAt = 900)))
        assertEquals(listOf(1), knocks(run(Trace(2500).knock(1000), touchAt = 600))) // long enough ago
    }

    @Test
    fun ourOwnVibrationIsMuted() = assertEquals(emptyList<Int>(), knocks(run(Trace(2500).knock(1000), muteUntil = 1100)))

    @Test
    fun aPhoneOnItsSideNeverKnocks() {
        val tr = Trace(2500).knock(1000)
        for (i in tr.z.indices) { tr.z[i] -= 9.81f; tr.y[i] += 9.81f } // upright: gravity on y
        assertEquals(emptyList<Int>(), knocks(run(tr)))
    }

    @Test
    fun tableRingingDoesNotDoubleCount() {
        // A long-ringing knock (dies out in ~40 ms with re-crossings) still counts once.
        assertEquals(listOf(1), knocks(run(Trace(2500).knock(1000, amp = 8f))))
    }

    @Test
    fun sideFollowsTheSidewaysPush() {
        assertNull(run(Trace(2500).knock(1000)).first().side)
        // SIDE_SIGN = -1: a push towards +x means the knock came from the left.
        assertEquals(KnockSide.LEFT, run(Trace(2500).knock(1000, sx = 0.6f)).first().side)
        assertEquals(KnockSide.RIGHT, run(Trace(2500).knock(1000, sx = -0.6f)).first().side)
        assertEquals(KnockSide.BOTTOM, run(Trace(2500).knock(1000, sy = 0.6f)).first().side)
    }

    @Test
    fun resetForgetsAPendingGroup() {
        val d = KnockDetector()
        val tr = Trace(1300).knock(1000)
        assertEquals(listOf(1), knocks(run(tr, d)))
        d.reset()
        assertEquals(emptyList<Int>(), groups(run(Trace(1000), d)))
    }

    @Test
    fun everyCandidateIsLoggedWithItsVerdict() {
        val lines = mutableListOf<String>()
        run(Trace(2500).knock(1000), KnockDetector { lines += it })
        assertEquals(1, lines.size)
        assertTrue(lines[0], lines[0].startsWith("hop knock peak=") && lines[0].contains("verdict=ok n=1"))
    }

    private companion object {
        const val STEP = 2L // ms: 500 Hz, about what SENSOR_DELAY_FASTEST gives
    }
}
