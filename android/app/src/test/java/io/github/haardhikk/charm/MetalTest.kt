package io.github.haardhikk.charm

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MetalTest {

    /** Feeds a constant field at 50 Hz for [ms]; returns the last reading sent. */
    private fun MetalMeter.feed(x: Float, y: Float, z: Float, fromMs: Long, ms: Long, bias: Float = 0f): MetalReading? {
        var last: MetalReading? = null
        var t = fromMs
        while (t < fromMs + ms) {
            update(x + bias, y + bias, z + bias, bias, bias, bias, t)?.let { last = it }
            t += 20
        }
        return last
    }

    @Test
    fun magnitudeIsTheVectorLength() {
        assertEquals(5f, MetalMeter.magnitude(3f, 4f, 0f), 1e-5f)
        assertEquals(49f, MetalMeter.magnitude(0f, 0f, -49f), 1e-5f)
    }

    @Test
    fun hardIronBiasIsRemoved() {
        val m = MetalMeter()
        val r = m.feed(20f, 20f, 40f, 0, 2000, bias = 120f)!!
        assertEquals(MetalMeter.magnitude(20f, 20f, 40f), r.ut, 0.1f)
    }

    @Test
    fun aSteadyRoomSettlesToNoDelta() {
        val m = MetalMeter()
        val r = m.feed(0f, 30f, 45f, 0, 3000)!! // 54 µT room, not Dresden's 49
        assertEquals(54.08f, r.ut, 0.1f)
        assertTrue("delta ${r.delta}", r.delta < 1f)
    }

    @Test
    fun aMagnetShowsUpAndTheBaselineBarelyMoves() {
        val m = MetalMeter()
        m.feed(0f, 0f, 49f, 0, 3000)
        val near = m.feed(0f, 0f, 249f, 3000, 2000)!!
        assertEquals(200f, near.delta, 5f)
        assertEquals(49f, m.baseline, 2f)
        val gone = m.feed(0f, 0f, 49f, 5000, 1000)!!
        assertTrue("delta ${gone.delta}", gone.delta < 2f)
    }

    @Test
    fun aFieldWeakerThanTheBaselineShowsBrieflyThenTheBaselineFollowsDown() {
        // Metal almost always raises the field, so a baseline above the reading is stale: a dip shows for a moment,
        // then the baseline catches up within seconds.
        val m = MetalMeter()
        m.feed(0f, 0f, 49f, 0, 3000)
        assertTrue(m.feed(0f, 0f, 29f, 3000, 300)!!.delta > 15f)
        val later = m.feed(0f, 0f, 29f, 3300, 10_000)!!
        assertTrue("delta ${later.delta}", later.delta < 2f)
    }

    /** Feeds an uncalibrated reading with a per-axis bias on x only. */
    private fun MetalMeter.feedX(x: Float, bx: Float, fromMs: Long, ms: Long): MetalReading? {
        var last: MetalReading? = null
        var t = fromMs
        while (t < fromMs + ms) {
            update(x + bx, 0f, 0f, bx, 0f, 0f, t)?.let { last = it }
            t += 20
        }
        return last
    }

    @Test
    fun heldNearMetalDuringABiasJumpThenMovedAway() {
        val m = MetalMeter()
        m.feedX(49f, 0f, 0, 3000)
        // the bias estimate changes while the phone lies on a steel table (120 µT)
        val onSteel = m.feedX(120f, 40f, 3000, 2000)!!
        assertTrue("metal still shows: ${onSteel.delta}", onSteel.delta > 50f)
        assertEquals(MetalMeter.EARTH_UT, m.baseline, 5f)
        val away = m.feedX(49f, 40f, 5000, 10_000)!!
        assertTrue("delta ${away.delta}", away.delta < 12f)
    }

    @Test
    fun aBiasJumpToAPlausibleFieldStartsOverFromIt() {
        val m = MetalMeter()
        m.feedX(49f, 0f, 0, 3000)
        val r = m.feedX(38f, 30f, 3000, 2000)!!
        assertTrue("delta ${r.delta}", r.delta < 2f)
        assertEquals(38f, m.baseline, 1f)
    }

    @Test
    fun openedNextToALaptopThenMovedAway() {
        val m = MetalMeter()
        m.feed(0f, 0f, 95f, 0, 3000) // the warm-up settles on the laptop's field
        val away = m.feed(0f, 0f, 49f, 3000, 10_000)!!
        assertTrue("delta ${away.delta}", away.delta < 12f)
        // and metal near the phone still shows afterwards
        assertTrue(m.feed(0f, 0f, 120f, 13_000, 1000)!!.delta > 50f)
    }

    @Test
    fun theCalibratedSensorShiftingItsOffsetSilentlyRecovers() {
        // The calibrated fallback reports no bias; the OS can re-calibrate and shift the reading without notice.
        val m = MetalMeter()
        m.feed(0f, 0f, 70f, 0, 3000) // settled on a badly calibrated 70 µT
        val shifted = m.feed(0f, 0f, 45f, 3000, 10_000)!! // the OS fixes its calibration
        assertTrue("delta ${shifted.delta}", shifted.delta < 12f)
    }

    @Test
    fun readingsAreSentAtMostTenTimesASecond() {
        val m = MetalMeter()
        var sent = 0
        for (t in 0L until 1000L step 20) if (m.update(0f, 0f, 49f, 0f, 0f, 0f, t) != null) sent++
        assertEquals(10, sent)
    }

    @Test
    fun resetStartsAgainFromTheEarthField() {
        val m = MetalMeter()
        m.feed(0f, 0f, 80f, 0, 3000)
        m.reset()
        assertEquals(MetalMeter.EARTH_UT, m.baseline, 0f)
        assertNotNull(m.update(0f, 0f, 49f, 0f, 0f, 0f, 0))
        assertNull(m.update(Float.NaN, 0f, 0f, 0f, 0f, 0f, 200))
    }

    @Test
    fun aLateBiasEstimateDoesNotLeaveTheBarFull() {
        // As on the phone: the first readings come before the bias is known (≈316 µT), then the bias arrives (36 µT).
        val m = MetalMeter()
        var t = 0L
        var r: MetalReading? = null
        repeat(20) { r = m.update(316f, 0f, 0f, 0f, 0f, 0f, t).also { t += 100 } ?: r }
        repeat(40) { r = m.update(316f, 0f, 0f, 280f, 0f, 0f, t).also { t += 100 } ?: r }
        assertTrue("delta ${r!!.delta}", r!!.delta < 5f)
        // and a magnet still shows up
        repeat(10) { r = m.update(436f, 0f, 0f, 280f, 0f, 0f, t).also { t += 100 } ?: r }
        assertTrue("delta ${r!!.delta}", r!!.delta > 80f)
    }
}
