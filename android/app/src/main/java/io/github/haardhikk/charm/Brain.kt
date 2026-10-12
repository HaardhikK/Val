package io.github.haardhikk.charm

import android.os.SystemClock
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/** One command picked by the brain from Charm's fixed tool list (assets/tools.json). */
data class Command(val name: String, val args: JSONObject, val confidence: Double) {
    companion object {
        /** Parses Needle's /complete reply; anything unexpected becomes "none". */
        fun fromNeedle(raw: String): Command = runCatching {
            val json = JSONObject(raw)
            val call = json.optJSONArray("function_calls")?.optJSONObject(0)
            if (call == null) {
                Command("none", JSONObject(), json.optDouble("confidence", 0.0))
            } else {
                val args = call.optJSONObject("arguments")
                    ?: call.optString("arguments").takeIf { it.startsWith("{") }?.let(::JSONObject) // arguments sent as a JSON string
                    ?: JSONObject()
                val conf = json.optDouble("confidence", 0.0).takeIf { it.isFinite() } ?: 0.0
                Command(call.optString("name", "none"), args, conf)
            }
        }.getOrElse { Command("none", JSONObject(), 0.0) }
    }
}

/**
 * The command picker: the Needle model running as a small server on 127.0.0.1, started from the app's
 * native-library folder (the only place Android lets an app run its own executables).
 */
class Brain(private val nativeDir: String, private val modelsDir: File, private val toolsFile: File) {

    @Volatile private var process: Process? = null
    @Volatile private var stopped = false
    private val restarts = RestartGate(RESTART_GAP_MS)

    fun start(): String? = runCatching {
        if (stopped) return "stopped"
        if (alive()) return null
        restarts.record(SystemClock.elapsedRealtime())
        val exe = File(nativeDir, "libneedle.so")
        if (!exe.exists()) return "needle binary missing (run scripts/prepare-phone.sh, then rebuild)"
        val model = modelFile(modelsDir)
        if (BuildConfig.DEBUG) Log.d(TAG, "needle model ${model.name}")
        val p = ProcessBuilder(
            exe.path, "--model", model.path,
            "--tools", toolsFile.path, "--serve", "--port", PORT.toString(), "--threads", P.needleThreads.toString(), "--max", "96",
        ).redirectErrorStream(true).start()
        process = p
        if (stopped) { // stop() ran while we were spawning: it could not see this process
            p.destroy()
            process = null
            return "stopped"
        }
        // Drain its log so the pipe never fills up; the pipe closes under us when the process is destroyed.
        // Its log is kept out of release builds: it may echo what the user said.
        Thread {
            runCatching { p.inputStream.bufferedReader().forEachLine { if (BuildConfig.DEBUG) Log.d(TAG, "needle: $it") } }
        }.apply { isDaemon = true }.start()
        repeat((P.needleStartWaitMs / START_POLL_MS).toInt()) {
            if (!p.isAlive) return "needle exited (port ${PORT} busy?)"
            if (runCatching { post("/reset", "{}") }.isSuccess && p.isAlive) return null
            Thread.sleep(START_POLL_MS)
        }
        "needle did not start"
    }.getOrElse { it.message ?: "needle failed" }

    fun alive() = process?.isAlive == true

    /** Pick a command for what the user said (blocking). */
    fun pick(text: String): Command {
        if (!alive()) {
            // A crashed server restarts at most once per RESTART_GAP_MS; in between, answer "none" at once.
            if (!restarts.allows(SystemClock.elapsedRealtime()) || start() != null) return Command("none", JSONObject(), 0.0)
        }
        return runCatching {
            post("/reset", "{}") // every utterance is its own question; if this fails, /complete is skipped
            Command.fromNeedle(post("/complete", JSONObject().put("input", text).toString()))
        }.getOrElse {
            Log.w(TAG, "needle call failed", it)
            Command("none", JSONObject(), 0.0)
        }
    }

    fun stop() {
        stopped = true
        process?.let { p ->
            p.destroy()
            if (!p.waitFor(500, java.util.concurrent.TimeUnit.MILLISECONDS)) p.destroyForcibly() // free the port for the next start
        }
        process = null
    }

    private fun post(path: String, body: String): String {
        val c = URL("http://127.0.0.1:$PORT$path").openConnection() as HttpURLConnection
        c.requestMethod = "POST"
        c.connectTimeout = 2000
        c.readTimeout = P.needleReadTimeoutMs
        c.doOutput = true
        c.setRequestProperty("Content-Type", "application/json")
        c.outputStream.use { it.write(body.toByteArray()) }
        return c.inputStream.bufferedReader().use { it.readText() }
    }

    companion object {
        private const val TAG = "Charm"
        private const val PORT = 8182
        private const val RESTART_GAP_MS = 30_000L
        private const val START_POLL_MS = 250L
        private val P get() = DeviceProfile.CURRENT.servers

        /** Our fine-tuned Needle (scripts/train-needle.sh) when prepare-phone.sh pushed it, else the base model. */
        fun modelFile(modelsDir: File): File =
            DeviceProfile.CURRENT.models.let { File(modelsDir, it.needleTuned).takeIf(File::isFile) ?: File(modelsDir, it.needleBase) }
    }
}

/** Spacing for server starts: a new start is allowed only [gapMs] after the previous one (pure, for tests). */
class RestartGate(private val gapMs: Long) {
    private var last: Long? = null

    @Synchronized fun allows(nowMs: Long): Boolean = last.let { it == null || nowMs - it >= gapMs }

    @Synchronized fun record(nowMs: Long) {
        last = nowMs
    }
}
