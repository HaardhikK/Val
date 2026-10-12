package io.github.haardhikk.charm

import java.io.File

/**
 * The speech-to-text models Val can use, each in its own folder under the phone's models folder (pushed by
 * scripts/prepare-phone.sh). Only one is loaded at a time. Moonshine base is the default; Moonshine tiny is the fast
 * fallback. The WHISPER_* engines are not pushed to the phone; they are kept for comparison (Whisper looped on real
 * clips).
 *
 * A swappable part: choose the engine in [DeviceProfile.Models.stt] and push its files to [dir] (scripts/prepare-phone.sh).
 * Moonshine tiny suits a weaker phone. Another Moonshine or Whisper model for sherpa-onnx is a new entry here (folder
 * and file names); a different model family also needs its config in Voice.kt.
 */
enum class SttEngine(val wire: String, val dir: String, val files: List<String>) {
    MOONSHINE("moonshine", "moonshine", listOf("encoder_model.ort", "decoder_model_merged.ort", "tokens.txt")),
    MOONSHINE_BASE("moonshine-base", "moonshine-base", listOf("encoder_model.ort", "decoder_model_merged.ort", "tokens.txt")),
    WHISPER_TINY("whisper-tiny", "whisper-tiny", listOf("tiny.en-encoder.int8.onnx", "tiny.en-decoder.int8.onnx", "tiny.en-tokens.txt")),
    WHISPER_BASE("whisper-base", "whisper-base", listOf("base.en-encoder.int8.onnx", "base.en-decoder.int8.onnx", "base.en-tokens.txt")),
    ;

    val whisper get() = this == WHISPER_TINY || this == WHISPER_BASE

    fun present(models: File) = files.all { File(File(models, dir), it).isFile }

    companion object {
        /** From [DeviceProfile] (a getter: the profile itself names an engine). Tiny is the fallback when its files are missing. */
        val DEFAULT: SttEngine get() = DeviceProfile.CURRENT.models.stt

        fun fromWire(s: String?): SttEngine? = entries.firstOrNull { it.wire == s }

        /** The engine to load: the wanted one if its files are there, else Moonshine if it is, else none. */
        fun pick(wanted: SttEngine, present: (SttEngine) -> Boolean): SttEngine? = when {
            present(wanted) -> wanted
            present(MOONSHINE) -> MOONSHINE
            else -> null
        }
    }
}
