package io.github.haardhikk.charm

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files

class BrainTest {

    @Test
    fun prefersTheFineTunedNeedleWhenPushed() {
        val models = Files.createTempDirectory("models").toFile()
        val needle = models.resolve("needle").apply { mkdirs() }
        needle.resolve("needle3.cact").writeText("base")
        assertEquals("needle3.cact", Brain.modelFile(models).name)
        needle.resolve("needle3-val.cact").writeText("tuned")
        assertEquals("needle3-val.cact", Brain.modelFile(models).name)
        models.deleteRecursively()
    }

    @Test
    fun restartsAreSpacedThirtySecondsApart() {
        val gate = RestartGate(30_000)
        assertTrue("the first start is always allowed", gate.allows(1_000))
        gate.record(1_000)
        assertFalse("a crash right after start does not respawn", gate.allows(5_000))
        assertFalse(gate.allows(30_999))
        assertTrue(gate.allows(31_000))
        gate.record(31_000)
        assertFalse(gate.allows(40_000))
    }
}
