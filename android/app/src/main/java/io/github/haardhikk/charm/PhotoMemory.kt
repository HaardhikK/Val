package io.github.haardhikk.charm

/**
 * The last photo, in memory only (never on disk), so follow-up questions can use it:
 * - its caption (the vision model's words) goes to chat as context for [CONTEXT_MS];
 * - its JPEG stays for [FRAME_MS] while the Polaroid shows, so "what is it made of?" asks the same frame again.
 * Times are uptime milliseconds passed in by the caller (pure, unit-tested). Thread-safe.
 */
class PhotoMemory {
    private var caption: String? = null
    private var captionAt = 0L
    private var frame: String? = null
    private var frameAt = 0L
    private var polaroid = false

    @Synchronized
    fun remember(caption: String, jpegBase64: String, now: Long) {
        this.caption = caption
        captionAt = now
        frame = jpegBase64
        frameAt = now
    }

    /** The page shows the Polaroid with this photo's answer (true) or the camera moved on or closed (false). */
    @Synchronized
    fun showing(on: Boolean) {
        polaroid = on
        if (!on) frame = null // only asked again while it is on screen
    }

    /** The caption while it is fresh enough to be what "it" means, else null. */
    @Synchronized
    fun caption(now: Long): String? = caption?.takeIf { now - captionAt in 0..CONTEXT_MS }

    /** The JPEG to ask again, only while the Polaroid shows and for [FRAME_MS]; dropped once too old. */
    @Synchronized
    fun frame(now: Long): String? {
        if (frame != null && now - frameAt !in 0..FRAME_MS) frame = null
        return frame?.takeIf { polaroid }
    }

    /** Drops an expired frame (called on a timer, so an unused JPEG never lingers). */
    @Synchronized
    fun expire(now: Long) {
        frame(now)
    }

    companion object {
        const val CONTEXT_MS = 2 * 60_000L
        const val FRAME_MS = 2 * 60_000L
    }
}
