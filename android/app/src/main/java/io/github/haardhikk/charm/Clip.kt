package io.github.haardhikk.charm

import java.io.File
import kotlin.math.log10
import kotlin.math.sqrt

/**
 * Pure audio helpers for the ears (unit-tested): the growing mic buffer, clip loudness, the noise trim and peak
 * normalisation that run before speech-to-text, the WAV format of the debug clip ring, and the clean-up of what a
 * model heard. Samples are mono floats in -1..1.
 */
object Clip {
    /** Loudness of a clip: peak and RMS in dBFS (-120 for silence) and its length. */
    data class Stats(val peakDb: Double, val rmsDb: Double, val ms: Long)

    fun stats(s: FloatArray, rate: Int): Stats {
        var peak = 0f
        var sum = 0.0
        for (v in s) {
            val a = kotlin.math.abs(v)
            if (a > peak) peak = a
            sum += v.toDouble() * v
        }
        val rms = if (s.isEmpty()) 0.0 else sqrt(sum / s.size)
        return Stats(db(peak.toDouble()), db(rms), s.size * 1000L / rate)
    }

    fun db(v: Double) = if (v <= 1e-6) -120.0 else 20 * log10(v)

    /**
     * Cut leading and trailing noise-only audio, keeping [marginMs] around the speech. A frame counts as speech when
     * its RMS is [overFloorDb] above the clip's quiet floor (its 10th-percentile frame) and above an absolute
     * [minDb]. When nothing qualifies, or the clip is too short to judge, the clip is returned unchanged: never
     * drop audio that might be speech.
     */
    fun trim(s: FloatArray, rate: Int, marginMs: Int = 200, overFloorDb: Double = 10.0, minDb: Double = -50.0): FloatArray {
        val frame = rate / 50 // 20 ms analysis frames
        val frames = s.size / frame
        if (frames < 30) return s // under 0.6 s: nothing worth trimming
        val rms = DoubleArray(frames) { f ->
            var sum = 0.0
            for (i in f * frame until (f + 1) * frame) sum += s[i].toDouble() * s[i]
            sqrt(sum / frame)
        }
        val floor = rms.sorted()[frames / 10]
        val gate = maxOf(floor * Math.pow(10.0, overFloorDb / 20), Math.pow(10.0, minDb / 20))
        val first = rms.indexOfFirst { it >= gate }
        if (first < 0) return s
        val last = rms.indexOfLast { it >= gate }
        val margin = marginMs * rate / 1000
        val from = maxOf(0, first * frame - margin)
        val to = minOf(s.size, (last + 1) * frame + margin)
        return if (from == 0 && to == s.size) s else s.copyOfRange(from, to)
    }

    /** Scale so the peak sits at [targetDb] (about -3 dBFS), boosting at most [maxGainDb]. Returns a new array. */
    fun normalize(s: FloatArray, targetDb: Double = -3.0, maxGainDb: Double = 30.0): FloatArray {
        var peak = 0f
        for (v in s) peak = maxOf(peak, kotlin.math.abs(v))
        if (peak <= 1e-6f) return s.copyOf()
        val gain = minOf(Math.pow(10.0, targetDb / 20) / peak, Math.pow(10.0, maxGainDb / 20)).toFloat()
        return FloatArray(s.size) { s[it] * gain }
    }

    /**
     * What the model heard, cleaned: Whisper writes noise as "[BLANK_AUDIO]", "(crowd chatter)" or "*music*", and on
     * noise it can loop a phrase. Tags are removed, and the words are capped to what [seconds] of speech can hold.
     */
    fun cleanHeard(text: String, seconds: Double): String {
        val bare = text.replace(TAGS, " ").replace(Regex("\\s+"), " ").trim()
        val words = collapseLoops(bare.split(' ').filter { it.isNotEmpty() })
        val max = (seconds * WORDS_PER_S).toInt() + 3
        return words.take(max).joinToString(" ")
    }

    /**
     * A speech model stuck in a loop ("how how how how", "how far how far how far"): keep the first copy of any
     * word or 2–3-word phrase repeated back to back. Seen with Whisper on the reference phone.
     */
    fun collapseLoops(words: List<String>): List<String> {
        val out = ArrayList<String>(words.size)
        fun key(w: String) = w.lowercase().trim('.', ',', '?', '!', '"')
        for (w in words) {
            out += w
            for (n in 1..3) {
                if (out.size >= 2 * n && (0 until n).all { key(out[out.size - 1 - it]) == key(out[out.size - 1 - n - it]) }) {
                    repeat(n) { out.removeAt(out.size - 1) }
                    break
                }
            }
        }
        return out
    }

    private val TAGS = Regex("\\[[^\\]]*\\]|\\([^)]*\\)|\\*[^*]*\\*")
    /** Fast speech is about 3–4 words a second; a little headroom. */
    private const val WORDS_PER_S = 4.5

    /** A 16-bit mono PCM WAV file. */
    fun wav(s: FloatArray, rate: Int): ByteArray {
        val data = s.size * 2
        val out = java.nio.ByteBuffer.allocate(44 + data).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        out.put("RIFF".toByteArray()).putInt(36 + data).put("WAVE".toByteArray())
        out.put("fmt ".toByteArray()).putInt(16).putShort(1).putShort(1).putInt(rate).putInt(rate * 2).putShort(2).putShort(16)
        out.put("data".toByteArray()).putInt(data)
        for (v in s) out.putShort((v.coerceIn(-1f, 1f) * 32767f).toInt().toShort())
        return out.array()
    }

    /** Samples and rate of a 16-bit mono PCM WAV file with a 44-byte header (what [wav] writes); null if it is not one. */
    fun unwav(b: ByteArray): Pair<FloatArray, Int>? {
        if (b.size < 44 || String(b, 0, 4) != "RIFF" || String(b, 8, 4) != "WAVE") return null
        val bb = java.nio.ByteBuffer.wrap(b).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        val rate = bb.getInt(24)
        val n = (b.size - 44) / 2
        return FloatArray(n) { bb.getShort(44 + it * 2) / 32768f } to rate
    }

    /**
     * Which file of the debug ring of [size] clips the next clip overwrites: the first missing slot, else the oldest.
     * [modified] holds each slot's last-modified time, null when the file does not exist.
     */
    fun ringSlot(modified: List<Long?>): Int {
        val missing = modified.indexOfFirst { it == null }
        if (missing >= 0) return missing
        return modified.indices.minByOrNull { modified[it]!! } ?: 0
    }

    fun ringFile(dir: File, slot: Int) = File(dir, "clip-$slot.wav")

    const val RING = 10
}

/** The growing mic buffer of one take: 16-bit reads appended as floats, capped at [max] samples. */
class ClipBuffer(private val max: Int) {
    private val chunks = ArrayList<FloatArray>()
    var size = 0
        private set
    val full get() = size >= max

    @Synchronized fun append(buf: ShortArray, n: Int) {
        val take = minOf(n, max - size)
        if (take <= 0) return
        chunks += FloatArray(take) { buf[it] / 32768f }
        size += take
    }

    @Synchronized fun toArray(): FloatArray {
        val out = FloatArray(size)
        var i = 0
        for (c in chunks) { c.copyInto(out, i); i += c.size }
        return out
    }
}
