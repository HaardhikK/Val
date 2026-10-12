package io.github.haardhikk.charm

import android.speech.tts.TextToSpeech.Engine.KEY_FEATURE_EMBEDDED_SYNTHESIS
import android.speech.tts.TextToSpeech.Engine.KEY_FEATURE_NETWORK_SYNTHESIS
import android.speech.tts.TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SystemVoiceTest {

    private fun v(name: String, lang: String = "en", country: String = "US", network: Boolean = false, features: Set<String> = setOf(KEY_FEATURE_EMBEDDED_SYNTHESIS), quality: Int = 300, latency: Int = 300) =
        SystemVoices.Candidate(name, lang, country, network, features, quality, latency)

    @Test
    fun picksOnlyOfflineInstalledEnglish() {
        val voices = listOf(
            v("en-us-x-net", network = true, features = setOf(KEY_FEATURE_NETWORK_SYNTHESIS), quality = 500),
            v("en-us-x-missing", features = setOf(KEY_FEATURE_EMBEDDED_SYNTHESIS, KEY_FEATURE_NOT_INSTALLED), quality = 500),
            v("de-de-x-local", lang = "de", country = "DE", quality = 500),
            v("en-in-x-local", country = "IN", quality = 500),
            v("en-us-x-nofeature", features = emptySet(), quality = 500),
            v("en-gb-x-local"),
        )
        assertEquals("en-gb-x-local", SystemVoices.pick(voices)?.name)
    }

    @Test
    fun prefersUsThenQualityThenLatency() {
        val voices = listOf(
            v("en-gb-x-best", country = "GB", quality = 500),
            v("en-us-x-slow", quality = 400, latency = 400),
            v("en-us-x-fast", quality = 400, latency = 200),
            v("en-us-x-low", quality = 200, latency = 100),
        )
        assertEquals("en-us-x-fast", SystemVoices.pick(voices)?.name)
    }

    @Test
    fun noOfflineVoiceMeansNone() {
        assertNull(SystemVoices.pick(listOf(v("en-us-x-net", network = true))))
        assertNull(SystemVoices.pick(emptyList()))
    }

    @Test
    fun progressReportsFirstStartAndEachChunk() {
        val p = SpeechProgress("charm1", listOf("Hi! I'm Val.", "The Frauenkirche is in Dresden."), 1f)
        assertEquals("charm1-0", p.id(0))
        val a = p.started("charm1-0")!!
        assertTrue(a.first)
        assertEquals(0, a.index)
        assertEquals("Hi! I'm Val.", a.text)
        val b = p.started("charm1-1")!!
        assertFalse(b.first)
        assertEquals(1, b.index)
        assertEquals(p.totalMs, a.ms + b.ms)
        assertEquals(p.totalMs, p.playedMs)
    }

    @Test
    fun onlyTheLastChunkFinishes() {
        val p = SpeechProgress("charm2", listOf("one two three.", "four five six."), 1f)
        assertFalse(p.done("charm2-0"))
        assertTrue(p.done("charm2-1"))
    }

    @Test
    fun staleOrForeignIdsAreIgnored() {
        val p = SpeechProgress("charm3", listOf("one two three."), 1f)
        assertNull(p.started("charm2-0"))
        assertNull(p.started("charm31-0"))
        assertNull(p.started("charm3-5"))
        assertNull(p.started("charm3-x"))
        assertFalse(p.owns("charm30-0"))
        assertFalse(p.done("charm2-0"))
        assertEquals(0L, p.playedMs)
        assertTrue(p.owns("charm3-0"))
    }

    @Test
    fun fasterRateMeansShorterEstimates() {
        val slow = SpeechProgress("a", listOf("The Frauenkirche is a church in Dresden."), 1f)
        val fast = SpeechProgress("b", listOf("The Frauenkirche is a church in Dresden."), 2f)
        assertTrue(fast.totalMs < slow.totalMs)
        assertTrue(SpeechProgress("c", listOf("Hi."), 1f).totalMs >= SpeechProgress.MIN_CHUNK_MS)
    }

    @Test
    fun anInstalledLocalVoiceWithoutTheEmbeddedFlagCounts() {
        // As on the reference phone: en-us-x-tpf-local has only network-tuning features.
        val local = v("en-us-x-tpf-local", features = setOf("networkTimeoutMs", "networkRetriesCount"))
        val net = v("en-us-x-sfg-network", network = true, features = setOf("networkTimeoutMs"))
        assertEquals("en-us-x-tpf-local", SystemVoices.pick(listOf(net, local))?.name)
    }
}
