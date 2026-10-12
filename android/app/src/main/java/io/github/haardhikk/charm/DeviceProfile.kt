package io.github.haardhikk.charm

import android.view.KeyEvent

/**
 * Every knob in the app that is tuned to one phone: CPU threads and model sizes, timeouts measured on it, its button,
 * and its sensors' thresholds. To run Charm on another phone, copy [REALME_3_PRO], change what differs, and point
 * [CURRENT] at the copy; nothing else in the app needs editing.
 *
 * Also per phone or per place, kept next to their own build steps:
 * - the page's frame-rate and pixel caps: web/src/device.ts;
 * - the WebView version the page is compiled for (chrome94): web/build.mjs;
 * - the map area and timetable feed: the constants at the top of scripts/build-map-data.py and scripts/build-transit.py;
 * - which model files are pushed: scripts/prepare-phone.sh (the file names below must match it).
 */
data class DeviceProfile(
    val name: String,
    val servers: Servers,
    val models: Models,
    val button: Button,
    val sensors: Sensors,
) {
    /** The on-phone model servers and speech engines: threads, sizes and how long to wait for them. */
    data class Servers(
        /** llama-server (chat and photos): compute threads, HTTP threads, total context, slots (chat + photo). */
        val llmThreads: Int,
        val llmHttpThreads: Int,
        val llmContextTokens: Int,
        val llmSlots: Int,
        /** Largest image the vision model reads, in tokens (more is slower and needs more RAM). */
        val llmImageMaxTokens: Int,
        /** Nice value of the vision thread and the server it forks (the 3D character keeps the fast cores). */
        val llmNice: Int,
        /** Longest model load; the cold flash read of the 1.2B model is the worst case. */
        val llmStartTimeoutMs: Long,
        /** The server is stopped this long after its last use, to give its RAM back. */
        val llmIdleStopMs: Long,
        /** How long a spoken question waits for an answer from the 450M and the 1.2B chat model. */
        val chatReadMs: Int,
        val chatReadMs1_2b: Int,
        /** The native side gives up on a photo after this long, start-up included (the page waits longer: camera/logic.ts). */
        val photoBudgetMs: Long,
        /** Needle (the command picker): threads, how long its start may take, and its per-request read limit. */
        val needleThreads: Int,
        val needleStartWaitMs: Long,
        val needleReadTimeoutMs: Int,
        /** sherpa-onnx threads for speech-to-text and for the Kitten fallback voice. */
        val sttThreads: Int,
        val ttsThreads: Int,
    )

    /**
     * Which models are used, as paths under the phone's models folder (pushed by scripts/prepare-phone.sh).
     *
     * Every model here is a swappable part: pick a lighter one for a weaker phone or a bigger one for a stronger phone.
     * To swap one, put the new file on the phone (add it to scripts/prepare-phone.sh), change its field below, rebuild,
     * and measure on the phone (adb logcat shows the timings). Per job:
     * - [stt]: any [SttEngine] entry (Moonshine tiny or base, Whisper tiny or base). Another sherpa-onnx speech model of
     *   the same family is a new [SttEngine] entry with its folder and files; another family also needs its config in Voice.kt.
     * - [visionModel] + [visionProjector]: any GGUF model that llama.cpp's `llama-server` runs, plus its mmproj file
     *   (photos and, by default, chat). Bigger models need more RAM and a longer [Servers.chatReadMs] and [Servers.photoBudgetMs].
     * - [chatModel1_2b]: an optional text-only GGUF for chat; it is used only when its file is on the phone.
     * - [needleTuned] / [needleBase]: a Needle .cact file; the tuned one wins when present (scripts/train-needle.sh).
     * - The voice is not here: the phone's own offline text-to-speech speaks first (SystemVoice.kt), Kitten via sherpa-onnx
     *   is the fallback (Voice.kt); another sherpa-onnx voice model needs its config in Voice.kt.
     */
    data class Models(
        /** The speech-to-text engine to load; Moonshine tiny is the fallback when its files are missing. */
        val stt: SttEngine,
        /** The vision model and its image projector; it also answers chat unless [chatModel1_2b] was pushed. */
        val visionModel: String,
        val visionProjector: String,
        /** Optional larger text-only chat model; used for chat only when its file is on the phone. */
        val chatModel1_2b: String,
        /** The command picker: the fine-tuned model when pushed, else the base. */
        val needleTuned: String,
        val needleBase: String,
    )

    /** Charm's one hardware button: which key, and the timing of a hold and of a press count. */
    data class Button(
        val keyCode: Int,
        /** A press held this long is push-to-talk. */
        val holdMs: Long,
        /** Short presses are counted until this long passes with no new press (a worn key needs a forgiving gap). */
        val gapMs: Long,
    )

    /** Sensor thresholds: they depend on the phone's sensors (and the table, for knocks). */
    data class Sensors(
        /** Knock: gravity z (m/s²) to start and to stop listening, and the detector's limits (see Knock.kt). */
        val knockListenOnZ: Float,
        val knockListenOffZ: Float,
        val knockFlatZ: Float,
        val knockFlatTilt: Float,
        val knockTrigger: Float,
        val knockRelease: Float,
        val knockPeakMin: Float,
        val knockGyroMax: Float,
        val knockQuietLevel: Float,
        /** +1: a push towards +x means the knock came from the right; -1 flips it (depends on the sensor's axes). */
        val knockSideSign: Float,
        /** Ambient light (lux): dark below / above, bright above / below (hysteresis; see LightHysteresis). */
        val lightDarkEnter: Float,
        val lightDarkExit: Float,
        val lightBrightEnter: Float,
        val lightBrightExit: Float,
        /** A proximity sensor reporting centimetres reads "near" below this. */
        val proximityNearCm: Float,
        /** Earth's local field (total intensity, µT): where the metal detector's baseline starts. */
        val earthFieldUt: Float,
    )

    companion object {
        /**
         * Tuned for a Realme 3 Pro: Snapdragon 710 (2 fast + 6 slow cores), 4 GB RAM, Android 11, 1080x2340 screen,
         * a broken volume-up key. Timings measured on it in airplane mode.
         */
        val REALME_3_PRO = DeviceProfile(
            name = "Realme 3 Pro (Snapdragon 710, 4 GB)",
            servers = Servers(
                llmThreads = 2, // the two fast cores
                llmHttpThreads = 2,
                llmContextTokens = 4096, // two slots of 2048 tokens
                llmSlots = 2,
                llmImageMaxTokens = 256,
                llmNice = 8, // below the UI, but under 10 so Android does not move it to the little-core group
                llmStartTimeoutMs = 40_000L,
                llmIdleStopMs = 10 * 60_000L, // ~450 MB with the default model; a talk press warms it again
                chatReadMs = 15_000,
                chatReadMs1_2b = 20_000,
                photoBudgetMs = 60_000L, // the first photo takes ~17 s while the model warms up
                needleThreads = 2,
                needleStartWaitMs = 10_000L,
                needleReadTimeoutMs = 4000, // the whole voice round trip has a 3 s budget
                sttThreads = 2,
                ttsThreads = 2, // two cores: chunk N+1 must be made faster than chunk N plays
            ),
            models = Models(
                stt = SttEngine.MOONSHINE_BASE, // accuracy first (noisy rooms); 0.4–0.7 s per sentence here
                visionModel = "vlm/LFM2.5-VL-450M-Q4_K_M.gguf",
                visionProjector = "vlm/mmproj-LFM2.5-VL-450m-Q8_0.gguf",
                chatModel1_2b = "llm/LFM2.5-1.2B-Instruct-Q4_K_M.gguf",
                needleTuned = "needle/needle3-val.cact",
                needleBase = "needle/needle3.cact",
            ),
            button = Button(keyCode = KeyEvent.KEYCODE_VOLUME_DOWN, holdMs = 350, gapMs = 600), // volume-up is broken
            sensors = Sensors(
                knockListenOnZ = 9.0f,
                knockListenOffZ = 8.5f,
                knockFlatZ = 9.0f,
                knockFlatTilt = 2.5f,
                knockTrigger = 0.8f,
                knockRelease = 0.4f,
                knockPeakMin = 1.5f,
                knockGyroMax = 0.5f,
                knockQuietLevel = 0.6f,
                knockSideSign = -1f,
                lightDarkEnter = 10f,
                lightDarkExit = 30f,
                lightBrightEnter = 5000f,
                lightBrightExit = 3000f,
                proximityNearCm = 5f,
                earthFieldUt = 49f, // Dresden
            ),
        )

        /** The profile the app runs with. */
        val CURRENT = REALME_3_PRO
    }
}
