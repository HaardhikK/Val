package io.github.haardhikk.charm

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ExtrasTest {
    /** Feeds one reading per second, as the 1 Hz tick does, and collects what would be posted. */
    private fun run(l: LightHysteresis, vararg lux: Float, start: Long = 0): List<LightLevel> =
        lux.toList().mapIndexedNotNull { i, v -> l.update(v, start + i * 1000L) }

    @Test
    fun firstReadingReportsTheSettledLevel() {
        assertEquals(listOf(LightLevel.NORMAL), run(LightHysteresis(), 300f, 300f, 300f))
    }

    @Test
    fun darkNeedsTwoSecondsBelowTenLux() {
        val l = LightHysteresis()
        assertEquals(listOf(LightLevel.NORMAL, LightLevel.DARK), run(l, 300f, 5f, 5f, 5f))
    }

    @Test
    fun aShortDipIsIgnored() {
        assertEquals(listOf(LightLevel.NORMAL), run(LightHysteresis(), 300f, 5f, 300f, 5f, 300f))
    }

    @Test
    fun leavingDarkNeedsThirtyLux() {
        val l = LightHysteresis()
        run(l, 5f, 5f, 5f)
        assertEquals(LightLevel.DARK, l.level)
        assertEquals(emptyList<LightLevel>(), run(l, 20f, 20f, 20f, 20f, start = 10_000))
        assertEquals(listOf(LightLevel.NORMAL), run(l, 40f, 40f, 40f, start = 20_000))
    }

    @Test
    fun brightNeedsFiveThousandAndLeavesBelowThreeThousand() {
        val l = LightHysteresis()
        assertEquals(listOf(LightLevel.NORMAL, LightLevel.BRIGHT), run(l, 300f, 8000f, 8000f, 8000f))
        assertEquals(emptyList<LightLevel>(), run(l, 4000f, 4000f, 4000f, start = 10_000))
        assertEquals(listOf(LightLevel.NORMAL), run(l, 1000f, 1000f, 1000f, start = 20_000))
    }

    @Test
    fun resetReportsAgain() {
        val l = LightHysteresis()
        run(l, 300f)
        l.reset()
        assertEquals(listOf(LightLevel.NORMAL), run(l, 300f, start = 5000))
    }

    @Test
    fun proximityPostsOnlyOnFlips() {
        val p = ProximityState()
        assertEquals(false, p.update(false))
        assertNull(p.update(false))
        assertEquals(true, p.update(true))
        assertNull(p.update(true))
        assertEquals(false, p.update(false))
    }

    @Test
    fun proximityNearThreshold() {
        assertTrue(ProximityState.isNear(0f, 5f))
        assertFalse(ProximityState.isNear(5f, 5f))
        assertTrue(ProximityState.isNear(3f, 8f))
        assertFalse(ProximityState.isNear(8f, 8f))
    }

    @Test
    fun aBinarySensorWhoseFarValueIsUnderTheThresholdStillGoesFar() {
        // Reports only 0 (near) and 3 (far) with a 5 cm range: the plain threshold would read near forever.
        val p = ProximityState()
        assertEquals(true, p.reading(0f, 5f))
        assertEquals(false, p.reading(3f, 5f))
        assertEquals(true, p.reading(0f, 5f))
        assertEquals(false, p.reading(3f, 5f))
        // and the common 1 / 5 with a 5 cm range
        val q = ProximityState()
        assertEquals(false, q.reading(5f, 5f))
        assertEquals(true, q.reading(1f, 5f))
        assertEquals(false, q.reading(5f, 5f))
    }

    @Test
    fun aSensorReportingCentimetresUsesTheThreshold() {
        val p = ProximityState()
        assertEquals(false, p.reading(10f, 10f))
        assertEquals(true, p.reading(2f, 10f))
        assertNull(p.reading(4f, 10f)) // three values seen: centimetres, 4 < 5 is still near
        assertEquals(false, p.reading(7f, 10f))
    }

    @Test
    fun batteryPostsOnRealChangesOnly() {
        val b = BatteryState()
        assertEquals(BatteryReading(50, false, 30f), b.update(50, false, 30f))
        assertNull(b.update(50, false, 30.5f))
        assertEquals(BatteryReading(50, false, 31.2f), b.update(50, false, 31.2f))
        assertEquals(BatteryReading(49, false, 31.2f), b.update(49, false, 31.2f))
        assertEquals(BatteryReading(49, true, 31.2f), b.update(49, true, 31.2f))
    }

    @Test
    fun messagesMatchThePage() {
        val prox = ExtrasMessage.proximity(true)
        assertEquals("proximity", prox.getString("type"))
        assertTrue(prox.getBoolean("near"))
        val light = ExtrasMessage.light(LightLevel.DARK, 3.6f)
        assertEquals("dark", light.getString("level"))
        assertEquals(4, light.getInt("lux"))
        val bat = ExtrasMessage.battery(BatteryReading(15, false, 31.5f))
        assertEquals(15, bat.getInt("level"))
        assertFalse(bat.getBoolean("charging"))
        assertEquals(31.5, bat.getDouble("temp"), 1e-6)
    }
}
