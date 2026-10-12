package io.github.haardhikk.charm

import android.content.Context
import android.media.AudioAttributes
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Which mouth Val speaks with. SYSTEM is the phone's own offline voice (fast); KITTEN the bundled model (slow here). */
enum class SpeechEngine { SYSTEM, KITTEN }

/**
 * The fast mouth: Android's own text-to-speech with an offline (embedded) English voice, pitched up for a small robot.
 * Same contract as [Voice.speak]: blocking, one utterance per [SpeechChunks] chunk, [speak]'s onStart when the first
 * chunk really starts playing, onChunk as each chunk starts, and it returns once the last chunk is done, on an error,
 * or on [stop]. Init is asynchronous: [ready] stays false until an offline voice is set; until then use Kitten.
 */
class SystemVoice(context: Context, private val mayPlay: () -> Boolean) {

    @Volatile var ready = false
        private set
    /** Why the system voice is not in use (null when [ready]), for the fallback log line. */
    @Volatile var notReady: String? = "starting"
        private set
    @Volatile var voiceName: String = "none"
        private set

    @Volatile private var current: Take? = null
    private var takes = 0
    private val tts: TextToSpeech = TextToSpeech(context.applicationContext, ::onInit, GOOGLE_TTS)

    private class Take(
        val progress: SpeechProgress,
        val onStart: (Long) -> Unit,
        val onChunk: (Int, String, Long) -> Unit,
        val onWord: (Int, Int) -> Unit,
    ) {
        val done = CountDownLatch(1)
    }

    /** Main thread: pick an offline English voice, or stay off (and Kitten speaks) with the reason logged. */
    private fun onInit(status: Int) {
        if (status != TextToSpeech.SUCCESS) return fail("engine init failed status=$status")
        val voices = runCatching { tts.voices }.getOrNull().orEmpty().toList()
        val pick = SystemVoices.pick(
            voices.map {
                SystemVoices.Candidate(it.name, it.locale.language, it.locale.country, it.isNetworkConnectionRequired, it.features.orEmpty(), it.quality, it.latency)
            },
        ) ?: run {
            if (BuildConfig.DEBUG) voices.filter { it.locale.language == "en" }.take(12).forEach {
                Log.d(TAG, "voice ${it.name} net=${it.isNetworkConnectionRequired} q=${it.quality} f=${it.features}")
            }
            return fail("no offline English voice among ${voices.size}")
        }
        val voice = voices.first { it.name == pick.name }
        if (tts.setVoice(voice) != TextToSpeech.SUCCESS) return fail("setVoice failed for ${pick.name}")
        tts.setPitch(PITCH)
        tts.setSpeechRate(RATE)
        tts.setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANT).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
        tts.setOnUtteranceProgressListener(Listener())
        voiceName = pick.name
        notReady = null
        ready = true
        if (BuildConfig.DEBUG) Log.d(TAG, "system voice ready voice=${pick.name} offline=true of ${voices.size}")
    }

    private fun fail(why: String) {
        notReady = why
        ready = false
        Log.w(TAG, "system voice off, Kitten speaks: $why")
        // Right after an install the engine can list its voices before the local ones are registered: look again.
        if (retries++ < MAX_RETRIES) android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({ onInit(TextToSpeech.SUCCESS) }, RETRY_MS)
    }
    private var retries = 0

    /** Speak (blocking, off the main thread). Returns the estimated audio length in ms that started; 0 if none did. */
    fun speak(
        text: String,
        onStart: (Long) -> Unit = {},
        onChunk: (Int, String, Long) -> Unit = { _, _, _ -> },
        onWord: (Int, Int) -> Unit = { _, _ -> },
    ): Long {
        if (!ready || !mayPlay()) return 0
        val parts = SpeechChunks.split(text)
        if (parts.isEmpty()) return 0
        val take = Take(SpeechProgress("charm${++takes}", parts, RATE), onStart, onChunk, onWord)
        current = take
        for ((i, part) in parts.withIndex()) {
            val mode = if (i == 0) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD
            if (tts.speak(part, mode, null, take.progress.id(i)) != TextToSpeech.SUCCESS) {
                Log.w(TAG, "system voice refused chunk ${i + 1}/${parts.size}")
                if (i == 0) take.done.countDown()
                break
            }
        }
        // Bounded: a lost callback must never hang the voice thread.
        if (!take.done.await(take.progress.totalMs * 2 + WAIT_SLACK_MS, TimeUnit.MILLISECONDS) && current === take) {
            Log.w(TAG, "system voice timed out")
            tts.stop()
        }
        if (current === take) current = null
        return take.progress.playedMs
    }

    /** Cut Val off now (any thread). */
    fun stop() {
        val take = current
        current = null
        if (ready) tts.stop()
        take?.done?.countDown()
    }

    fun shutdown() {
        stop()
        ready = false
        tts.shutdown()
    }

    /** Engine callbacks (a binder thread). Stale ids from an earlier reply are ignored by [SpeechProgress]. */
    private inner class Listener : UtteranceProgressListener() {
        override fun onStart(id: String) {
            val take = current ?: return
            if (!mayPlay()) return stop() // the mic opened: never talk over it
            val e = take.progress.started(id) ?: return
            if (e.first) take.onStart(take.progress.totalMs)
            if (BuildConfig.DEBUG) Log.d(TAG, "hop tts chunk ${e.index + 1}/${take.progress.count}")
            take.onChunk(e.index, e.text, e.ms)
        }

        /** The engine is about to say chars [start, end) of a chunk: the page types exactly up to there (word-exact sync). */
        override fun onRangeStart(id: String, start: Int, end: Int, frame: Int) {
            val take = current ?: return
            val i = take.progress.indexOf(id) ?: return
            take.onWord(i, end)
        }

        override fun onDone(id: String) {
            val take = current ?: return
            if (take.progress.done(id)) take.done.countDown()
        }

        @Deprecated("Deprecated in Java")
        override fun onError(id: String) = failed(id, -1)

        override fun onError(id: String, errorCode: Int) = failed(id, errorCode)

        override fun onStop(id: String, interrupted: Boolean) {
            val take = current ?: return
            if (take.progress.owns(id)) take.done.countDown()
        }

        private fun failed(id: String, code: Int) {
            val take = current ?: return
            if (!take.progress.owns(id)) return
            Log.w(TAG, "system voice error code=$code")
            take.done.countDown()
        }
    }

    companion object {
        private const val TAG = "Charm"
        private const val MAX_RETRIES = 3
        private const val RETRY_MS = 3000L
        private const val GOOGLE_TTS = "com.google.android.tts" // falls back to the default engine if missing
        /** Val's voice: higher and a touch quicker than a person, a small cheerful robot. */
        const val PITCH = 1.42f
        const val RATE = 1.05f
        private const val WAIT_SLACK_MS = 8000L
    }
}

/** Choosing the offline voice. Pure, unit-tested. */
object SystemVoices {
    data class Candidate(
        val name: String,
        val language: String,
        val country: String,
        val network: Boolean,
        val features: Set<String>,
        val quality: Int,
        val latency: Int,
    )

    /**
     * The best voice that works with no internet: embedded (or a "-local" voice), installed, no network needed, English (US
     * first, then GB). Ties: higher quality, then lower latency, then name (stable across runs).
     */
    fun pick(voices: List<Candidate>): Candidate? = voices
        .filter {
            // Google's installed "-local" voices are offline but do not list KEY_FEATURE_EMBEDDED_SYNTHESIS (seen on the phone).
            !it.network &&
                (TextToSpeech.Engine.KEY_FEATURE_EMBEDDED_SYNTHESIS in it.features || it.name.endsWith("-local")) &&
                TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED !in it.features &&
                (it.language == "en" || it.language == "eng") &&
                regionRank(it.country) < 2
        }
        .minWithOrNull(compareBy<Candidate>({ regionRank(it.country) }, { -it.quality }, { it.latency }, { it.name }))

    private fun regionRank(country: String) = when (country.uppercase()) {
        "US", "USA" -> 0
        "GB", "GBR" -> 1
        else -> 2
    }
}

/**
 * Which chunk of one reply is playing, from the engine's utterance ids (`<prefix>-<index>`). Pure, unit-tested.
 * Chunk lengths are estimates from the text: the system engine does not say how long an utterance is.
 */
class SpeechProgress(private val prefix: String, private val parts: List<String>, rate: Float) {
    data class Started(val index: Int, val text: String, val ms: Long, val first: Boolean)

    val count get() = parts.size
    private val msPerChar = MS_PER_CHAR / rate
    private val lengths = parts.map { (it.length * msPerChar).toLong().coerceAtLeast(MIN_CHUNK_MS) }
    val totalMs = lengths.sum()
    private var anyStarted = false
    private var startedMs = 0L

    /** Estimated audio length of the chunks that have started. */
    val playedMs get() = synchronized(this) { startedMs }

    fun id(i: Int) = "$prefix-$i"

    private fun index(id: String): Int? =
        id.takeIf { it.startsWith("$prefix-") }?.substring(prefix.length + 1)?.toIntOrNull()?.takeIf { it in parts.indices }

    fun owns(id: String) = index(id) != null

    fun indexOf(id: String) = index(id)

    /** A chunk started playing; null for an id of another reply. */
    fun started(id: String): Started? = synchronized(this) {
        val i = index(id) ?: return null
        val first = !anyStarted
        anyStarted = true
        startedMs += lengths[i]
        Started(i, parts[i], lengths[i], first)
    }

    /** True when the reply's last chunk is done. */
    fun done(id: String) = index(id) == parts.lastIndex

    companion object {
        /** Typical English speech at rate 1.0: about 14 characters a second (an estimate, only for typing speed). */
        const val MS_PER_CHAR = 100f // measured on the phone with the pitched-up local voice: ~10 characters a second
        const val MIN_CHUNK_MS = 400L
    }
}
