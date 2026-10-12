package io.github.haardhikk.charm

/** What a volume-key shortcut asks the character to do. */
enum class ButtonAction(val wire: String) {
    BACK("back"), // one short press: close what is open (camera, map, metal detector)
    LOOK("look"), // two short presses: camera ("look at this")
    MAP("map"), // three short presses: the offline map
    METAL("metal"), // four or more short presses: the metal detector
    TALK_START("talkStart"), // held: push-to-talk begins
    TALK_END("talkEnd"), // released after a hold
}

/** What the mic should do with a press before it is known to be a hold. */
enum class MicCue {
    ARM, // key down: start recording a pre-roll, so a hold keeps the first word
    DROP, // the press was short (part of a press count): throw the pre-roll away
}

/**
 * Turns raw volume-down presses into shortcuts (volume-up is broken on the reference phone, so only volume-down is used).
 * Pure logic with times passed in, so it is unit-tested.
 * A press held for [holdMs] → TALK_START, its release → TALK_END. Short presses are counted until [gapMs] pass with
 * no new press (a worn key needs a forgiving gap), then 1 → BACK, 2 → LOOK, 3 → MAP, 4+ → METAL.
 * Every press also cues the mic: ARM on key-down, DROP on a short release (a hold keeps the pre-roll as its clip).
 */
class ButtonShortcuts(
    private val gapMs: Long = DeviceProfile.CURRENT.button.gapMs,
    private val holdMs: Long = DeviceProfile.CURRENT.button.holdMs,
    private val onMic: (MicCue) -> Unit = {},
    private val onAction: (ButtonAction) -> Unit,
) {
    private var pressedAt = -1L
    private var lastShortRelease = -1L
    private var shortPresses = 0
    private var talking = false

    fun down(nowMs: Long) {
        pressedAt = nowMs
        onMic(MicCue.ARM)
    }

    /** Call [holdMs] after a press (talking starts while the key is held) and [gapMs] after a release (counts end). */
    fun tick(nowMs: Long) {
        if (pressedAt >= 0 && !talking && nowMs - pressedAt >= holdMs) {
            talking = true
            shortPresses = 0
            onAction(ButtonAction.TALK_START)
            return
        }
        if (pressedAt < 0 && shortPresses > 0 && nowMs - lastShortRelease >= gapMs) {
            val n = shortPresses
            shortPresses = 0
            onAction(
                when (n) {
                    1 -> ButtonAction.BACK
                    2 -> ButtonAction.LOOK
                    3 -> ButtonAction.MAP
                    else -> ButtonAction.METAL
                },
            )
        }
    }

    fun up(nowMs: Long) {
        if (pressedAt < 0) return
        val held = nowMs - pressedAt
        pressedAt = -1
        if (talking || held >= holdMs) {
            if (!talking) onAction(ButtonAction.TALK_START) // the tick was missed: start and end together
            talking = false
            shortPresses = 0
            onAction(ButtonAction.TALK_END)
            return
        }
        onMic(MicCue.DROP)
        shortPresses++
        lastShortRelease = nowMs
    }
}
