package io.github.haardhikk.charm

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.nio.file.Files

class SttEngineTest {
    @Test
    fun wireNamesMatchTheDebugExtra() {
        assertEquals(SttEngine.MOONSHINE, SttEngine.fromWire("moonshine"))
        assertEquals(SttEngine.WHISPER_TINY, SttEngine.fromWire("whisper-tiny"))
        assertEquals(SttEngine.WHISPER_BASE, SttEngine.fromWire("whisper-base"))
        assertNull(SttEngine.fromWire("whisper-large"))
        assertNull(SttEngine.fromWire(null))
    }

    @Test
    fun moonshineBaseIsTheDefault() = assertEquals(SttEngine.MOONSHINE_BASE, SttEngine.DEFAULT)

    @Test
    fun pickFallsBackToMoonshineThenNothing() {
        assertEquals(SttEngine.WHISPER_BASE, SttEngine.pick(SttEngine.WHISPER_BASE) { true })
        assertEquals(SttEngine.MOONSHINE, SttEngine.pick(SttEngine.WHISPER_BASE) { it == SttEngine.MOONSHINE })
        assertNull(SttEngine.pick(SttEngine.WHISPER_TINY) { false })
    }

    @Test
    fun presentNeedsEveryFile() {
        val models = Files.createTempDirectory("models").toFile()
        val d = java.io.File(models, "whisper-tiny").apply { mkdirs() }
        SttEngine.WHISPER_TINY.files.dropLast(1).forEach { java.io.File(d, it).writeText("x") }
        assertEquals(false, SttEngine.WHISPER_TINY.present(models))
        java.io.File(d, SttEngine.WHISPER_TINY.files.last()).writeText("x")
        assertEquals(true, SttEngine.WHISPER_TINY.present(models))
        models.deleteRecursively()
    }
}
