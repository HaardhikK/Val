package io.github.haardhikk.charm

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceLevelTest {

    private fun tone(amplitude: Int, n: Int = 1600) = ShortArray(n) { if (it % 2 == 0) amplitude.toShort() else (-amplitude).toShort() }

    @Test
    fun silenceAndEmptyReadsAreZero() {
        assertEquals(0f, Voice.level(ShortArray(1600), 1600))
        assertEquals(0f, Voice.level(tone(1000), 0))
    }

    @Test
    fun fullScaleIsOne() {
        assertEquals(1f, Voice.level(tone(Short.MAX_VALUE.toInt()), 1600))
    }

    @Test
    fun louderIsHigherAndStaysInRange() {
        val hush = Voice.level(tone(30), 1600) // about -60 dBFS
        val talk = Voice.level(tone(3000), 1600) // about -21 dBFS
        assertEquals(0f, hush)
        assertTrue(talk in 0.5f..0.9f)
    }

    @Test
    fun onlyTheReadPartCounts() {
        val buf = tone(3000)
        for (i in 800 until 1600) buf[i] = 0
        assertEquals(Voice.level(tone(3000), 800), Voice.level(buf, 800))
    }
}
