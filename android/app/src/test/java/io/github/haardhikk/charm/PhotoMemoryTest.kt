package io.github.haardhikk.charm

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PhotoMemoryTest {

    @Test
    fun theCaptionIsContextForTwoMinutes() {
        val m = PhotoMemory()
        assertNull(m.caption(0))
        m.remember("It looks like a mug.", "AAAA", 1_000)
        assertEquals("It looks like a mug.", m.caption(1_000 + PhotoMemory.CONTEXT_MS))
        assertNull(m.caption(1_001 + PhotoMemory.CONTEXT_MS))
    }

    @Test
    fun theFrameIsAskedOnlyWhileThePolaroidShowsAndIsDroppedLater() {
        val m = PhotoMemory()
        m.remember("It looks like a mug.", "AAAA", 0)
        assertNull(m.frame(10)) // not on screen yet
        m.showing(true)
        assertEquals("AAAA", m.frame(10))
        m.expire(PhotoMemory.FRAME_MS + 1)
        assertNull(m.frame(PhotoMemory.FRAME_MS + 1))
        assertNull(m.frame(20)) // dropped for good, not just hidden
    }

    @Test
    fun closingThePolaroidDropsTheFrameButKeepsTheCaption() {
        val m = PhotoMemory()
        m.remember("It looks like a mug.", "AAAA", 0)
        m.showing(true)
        m.showing(false)
        m.showing(true)
        assertNull(m.frame(10))
        assertEquals("It looks like a mug.", m.caption(10))
    }
}
