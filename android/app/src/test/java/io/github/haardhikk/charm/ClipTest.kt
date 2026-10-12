package io.github.haardhikk.charm

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.sin

class ClipTest {
    private val rate = 16000

    private fun noise(n: Int, amp: Float, seed: Int = 1): FloatArray {
        val r = java.util.Random(seed.toLong())
        return FloatArray(n) { (r.nextFloat() * 2 - 1) * amp }
    }

    private fun tone(n: Int, amp: Float) = FloatArray(n) { (sin(2 * PI * 300 * it / rate) * amp).toFloat() }

    @Test
    fun bufferKeepsEverySampleInOrderUpToTheCap() {
        val b = ClipBuffer(max = 5)
        b.append(shortArrayOf(16384, -16384, 0), 3)
        b.append(shortArrayOf(1, 2, 3, 4), 4) // only 2 fit
        assertTrue(b.full)
        assertEquals(5, b.size)
        assertArrayEquals(floatArrayOf(0.5f, -0.5f, 0f, 1 / 32768f, 2 / 32768f), b.toArray(), 1e-7f)
    }

    @Test
    fun bufferUsesOnlyTheReadPartOfTheArray() {
        val b = ClipBuffer(max = 100)
        b.append(shortArrayOf(100, 200, 300), 1)
        assertEquals(1, b.size)
    }

    @Test
    fun trimCutsNoiseAroundSpeechAndKeeps200MsMargins() {
        val lead = noise(rate, 0.01f) // 1 s of hall noise
        val speech = tone(rate, 0.5f) // 1 s of "speech"
        val tail = noise(rate, 0.01f, seed = 2)
        val out = Clip.trim(lead + speech + tail, rate)
        val margin = rate / 5
        assertEquals((speech.size + 2 * margin).toFloat(), out.size.toFloat(), rate / 50f) // within one 20 ms frame
    }

    @Test
    fun trimLeavesAllNoiseOrShortClipsAlone() {
        val flat = noise(2 * rate, 0.02f)
        assertSame(flat, Clip.trim(flat, rate))
        val short = tone(rate / 4, 0.5f)
        assertSame(short, Clip.trim(short, rate))
    }

    @Test
    fun trimNeverCutsAQuietClipToNothing() {
        val quiet = noise(2 * rate, 0.0001f) // under -50 dBFS everywhere
        assertSame(quiet, Clip.trim(quiet, rate))
    }

    @Test
    fun normalizeSetsThePeakToMinus3Db() {
        val out = Clip.normalize(tone(1000, 0.1f))
        val peak = out.maxOf { abs(it) }
        assertEquals(-3.0, Clip.db(peak.toDouble()), 0.05)
    }

    @Test
    fun normalizeCapsTheBoostAndHandlesSilence() {
        val out = Clip.normalize(floatArrayOf(0.001f, -0.001f), maxGainDb = 20.0)
        assertEquals(0.01f, out[0], 1e-6f)
        assertArrayEquals(floatArrayOf(0f, 0f), Clip.normalize(floatArrayOf(0f, 0f)), 0f)
    }

    @Test
    fun statsReportPeakRmsAndLength() {
        val s = Clip.stats(FloatArray(8000) { 0.5f }, rate)
        assertEquals(-6.02, s.peakDb, 0.01)
        assertEquals(-6.02, s.rmsDb, 0.01)
        assertEquals(500, s.ms)
        assertEquals(-120.0, Clip.stats(FloatArray(10), rate).peakDb, 0.0)
    }

    @Test
    fun wavRoundTrips() {
        val s = floatArrayOf(0f, 0.5f, -0.5f, 0.999f)
        val b = Clip.wav(s, rate)
        assertEquals(44 + 8, b.size)
        val (back, r) = Clip.unwav(b)!!
        assertEquals(rate, r)
        assertArrayEquals(s, back, 1 / 16000f)
        assertNull(Clip.unwav(ByteArray(50)))
    }

    @Test
    fun wavClampsOverload() {
        val (back, _) = Clip.unwav(Clip.wav(floatArrayOf(2f, -2f), rate))!!
        assertEquals(32767 / 32768f, back[0], 1e-6f)
        assertEquals(-32767 / 32768f, back[1], 1e-6f)
    }

    @Test
    fun ringFillsGapsThenOverwritesTheOldest() {
        assertEquals(0, Clip.ringSlot(List(10) { null }))
        assertEquals(2, Clip.ringSlot(listOf(5L, 6L, null, 7L)))
        assertEquals(1, Clip.ringSlot(listOf(9L, 3L, 4L)))
    }

    @Test
    fun heardDropsWhisperNoiseTags() {
        assertEquals("set a timer", Clip.cleanHeard(" [BLANK_AUDIO] set a timer (crowd chatter) *music*", 2.0))
        assertEquals("", Clip.cleanHeard("[BLANK_AUDIO]", 1.0))
    }

    @Test
    fun heardIsCappedToTheClipLength() {
        val loop = List(40) { "thank you" }.joinToString(" ")
        assertEquals("thank you", Clip.cleanHeard(loop, 1.0)) // a loop collapses to one copy
        val long = (1..40).joinToString(" ") { "w$it" }
        assertEquals((1.0 * 4.5).toInt() + 3, Clip.cleanHeard(long, 1.0).split(' ').size) // still capped to the clip
        assertEquals("dance for me", Clip.cleanHeard("dance for me", 1.0))
    }

    @Test
    fun loopsFromTheSpeechModelCollapse() {
        fun c(t: String) = Clip.collapseLoops(t.split(' ')).joinToString(" ")
        assertEquals("How", c("How How How How How How"))
        assertEquals("How far is the station", c("How far is the station"))
        assertEquals("how far", c("how far how far how far how far"))
        assertEquals("Where am I", c("Where Where Where am I"))
    }
}
