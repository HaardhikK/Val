package io.github.haardhikk.charm

import android.os.VibrationEffect
import org.json.JSONObject

/** Encodes one motion sample for the character page (see web/src/bridge.ts). */
object MotionMessage {
    fun encode(tMs: Long, gravity: FloatArray, linear: FloatArray, gyro: FloatArray): String =
        "{\"type\":\"motion\",\"t\":$tMs,\"g\":${vec(gravity)},\"a\":${vec(linear)},\"w\":${vec(gyro)}}"

    private fun vec(v: FloatArray) = "[%.3f,%.3f,%.3f]".format(java.util.Locale.ROOT, v[0], v[1], v[2])
}

/** Longest reply the page may ask Val to speak (keeps a page bug from hogging the voice). */
const val MAX_SAY = 300

/** Longest prompt the page may send with a photo. */
const val MAX_PROMPT = 200

/** Largest photo the page may send: base64 of a ≤512 px JPEG is ~30–150 kB; anything far bigger is a page bug. */
const val MAX_IMAGE_B64 = 600_000

/** Asked when the page sends no prompt; the page usually sends its own. */
const val DEFAULT_PROMPT = "What is the main thing in this photo? Answer in one short sentence that starts with \"It looks like\"."

private val BASE64 = Regex("^[A-Za-z0-9+/]+={0,2}$")

/** What the character page asks the app to do. */
sealed interface PageEvent {
    data class Haptic(val pattern: HapticPattern) : PageEvent
    data class Screen(val sleep: Boolean) : PageEvent
    data class Log(val text: String) : PageEvent
    /** Val speaks [text]; [reply]: it answers what the user just said (it goes into ConversationMemory), not a spontaneous line. */
    data class Say(val text: String, val reply: Boolean = false) : PageEvent
    /** Val answered with text only (voice off): remembered like a spoken reply, nothing is spoken. */
    data class Said(val text: String) : PageEvent
    /** The map opened (GPS on) or closed (GPS off). */
    data class Gps(val on: Boolean) : PageEvent
    /** The metal detector mode opened (magnetometer on) or closed (off). */
    data class Metal(val on: Boolean) : PageEvent
    /** "What is this?": a base64 JPEG (no data-URL prefix) and a question about it; [id] is echoed in the reply. */
    data class Describe(val id: Int, val image: String, val prompt: String) : PageEvent
    /** The Polaroid with a photo's answer is on screen (true), or the camera moved on or closed (false). */
    data class Polaroid(val on: Boolean) : PageEvent

    companion object {
        fun parse(raw: String): PageEvent? {
            val json = runCatching { JSONObject(raw) }.getOrNull() ?: return null
            return when (json.optString("type")) {
                "haptic" -> HapticPattern.from(json.optString("pattern"))?.let { Haptic(it) }
                "screen" -> Screen(sleep = json.optString("mode") == "sleep")
                "gesture" -> Log("gesture ${json.optString("name")}")
                "fps" -> Log("fps ${json.optInt("value")}")
                "say" -> json.optString("text").take(MAX_SAY).takeIf { it.isNotBlank() }?.let { Say(it, json.optBoolean("reply")) }
                "said" -> json.optString("text").take(MAX_SAY).takeIf { it.isNotBlank() }?.let { Said(it) }
                "gps" -> Gps(json.optBoolean("on"))
                "metal" -> Metal(json.optBoolean("on"))
                "describe" -> describe(json)
                "polaroid" -> Polaroid(json.optBoolean("on"))
                else -> null
            }
        }

        private fun describe(json: JSONObject): Describe? {
            val image = json.optString("image")
            if (image.length !in 100..MAX_IMAGE_B64 || !BASE64.matches(image)) return null
            val prompt = json.optString("prompt").trim().take(MAX_PROMPT).ifBlank { DEFAULT_PROMPT }
            return Describe(json.optInt("id", 0), image, prompt)
        }
    }
}

/** Vision answers for the page (see web/src/camera/logic.ts). */
object VisionMessage {
    fun encode(id: Int, reply: VisionReply): String = when (reply) {
        is VisionReply.Text -> JSONObject().put("type", "vision").put("id", id).put("text", reply.text).put("ms", reply.ms)
        is VisionReply.Failed -> JSONObject().put("type", "visionError").put("id", id).put("reason", reply.reason)
    }.toString()
}

/** Haptic patterns: short, distinct buzzes per reaction. */
enum class HapticPattern(private val timings: LongArray, private val amplitudes: IntArray) {
    TICK(longArrayOf(0, 12), intArrayOf(0, 90)),
    BUMP(longArrayOf(0, 35), intArrayOf(0, 200)),
    GIGGLE(longArrayOf(0, 15, 50, 15, 50, 15), intArrayOf(0, 120, 0, 120, 0, 120)),
    TUMBLE(longArrayOf(0, 60, 40, 120), intArrayOf(0, 220, 0, 160)),
    SHUTTER(longArrayOf(0, 20), intArrayOf(0, 170));

    fun effect(): VibrationEffect = VibrationEffect.createWaveform(timings, amplitudes, -1)

    /** Total buzz length in ms (for tests and logs). */
    val durationMs: Long get() = timings.sum()

    companion object {
        fun from(name: String): HapticPattern? = entries.firstOrNull { it.name.equals(name, ignoreCase = true) }
    }
}
