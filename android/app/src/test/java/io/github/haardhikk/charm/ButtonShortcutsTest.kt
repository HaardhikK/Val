package io.github.haardhikk.charm

import org.junit.Assert.assertEquals
import org.junit.Test

class ButtonShortcutsTest {
    private val got = mutableListOf<ButtonAction>()
    private val b = ButtonShortcuts { got += it }

    private fun press(at: Long, holdFor: Long) {
        b.down(at)
        if (holdFor >= 350) b.tick(at + 350)
        b.up(at + holdFor)
    }

    /** The count ends once the key has been quiet for the gap. */
    private fun settle(at: Long) = b.tick(at)

    @Test
    fun onePressIsBack() {
        press(0, 80)
        settle(700)
        assertEquals(listOf(ButtonAction.BACK), got)
    }

    @Test
    fun twoPressesAreLook() {
        press(0, 80)
        press(450, 80) // a worn key: half a second between presses still counts
        settle(1200)
        assertEquals(listOf(ButtonAction.LOOK), got)
    }

    @Test
    fun threePressesAreMap() {
        press(0, 80)
        press(300, 80)
        press(600, 80)
        settle(1300)
        assertEquals(listOf(ButtonAction.MAP), got)
    }

    @Test
    fun fourPressesAreMetal() {
        press(0, 80)
        press(300, 80)
        press(600, 80)
        press(900, 80)
        settle(1600)
        assertEquals(listOf(ButtonAction.METAL), got)
    }

    @Test
    fun nothingFiresBeforeTheGap() {
        press(0, 80)
        press(300, 80)
        settle(500)
        assertEquals(emptyList<ButtonAction>(), got)
    }

    @Test
    fun pressesFarApartAreTwoBacks() {
        press(0, 80)
        settle(700)
        press(1500, 80)
        settle(2200)
        assertEquals(listOf(ButtonAction.BACK, ButtonAction.BACK), got)
    }

    @Test
    fun holdingTalksThenStops() {
        press(0, 1500)
        assertEquals(listOf(ButtonAction.TALK_START, ButtonAction.TALK_END), got)
    }

    @Test
    fun aHoldReleasedBeforeTheTickStillStartsAndEnds() {
        b.down(0)
        b.up(400)
        assertEquals(listOf(ButtonAction.TALK_START, ButtonAction.TALK_END), got)
    }

    @Test
    fun aHoldClearsEarlierShortPresses() {
        press(0, 80)
        press(200, 1000)
        settle(2000)
        assertEquals(listOf(ButtonAction.TALK_START, ButtonAction.TALK_END), got)
    }
}

/** The mic pre-roll: armed on every key-down, dropped on a short press, kept by a hold. */
class ButtonShortcutsMicTest {
    private val events = mutableListOf<String>()
    private val b = ButtonShortcuts(onMic = { events += it.name }) { events += it.wire }

    @Test
    fun shortPressArmsThenDropsAndNeverTalks() {
        b.down(0)
        b.up(120)
        b.tick(800)
        assertEquals(listOf("ARM", "DROP", "back"), events)
    }

    @Test
    fun holdKeepsThePreRoll() {
        b.down(0)
        b.tick(350)
        b.up(1500)
        assertEquals(listOf("ARM", "talkStart", "talkEnd"), events)
    }

    @Test
    fun holdWithAMissedTickStillKeepsThePreRoll() {
        b.down(0)
        b.up(900)
        assertEquals(listOf("ARM", "talkStart", "talkEnd"), events)
    }

    @Test
    fun everyPressOfACountDrops() {
        b.down(0)
        b.up(80)
        b.down(300)
        b.up(380)
        b.tick(1100)
        assertEquals(listOf("ARM", "DROP", "ARM", "DROP", "look"), events)
    }
}
