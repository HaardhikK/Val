package io.github.haardhikk.charm

import android.view.KeyEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

/** The default profile carries the values the Realme 3 Pro was tuned with; moving them must not change them. */
class DeviceProfileTest {
    private val p = DeviceProfile.REALME_3_PRO

    @Test
    fun theAppRunsWithTheRealmeProfile() = assertSame(p, DeviceProfile.CURRENT)

    @Test
    fun servers() {
        val s = p.servers
        assertEquals(listOf(2, 2, 4096, 2, 256, 8), listOf(s.llmThreads, s.llmHttpThreads, s.llmContextTokens, s.llmSlots, s.llmImageMaxTokens, s.llmNice))
        assertEquals(listOf(40_000L, 600_000L, 60_000L), listOf(s.llmStartTimeoutMs, s.llmIdleStopMs, s.photoBudgetMs))
        assertEquals(listOf(15_000, 20_000, 4000), listOf(s.chatReadMs, s.chatReadMs1_2b, s.needleReadTimeoutMs))
        assertEquals(listOf(2, 2, 2), listOf(s.needleThreads, s.sttThreads, s.ttsThreads))
        assertEquals(10_000L, s.needleStartWaitMs)
    }

    @Test
    fun models() {
        assertEquals(SttEngine.MOONSHINE_BASE, SttEngine.DEFAULT)
        assertEquals("vlm/LFM2.5-VL-450M-Q4_K_M.gguf", ServerModel.VISION.model)
        assertEquals("vlm/mmproj-LFM2.5-VL-450m-Q8_0.gguf", ServerModel.VISION.mmproj)
        assertEquals("llm/LFM2.5-1.2B-Instruct-Q4_K_M.gguf", ServerModel.TEXT_1_2B.model)
        assertEquals(listOf(15_000, 20_000), listOf(ServerModel.VISION.chatReadMs, ServerModel.TEXT_1_2B.chatReadMs))
    }

    @Test
    fun buttonAndSensors() {
        assertEquals(DeviceProfile.Button(KeyEvent.KEYCODE_VOLUME_DOWN, 350, 600), p.button)
        assertEquals(listOf(9.0f, 2.5f, 0.8f, 0.4f, 1.5f, 0.5f, 0.6f, -1f), listOf(KnockDetector.FLAT_Z, KnockDetector.FLAT_TILT, KnockDetector.TRIGGER, KnockDetector.RELEASE, KnockDetector.PEAK_MIN, KnockDetector.GYRO_MAX, KnockDetector.QUIET_LEVEL, KnockDetector.SIDE_SIGN))
        assertEquals(listOf(9.0f, 8.5f), listOf(p.sensors.knockListenOnZ, p.sensors.knockListenOffZ))
        assertEquals(listOf(10f, 30f, 5000f, 3000f), listOf(LightHysteresis.DARK_ENTER, LightHysteresis.DARK_EXIT, LightHysteresis.BRIGHT_ENTER, LightHysteresis.BRIGHT_EXIT))
        assertEquals(5f, p.sensors.proximityNearCm)
        assertEquals(49f, MetalMeter.EARTH_UT)
    }
}
