package io.github.haardhikk.charm

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** What one vision or chat request ended with. */
sealed interface VisionReply {
    data class Text(val text: String, val ms: Long) : VisionReply
    data class Failed(val reason: String) : VisionReply
}

/** Request and reply shapes for llama-server's chat-completions endpoint (pure, unit-tested). */
object VisionApi {
    const val PORT = 8181
    const val MAX_TOKENS = 60
    const val TEMPERATURE = 0.2

    /** The native side gives up on a photo after this long, start-up included (the page waits longer: camera/logic.ts). */
    val DESCRIBE_BUDGET_MS = DeviceProfile.CURRENT.servers.photoBudgetMs

    /** Slot for photos; chat keeps [ChatApi.SLOT], so its cached prefix survives a photo. */
    const val SLOT = 1

    /**
     * llama-server flags: two slots (chat, photo) of 2048 tokens each, no host prompt cache, two threads, a capped
     * image size, no web UI (sizes and threads from [DeviceProfile]).
     */
    fun serverArgs(exe: String, model: String, mmproj: String?, p: DeviceProfile.Servers = DeviceProfile.CURRENT.servers): List<String> = buildList {
        addAll(listOf(exe, "-m", model))
        if (mmproj != null) addAll(listOf("--mmproj", mmproj, "--image-max-tokens", p.llmImageMaxTokens.toString()))
        addAll(
            listOf(
                "--host", "127.0.0.1", "--port", PORT.toString(),
                "-c", p.llmContextTokens.toString(), "-np", p.llmSlots.toString(), "--cache-ram", "0",
                "-t", p.llmThreads.toString(), "--threads-http", p.llmHttpThreads.toString(), "--no-webui",
                // LFM2 is a hybrid model: a cached prompt can only be resumed at a saved checkpoint, and the default
                // spacing (8192 tokens) is longer than our whole prompt, so most questions re-read ~450 tokens (10+ s
                // on the phone). Checkpoints every 64 tokens let the shared instructions be reused.
                "--checkpoint-min-step", "64",
            ),
        )
    }

    fun describeBody(jpegBase64: String, prompt: String): String = JSONObject()
        .put(
            "messages",
            JSONArray().put(
                JSONObject().put("role", "user").put(
                    "content",
                    JSONArray()
                        .put(JSONObject().put("type", "image_url").put("image_url", JSONObject().put("url", "data:image/jpeg;base64,$jpegBase64")))
                        .put(JSONObject().put("type", "text").put("text", prompt)),
                ),
            ),
        )
        .put("max_tokens", MAX_TOKENS)
        .put("temperature", TEMPERATURE)
        .put("cache_prompt", true) // asking about the same photo again reuses its image tokens
        .put("id_slot", SLOT)
        .put("stream", false)
        .toString()

    /** A follow-up question about the last photo; the person's words are wrapped as data like in chat. */
    fun askPrompt(question: String): String =
        "Answer the question about this photo in one or two short spoken sentences. The question is between <said> and </said>: " +
            ChatApi.wrap(question.take(120))

    /** "prompt_n=… cache_n=…" from a reply's timings (tokens read now, tokens reused from the slot), for the debug log. */
    fun timings(raw: String): String = runCatching {
        val t = JSONObject(raw).getJSONObject("timings")
        "prompt_n=${t.optInt("prompt_n", -1)} cache_n=${t.optInt("cache_n", -1)}"
    }.getOrDefault("prompt_n=? cache_n=?")

    /** The answer text from a chat completion, or null if the reply has none. */
    fun parseReply(raw: String): String? = runCatching {
        JSONObject(raw).getJSONArray("choices").getJSONObject(0).getJSONObject("message").getString("content").trim()
    }.getOrNull()?.takeIf { it.isNotEmpty() }
}

/**
 * The on-phone llama.cpp `llama-server` on 127.0.0.1:8181: photos ("what is this?") and short spoken answers.
 * It holds one [ServerModel] at a time, is warmed up after the voice models load ([warm]), and stops after
 * [IDLE_STOP_MS] without requests or when the system is short of memory. All work runs on one thread with a raised
 * nice value; the server is forked from that thread, so it inherits the lower priority and the 3D character keeps
 * the fast cores first.
 */
class Vision(private val nativeDir: String, private val modelsDir: File) {

    private val worker = Executors.newSingleThreadScheduledExecutor { r ->
        Thread({
            android.os.Process.setThreadPriority(NICE)
            r.run()
        }, "charm-vision").apply { isDaemon = true }
    }

    @Volatile private var process: Process? = null
    @Volatile private var loaded: ServerModel? = null
    @Volatile private var healthyNow = false
    @Volatile private var closed = false
    private var idleStop: ScheduledFuture<*>? = null
    private val busy = AtomicBoolean(false)

    /** What the one running request is ("photo" or "question"), so a refusal can say why. */
    @Volatile var busyWith = ""
        private set

    /** The model chat answers come from (fixed per app start; see [ServerModel.forChat]). */
    val chatModel: ServerModel = ServerModel.forChat(modelsDir)

    /** True when a question would be answered without first loading the chat model. */
    val chatReady: Boolean get() = healthyNow && loaded == chatModel && process?.isAlive == true

    /** Start the chat model in the background if it is not running, so the first question does not wait for it. */
    fun warm() = submit {
        if (startServer(chatModel, START_TIMEOUT_MS) == null) {
            runCatching { post("/v1/chat/completions", ChatApi.primeBody(), chatModel.chatReadMs) }
            scheduleIdleStop()
            if (BuildConfig.DEBUG) Log.d(TAG, "llm warm model=${chatModel.name}")
        }
    }

    /** Describe a photo (base64 JPEG, no data-URL prefix). [onDone] always runs exactly once, on the vision thread or at once. */
    fun describe(jpegBase64: String, prompt: String, onDone: (VisionReply) -> Unit) =
        request("photo", onDone) { run("photo", VisionApi.describeBody(jpegBase64, prompt), ServerModel.VISION, VisionApi.DESCRIBE_BUDGET_MS, VisionApi.DESCRIBE_BUDGET_MS) { } }

    /**
     * A short spoken answer to [question] from [chatModel]. [onReady] runs once the model is loaded (right away when it
     * is already warm), so the page can switch from "warming up" to "thinking". [onDone] always runs exactly once.
     */
    fun chat(question: String, context: List<String>, memory: List<Pair<String, String>>, onReady: () -> Unit, onDone: (VisionReply) -> Unit) = request("question", onDone) {
        val reply = run("chat", ChatApi.body(question, context, memory), chatModel, START_TIMEOUT_MS + chatModel.chatReadMs, chatModel.chatReadMs.toLong(), onReady)
        if (reply is VisionReply.Text) ChatApi.clean(reply.text)?.let { VisionReply.Text(it, reply.ms) } ?: VisionReply.Failed("empty answer") else reply
    }

    /** Stop the server now (the system is short of memory); the next request or [warm] starts it again. */
    fun stop() = submit { stopServer() }

    /** Stop for good (onDestroy): nothing starts after this. */
    fun shutdown() {
        closed = true
        worker.shutdownNow()
        process?.let { p ->
            p.destroy()
            runCatching { if (!p.waitFor(500, TimeUnit.MILLISECONDS)) p.destroyForcibly() }
        }
        process = null
    }

    private fun submit(task: () -> Unit) {
        if (closed) return
        runCatching { worker.execute { runCatching(task).onFailure { Log.w(TAG, "vision task failed", it) } } }
    }

    private fun request(kind: String, onDone: (VisionReply) -> Unit, work: () -> VisionReply) {
        if (closed) return onDone(VisionReply.Failed("closed"))
        if (!busy.compareAndSet(false, true)) return onDone(VisionReply.Failed("busy"))
        busyWith = kind
        val queuedAt = System.nanoTime()
        val job = Runnable {
            // Shows time spent queued behind warm-up or another request.
            if (BuildConfig.DEBUG) Log.d(TAG, "hop $kind dequeued waitMs=${(System.nanoTime() - queuedAt) / 1_000_000}")
            val reply = try {
                work()
            } catch (e: Exception) {
                Log.w(TAG, "vision request failed", e)
                VisionReply.Failed("vision request failed")
            } finally {
                busy.set(false)
            }
            scheduleIdleStop()
            onDone(reply)
        }
        try {
            worker.execute(job)
        } catch (e: Exception) { // shut down between the check and here
            busy.set(false)
            onDone(VisionReply.Failed("closed"))
        }
    }

    /**
     * One request with a total time [budgetMs] (start-up included) and at most [readCapMs] for the answer itself;
     * one retry if the server crashed and time is left.
     */
    private fun run(label: String, body: String, want: ServerModel, budgetMs: Long, readCapMs: Long, onReady: () -> Unit): VisionReply {
        val started = System.currentTimeMillis()
        val deadline = started + budgetMs
        repeat(2) { attempt ->
            startServer(want, deadline - System.currentTimeMillis())?.let { return VisionReply.Failed(it) }
            onReady()
            val left = minOf(deadline - System.currentTimeMillis(), readCapMs)
            if (left < MIN_READ_MS) return VisionReply.Failed("timeout")
            try {
                val raw = post("/v1/chat/completions", body, left.toInt())
                // Tokens read for this request: a warm chat question should read only its own ~20–40.
                if (BuildConfig.DEBUG) Log.d(TAG, "hop $label ${VisionApi.timings(raw)}")
                val text = VisionApi.parseReply(raw) ?: return VisionReply.Failed("empty answer")
                return VisionReply.Text(text, System.currentTimeMillis() - started)
            } catch (e: Exception) {
                Log.w(TAG, "llm request failed (attempt ${attempt + 1}): ${e.javaClass.simpleName}")
                if (process?.isAlive == true) return VisionReply.Failed(if (e is java.net.SocketTimeoutException) "timeout" else "request failed")
                healthyNow = false
            }
        }
        return VisionReply.Failed("server crashed")
    }

    /** Starts the server with [want] if it is not already running it; null when it is ready, else the reason. */
    private fun startServer(want: ServerModel, timeoutMs: Long): String? {
        if (closed) return "closed"
        if (process?.isAlive == true && loaded == want && healthyNow) return null
        stopServer()
        val exe = File(nativeDir, "libllama-server.so")
        val model = File(modelsDir, want.model)
        val mmproj = want.mmproj?.let { File(modelsDir, it) }
        if (!exe.exists()) return "vision binary missing (run scripts/prepare-phone.sh, then rebuild)"
        if (!model.exists() || mmproj?.exists() == false) return "model missing (run scripts/prepare-phone.sh)"
        val p = runCatching {
            ProcessBuilder(VisionApi.serverArgs(exe.path, model.path, mmproj?.path))
                .directory(File(nativeDir))
                .redirectErrorStream(true)
                .apply { environment()["LD_LIBRARY_PATH"] = nativeDir }
                .start()
        }.getOrElse { return "server failed: ${it.message}" }
        process = p
        loaded = want
        if (closed) { // shutdown() ran while this was starting
            stopServer()
            return "closed"
        }
        // Drain its log so the pipe never fills up. Debug builds only: it can echo what the user asked.
        Thread { runCatching { p.inputStream.bufferedReader().forEachLine { if (BuildConfig.DEBUG) Log.d(TAG, "llm: $it") } } }
            .apply { isDaemon = true }.start()
        val t0 = System.currentTimeMillis()
        val deadline = t0 + timeoutMs.coerceAtMost(START_TIMEOUT_MS)
        while (System.currentTimeMillis() < deadline) {
            if (!p.isAlive) return "server exited (${p.exitValue()})"
            if (healthy()) {
                healthyNow = true
                Log.i(TAG, "llm server ready model=${want.name} load=${System.currentTimeMillis() - t0}ms")
                return null
            }
            Thread.sleep(250)
        }
        stopServer()
        return "timeout"
    }

    private fun scheduleIdleStop() {
        idleStop?.cancel(false)
        idleStop = runCatching { worker.schedule({ stopServer() }, IDLE_STOP_MS, TimeUnit.MILLISECONDS) }.getOrNull()
    }

    private fun stopServer() {
        idleStop?.cancel(false)
        idleStop = null
        healthyNow = false
        loaded = null
        val p = process ?: return
        process = null
        p.destroy()
        if (!p.waitFor(2, TimeUnit.SECONDS)) p.destroyForcibly()
        Log.i(TAG, "llm server stopped")
    }

    private fun healthy(): Boolean = runCatching {
        val c = URL("http://127.0.0.1:${VisionApi.PORT}/health").openConnection() as HttpURLConnection
        c.connectTimeout = 500
        c.readTimeout = 1000
        try {
            c.responseCode == 200 // 503 while the model loads
        } finally {
            c.disconnect()
        }
    }.getOrDefault(false)

    private fun post(path: String, body: String, readTimeoutMs: Int): String {
        val c = URL("http://127.0.0.1:${VisionApi.PORT}$path").openConnection() as HttpURLConnection
        try {
            c.requestMethod = "POST"
            c.connectTimeout = 2000
            c.readTimeout = readTimeoutMs
            c.doOutput = true
            c.setRequestProperty("Content-Type", "application/json")
            c.outputStream.use { it.write(body.toByteArray()) }
            if (c.responseCode != 200) throw IOException("HTTP ${c.responseCode}")
            return c.inputStream.bufferedReader().use { it.readText() }
        } finally {
            c.disconnect()
        }
    }

    companion object {
        private const val TAG = "Charm"
        /** Below the UI, but under 10 so Android does not move it to the little-core background group. */
        private val NICE = DeviceProfile.CURRENT.servers.llmNice
        /** Kept warm this long after the last use; a talk press warms it again. */
        private val IDLE_STOP_MS = DeviceProfile.CURRENT.servers.llmIdleStopMs
        /** Longest model load (cold flash read of the 1.2B is the worst case). */
        val START_TIMEOUT_MS = DeviceProfile.CURRENT.servers.llmStartTimeoutMs
        private const val MIN_READ_MS = 1_500L
    }
}
