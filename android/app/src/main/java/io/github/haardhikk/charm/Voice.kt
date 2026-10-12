package io.github.haardhikk.charm

import android.annotation.SuppressLint
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor
import android.os.SystemClock
import android.util.Log
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.OfflineModelConfig
import com.k2fsa.sherpa.onnx.OfflineMoonshineModelConfig
import com.k2fsa.sherpa.onnx.OfflineRecognizer
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig
import com.k2fsa.sherpa.onnx.OfflineTts
import com.k2fsa.sherpa.onnx.OfflineTtsConfig
import com.k2fsa.sherpa.onnx.OfflineTtsKittenModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig
import com.k2fsa.sherpa.onnx.OfflineWhisperModelConfig
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * Offline ears and mouth: push-to-talk recording, speech-to-text (Moonshine base by default, Moonshine tiny as the
 * fallback; one model in RAM at a time; Whisper is not pushed to the phone and is kept for comparison) and Kitten
 * text-to-speech, all through sherpa-onnx.
 * Model files live in the app's external files folder (pushed by scripts/prepare-phone.sh), never in the APK.
 */
class Voice(private val modelsDir: File) {

    private var recognizer: OfflineRecognizer? = null // only touched on the voice work thread
    /** The loaded speech-to-text engine, null until [load] or [useEngine] succeeds. */
    @Volatile var engine: SttEngine? = null
        private set
    private var tts: OfflineTts? = null
    private var micThread: Thread? = null
    @Volatile private var current: Take? = null // the take the mic is filling; null when it is not recording for us
    @Volatile private var speakTake: Any? = null // the current reply; generation and playback stop when it changes
    private val trackLock = Any()
    private var speakingTrack: AudioTrack? = null // guarded by trackLock

    /** Which microphone path to record from (debug builds can switch it to compare). */
    @Volatile var micSource = MicSource.COMM

    /** Live mic level 0..1 while listening, called on the mic thread at most [LEVEL_HZ] times a second. */
    @Volatile var onLevel: ((Float) -> Unit)? = null

    val ready get() = recognizer != null
    /** True while a confirmed take records (a pre-roll that may still be dropped does not count). */
    val listening get() = current?.live == true

    /**
     * One recording. The mic thread fills [buf] until the take is cancelled, its stop time passes (the tail after the
     * release) or the buffer is full, then counts [done] down.
     */
    class Take internal constructor() {
        internal val buf = ClipBuffer(MAX_SAMPLES)
        @Volatile internal var live = false
        @Volatile internal var cancelled = false
        @Volatile internal var stopAtMs = Long.MAX_VALUE
        internal val done = CountDownLatch(1)

        /** The whole clip once the mic thread has finished with it (blocking, at most ~1 s: call off the main thread). */
        fun await(): FloatArray {
            done.await(1, TimeUnit.SECONDS)
            return buf.toArray()
        }
    }

    /** Load the speech-to-text [wanted] engine (or the fallback) and the voice (seconds on this phone): call once, off the main thread. */
    fun load(wanted: SttEngine): String? {
        val sttError = useEngine(wanted)
        val ttsError = runCatching {
            // The fallback voice is a swappable part: another sherpa-onnx voice model (VITS, Matcha, Kokoro) goes in this
            // OfflineTtsConfig instead of the Kitten one, with its files pushed by scripts/prepare-phone.sh.
            val kit = File(modelsDir, "kitten")
            tts = OfflineTts(
                null,
                OfflineTtsConfig(
                    model = OfflineTtsModelConfig(
                        kitten = OfflineTtsKittenModelConfig(
                            model = File(kit, "model.int8.onnx").path,
                            voices = File(kit, "voices.bin").path,
                            tokens = File(kit, "tokens.txt").path,
                            dataDir = File(kit, "espeak-ng-data").path,
                        ),
                        numThreads = DeviceProfile.CURRENT.servers.ttsThreads, // chunk N+1 must be made faster than chunk N plays
                    ),
                ),
            )
            null
        }.getOrElse { e ->
            Log.e(TAG, "voice model failed to load", e)
            e.message ?: "load failed"
        }
        return sttError ?: ttsError
    }

    /**
     * Switch speech-to-text to [wanted] (or Moonshine if its files are missing), freeing the old model first so only
     * one is ever in RAM. Voice work thread only. Returns an error text, or null when an engine is loaded.
     */
    fun useEngine(wanted: SttEngine): String? {
        val pick = SttEngine.pick(wanted) { it.present(modelsDir) } ?: return "no speech model on the phone".also { Log.e(TAG, it) }
        if (pick == engine && recognizer != null) return null
        recognizer?.release()
        recognizer = null
        engine = null
        val t0 = SystemClock.uptimeMillis()
        return runCatching {
            recognizer = OfflineRecognizer(null, recognizerConfig(pick))
            engine = pick
            if (BuildConfig.DEBUG) Log.d(TAG, "hop stt engine=${pick.wire} wanted=${wanted.wire} load=${SystemClock.uptimeMillis() - t0} ms")
            null
        }.getOrElse { e ->
            Log.e(TAG, "speech model ${pick.wire} failed to load", e)
            e.message ?: "load failed"
        }
    }

    private fun recognizerConfig(e: SttEngine): OfflineRecognizerConfig {
        val d = File(modelsDir, e.dir)
        val model = when (e) {
            SttEngine.MOONSHINE, SttEngine.MOONSHINE_BASE -> OfflineModelConfig(
                moonshine = OfflineMoonshineModelConfig(encoder = File(d, e.files[0]).path, mergedDecoder = File(d, e.files[1]).path),
                tokens = File(d, e.files[2]).path,
                numThreads = DeviceProfile.CURRENT.servers.sttThreads,
            )
            SttEngine.WHISPER_TINY, SttEngine.WHISPER_BASE -> OfflineModelConfig(
                whisper = OfflineWhisperModelConfig(
                    encoder = File(d, e.files[0]).path,
                    decoder = File(d, e.files[1]).path,
                    language = "en",
                    task = "transcribe",
                    // Frames of silence added after the clip so Whisper finds its end token. The default (-1) adds
                    // 1000 frames = 10 s of encoder work; 50 is the value suggested for English-only models.
                    tailPaddings = WHISPER_TAIL_FRAMES,
                    enableTokenTimestamps = false,
                    enableSegmentTimestamps = false,
                ),
                tokens = File(d, e.files[2]).path,
                numThreads = DeviceProfile.CURRENT.servers.sttThreads,
            )
        }
        return OfflineRecognizerConfig(featConfig = FeatureConfig(sampleRate = SAMPLE_RATE, featureDim = 80), modelConfig = model)
    }

    /**
     * Start recording (main thread). [live] false is a pre-roll at key-down: it records but does not count as
     * listening (Val's voice and the level meter ignore it) until [commit], and [discard] drops it silently.
     * Returns false if it could not start (also while the previous take's tail still records).
     */
    @SuppressLint("MissingPermission") // the caller checks RECORD_AUDIO first
    fun startListening(live: Boolean = true): Boolean {
        if (micThread?.isAlive == true) return false
        val min = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        if (min <= 0) return false
        val src = micSource
        val rec = AudioRecord(src.source, SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, min * 2)
        if (rec.state != AudioRecord.STATE_INITIALIZED) {
            rec.release()
            return false
        }
        // The platform's noise suppressor and gain control on this session, where the phone has them.
        val ns = if (NoiseSuppressor.isAvailable()) runCatching { NoiseSuppressor.create(rec.audioSessionId)?.apply { enabled = true } }.getOrNull() else null
        val agc = if (AutomaticGainControl.isAvailable()) runCatching { AutomaticGainControl.create(rec.audioSessionId)?.apply { enabled = true } }.getOrNull() else null
        if (BuildConfig.DEBUG) Log.d(TAG, "hop mic src=${src.wire} ns=${fx(NoiseSuppressor.isAvailable(), ns?.enabled)} agc=${fx(AutomaticGainControl.isAvailable(), agc?.enabled)} live=$live")
        val take = Take().also { it.live = live }
        current = take
        rec.startRecording()
        micThread = thread(name = "charm-mic") {
            val buf = ShortArray(min)
            var lastLevel = 0L
            try {
                while (!take.cancelled && SystemClock.uptimeMillis() < take.stopAtMs && !take.buf.full) { // never record forever
                    val n = rec.read(buf, 0, buf.size)
                    if (n < 0) break // mic error: stop instead of spinning
                    if (n > 0) take.buf.append(buf, n)
                    val now = System.nanoTime()
                    if (n > 0 && take.live && now - lastLevel >= 1_000_000_000L / LEVEL_HZ) {
                        lastLevel = now
                        onLevel?.invoke(level(buf, n))
                    }
                }
            } finally {
                runCatching { rec.stop() }
                ns?.release()
                agc?.release()
                rec.release()
                take.done.countDown()
            }
        }
        return true
    }

    /** The key became a hold: the pre-roll take becomes the clip, from key-down on (main thread). False if none. */
    fun commit(): Boolean {
        val t = current ?: return false
        if (t.cancelled || t.stopAtMs != Long.MAX_VALUE) return false
        t.live = true
        return true
    }

    /** A short press: drop the pre-roll and close the mic, keeping nothing (main thread). True if one was dropped. */
    fun discard(): Boolean {
        val t = current ?: return false
        if (t.live) return false // a confirmed take is never dropped by a press count
        t.cancelled = true
        current = null
        // Let the mic thread close (one read, ~tens of ms), so a quick re-press can start a new take.
        micThread?.join(DISCARD_JOIN_MS)
        return true
    }

    /**
     * The talk ended (main thread): the mic keeps recording [tailMs] more (people let go while finishing the last
     * word), then stops. Returns the take to [Take.await] off the main thread, or null if nothing was listening.
     */
    fun finish(tailMs: Long): Take? {
        val t = current ?: return null
        current = null
        if (!t.live) { // never confirmed: nothing to hand over
            t.cancelled = true
            return null
        }
        t.stopAtMs = SystemClock.uptimeMillis() + tailMs
        return t
    }

    /** Stop at once and keep nothing (main thread, returns within ~0.5 s). True if a confirmed take was cut off. */
    fun cancel(): Boolean {
        val t = current
        current = null
        t?.cancelled = true
        micThread?.join(500)
        micThread = null
        return t?.live == true
    }

    /**
     * The clip as the model sees it: leading and trailing noise trimmed (200 ms margins kept) and the peak raised to
     * about -3 dBFS.
     */
    fun prepare(samples: FloatArray, rate: Int = SAMPLE_RATE): FloatArray = Clip.normalize(Clip.trim(samples, rate))

    /** What was said in a raw clip (blocking: voice work thread only). */
    fun transcribe(samples: FloatArray, rate: Int = SAMPLE_RATE): String {
        if (samples.size < rate / 4) return "" // under 0.25 s: nothing said
        val clip = prepare(samples, rate)
        if (BuildConfig.DEBUG) Log.d(TAG, "hop stt prep in=${samples.size * 1000L / rate}ms out=${clip.size * 1000L / rate}ms engine=${engine?.wire}")
        val rec = recognizer ?: return ""
        val stream = rec.createStream()
        try {
            stream.acceptWaveform(clip, rate)
            rec.decode(stream)
            return Clip.cleanHeard(rec.getResult(stream).text, clip.size.toDouble() / rate)
        } finally {
            stream.release()
        }
    }

    /** Transcribe a 16-bit mono PCM WAV file (debug test hooks: the ears without a live voice). */
    fun transcribeWav(file: File): String {
        val (pcm, rate) = Clip.unwav(file.readBytes()) ?: return ""
        return transcribe(pcm, rate)
    }

    /**
     * Speak text with the Kitten voice, streamed: the reply is cut into short chunks ([SpeechChunks]); chunk 1 (at most
     * [SpeechChunks.FIRST_WORDS] words) is
     * generated and starts playing at once, and chunk N+1 is generated while chunk N plays. Blocks until the last
     * sample has played or [stopSpeaking]. [onStart] runs when the first sample starts playing, with an estimate of the
     * total length in ms; [onChunk] runs as each chunk starts playing, with its exact length (both on the player thread).
     * Returns the audio length in ms that was queued for playback (0 when nothing played).
     */
    fun speak(
        text: String,
        voiceId: Int = KITTEN_VOICE,
        onStart: (estimatedMs: Long) -> Unit = {},
        onChunk: (i: Int, text: String, ms: Long) -> Unit = { _, _, _ -> },
    ): Long {
        val engine = tts ?: return 0
        val parts = SpeechChunks.splitQuickStart(text) // a short first chunk: first audio sooner
        if (parts.isEmpty() || listening) return 0
        val take = Any()
        speakTake = take
        val rate = engine.sampleRate()
        val queue = LinkedBlockingQueue<Pcm>()
        val totalChars = parts.sumOf { it.length }
        var playedMs = 0L
        val player = thread(name = "charm-tts-play") {
            playedMs = play(take, rate, queue, totalChars, parts.size, onStart, onChunk)
        }
        try {
            for ((i, part) in parts.withIndex()) {
                if (speakTake !== take || listening) break
                val t0 = System.nanoTime()
                // The callback runs as audio is made; returning 0 stops generation when Val is cut off.
                val pcm = engine.generateWithCallback(part, voiceId, SPEED, KeepGoing { speakTake === take }.asCallback()).samples
                if (BuildConfig.DEBUG) Log.d(TAG, "hop tts chunk ${i + 1}/${parts.size} gen=${(System.nanoTime() - t0) / 1_000_000} ms audio=${pcm.size * 1000L / rate} ms")
                if (speakTake !== take) break
                if (pcm.isNotEmpty()) queue.put(Pcm(i, part, pcm))
            }
        } finally {
            queue.put(END)
            player.join()
            if (speakTake === take) speakTake = null
        }
        return playedMs
    }

    private class Pcm(val index: Int, val text: String, val samples: FloatArray)

    /**
     * The player thread: one MODE_STREAM float track, written in 50 ms slices so a cut-off takes effect within a slice,
     * and chunk starts are reported when the playback head reaches them, not when they enter the buffer.
     */
    private fun play(
        take: Any,
        rate: Int,
        queue: LinkedBlockingQueue<Pcm>,
        totalChars: Int,
        count: Int,
        onStart: (Long) -> Unit,
        onChunk: (Int, String, Long) -> Unit,
    ): Long = try {
        playTrack(take, rate, queue, totalChars, count, onStart, onChunk)
    } catch (e: Exception) { // no audio track (device busy, bad rate) must never crash the app: nothing played
        Log.w(TAG, "tts playback failed", e)
        0
    }

    private fun playTrack(
        take: Any,
        rate: Int,
        queue: LinkedBlockingQueue<Pcm>,
        totalChars: Int,
        count: Int,
        onStart: (Long) -> Unit,
        onChunk: (Int, String, Long) -> Unit,
    ): Long {
        val min = AudioTrack.getMinBufferSize(rate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_FLOAT)
        val track = AudioTrack.Builder()
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANT).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            .setAudioFormat(AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_FLOAT).setSampleRate(rate).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
            .setBufferSizeInBytes(maxOf(min, rate / 5 * 4)) // ~200 ms of float audio: small, so a cut-off is quick
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
        val pending = ArrayDeque<Pair<Long, Pcm>>() // chunk start frame → chunk, not yet announced
        var announced = 0
        var written = 0L
        var started = false
        val slice = rate / 20
        fun head() = track.playbackHeadPosition.toLong() and 0xffffffffL
        fun announce() {
            while (pending.isNotEmpty() && head() >= pending.first().first) {
                val c = pending.removeFirst().second
                announced++
                onChunk(c.index, c.text, c.samples.size * 1000L / rate)
            }
        }
        synchronized(trackLock) { speakingTrack = track }
        try {
            while (speakTake === take) {
                val c = queue.poll(SLICE_MS, TimeUnit.MILLISECONDS)
                if (c == null) { // generation is behind: keep announcing what is playing
                    if (started) announce()
                    continue
                }
                if (c === END) break
                if (!started) {
                    if (listening) break // the user is talking: never play over the open mic
                    track.play()
                    started = true
                    val ms = c.samples.size * 1000L / rate
                    // Later chunks are not made yet: estimate them at the first chunk's speed per character.
                    onStart(ms + (totalChars - c.text.length) * ms / maxOf(1, c.text.length))
                }
                pending.addLast(written to c)
                announce()
                var off = 0
                while (off < c.samples.size && speakTake === take) {
                    val n = track.write(c.samples, off, minOf(slice, c.samples.size - off), AudioTrack.WRITE_BLOCKING)
                    if (n <= 0) break
                    off += n
                    announce()
                }
                written += off
            }
            // Drain: wait until the head has played the last sample (bounded, in case the head stalls).
            if (started && speakTake === take) {
                val until = System.nanoTime() + (written * 1000L / rate + 500) * 1_000_000
                while (speakTake === take && System.nanoTime() < until && head() < written) {
                    announce()
                    Thread.sleep(20)
                }
                announce()
            }
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        } finally {
            synchronized(trackLock) {
                speakingTrack = null
                runCatching { track.pause() }
                runCatching { track.flush() }
                runCatching { track.stop() }
                track.release()
            }
        }
        if (BuildConfig.DEBUG) Log.d(TAG, "hop tts played chunks=$announced/$count cut=${speakTake !== take}")
        return if (started) written * 1000L / rate else 0
    }

    /** Cut Val off mid-sentence (any thread): stops generation, the queue and the track at once. */
    fun stopSpeaking() {
        speakTake = null
        synchronized(trackLock) {
            speakingTrack?.let { t ->
                runCatching { t.pause() } // silent now
                runCatching { t.flush() } // and a blocked write returns
            }
        }
    }

    /** Free the native models (call on the voice thread once nothing else uses them). */
    fun release() {
        recognizer?.release()
        recognizer = null
        engine = null
        tts?.release()
        tts = null
    }

    companion object {
        private const val TAG = "Charm"
        const val SAMPLE_RATE = 16000
        /** How long a short press waits for the mic thread to close (main thread, so kept short). */
        private const val DISCARD_JOIN_MS = 100L
        private const val MAX_SAMPLES = 12 * SAMPLE_RATE
        /** Whisper tail padding in 10 ms feature frames (see recognizerConfig). */
        private const val WHISPER_TAIL_FRAMES = -1 // the sherpa default: less padding made Whisper loop on real clips

        private fun fx(available: Boolean, on: Boolean?) = when {
            !available -> "none"
            on == true -> "on"
            else -> "failed"
        }
        const val LEVEL_HZ = 15
        /** Kitten speaker id used for Val. */
        const val KITTEN_VOICE = 3
        private const val SPEED = 1.05f
        private const val SLICE_MS = 50L
        private val END = Pcm(-1, "", FloatArray(0))

        /** Loudness of a read as 0..1: RMS in dBFS, mapped so -55 dB (room hush) is 0 and -10 dB (close speech) is 1. */
        fun level(buf: ShortArray, n: Int): Float {
            if (n <= 0) return 0f
            var sum = 0.0
            for (i in 0 until n) {
                val v = buf[i] / 32768.0
                sum += v * v
            }
            val rms = kotlin.math.sqrt(sum / n)
            if (rms <= 0.0) return 0f
            val db = 20 * kotlin.math.log10(rms)
            return ((db + 55) / 45).coerceIn(0.0, 1.0).toFloat()
        }
    }
}

/**
 * The TTS progress callback. sherpa-onnx's native code looks up `invoke([F)Ljava/lang/Integer;` on the callback's own
 * class, so a Kotlin lambda (which only has the erased `invoke(Object)`) makes it abort the whole app. This class
 * declares exactly that method: the boxed Int? return type compiles to `java.lang.Integer`.
 */
private class KeepGoing(private val go: () -> Boolean) : (FloatArray) -> Int? {
    override fun invoke(samples: FloatArray): Int? = if (go()) 1 else 0

    @Suppress("UNCHECKED_CAST")
    fun asCallback() = this as (FloatArray) -> Int
}

/**
 * Microphone paths. COMM (voice communication) is the default: it runs the phone's call pipeline, which on dual-mic
 * phones like this one includes the hardware noise suppression a loud hall needs. REC (voice recognition) is meant
 * to be flat and unprocessed, so the room noise reaches the model; RAW is the plain mic. Debug builds can switch.
 */
enum class MicSource(val wire: String, val source: Int) {
    COMM("comm", MediaRecorder.AudioSource.VOICE_COMMUNICATION),
    REC("rec", MediaRecorder.AudioSource.VOICE_RECOGNITION),
    RAW("raw", MediaRecorder.AudioSource.MIC),
    ;

    companion object {
        fun fromWire(s: String?): MicSource? = entries.firstOrNull { it.wire == s }
    }
}
