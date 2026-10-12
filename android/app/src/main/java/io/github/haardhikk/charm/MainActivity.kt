package io.github.haardhikk.charm

import android.annotation.SuppressLint
import android.app.Activity
import android.app.ActivityManager
import android.content.ComponentCallbacks2
import android.content.pm.PackageManager
import android.content.Intent
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.SystemClock
import android.os.Vibrator
import android.util.Log
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebMessagePortCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.io.File
import java.io.ByteArrayInputStream
import java.util.concurrent.Executors

/**
 * The Charm shell: a full-screen WebView showing the 3D character, fed by the phone's motion sensors.
 * Kiosk fallback (Realme refuses device owner): Charm can be the HOME app and pins itself;
 * a 3 s long-press in the top-left corner is the admin exit (unpin; Android asks for the PIN if set).
 */
class MainActivity : Activity(), SensorEventListener {

    private lateinit var webView: WebView
    private lateinit var sensors: SensorManager
    private lateinit var vibrator: Vibrator
    private var port: WebMessagePortCompat? = null

    private val gravity = floatArrayOf(0f, 9.81f, 0f)
    private val linear = FloatArray(3)
    private val gyro = FloatArray(3)
    private var lastSentMs = 0L

    private val main = Handler(Looper.getMainLooper())
    private var lastHapticMs = 0L

    // Knock on the table (Knock.kt): the raw accelerometer at full speed, only while the phone lies face up, handled on
    // its own thread so the 50 Hz motion feed and the page never wait for it. Times are elapsedRealtime ms (the sensor clock).
    private val knockThread = HandlerThread("charm-knock").apply { start() }
    private val knockHandler = Handler(knockThread.looper)
    private val knocks = KnockDetector(if (BuildConfig.DEBUG) { line -> Log.d(TAG, line) } else null)
    private var knockOn = false // main thread only
    @Volatile private var touchAtMs = Long.MIN_VALUE / 2 // a finger or a key jolts the phone too
    @Volatile private var knockMuteUntilMs = Long.MIN_VALUE / 2 // our own buzz and voice shake the table
    @Volatile private var speaking = false
    private var knockRateStart = 0L // knock thread only: debug sample-rate log
    private var knockRateCount = 0
    private val knockListener = object : SensorEventListener {
        override fun onSensorChanged(e: SensorEvent) {
            val t = e.timestamp / 1_000_000
            knocks.touched(touchAtMs)
            knocks.mute(if (speaking) t + KNOCK_AFTER_BUZZ_MS else knockMuteUntilMs)
            val w = Math.sqrt((gyro[0] * gyro[0] + gyro[1] * gyro[1] + gyro[2] * gyro[2]).toDouble()).toFloat()
            when (knocks.push(t, e.values[0], e.values[1], e.values[2], w)) {
                KnockDetector.KNOCK -> toPage(
                    JSONObject().put("type", "knock").put("n", knocks.count).put("side", knocks.side?.wire ?: JSONObject.NULL)
                        .put("peak", Math.round(knocks.peak * 10) / 10.0),
                )
                KnockDetector.GROUP -> toPage(
                    JSONObject().put("type", "knocks").put("n", knocks.count).put("side", knocks.side?.wire ?: JSONObject.NULL),
                )
            }
            if (BuildConfig.DEBUG) {
                if (knockRateCount++ == 0) knockRateStart = t
                if (t - knockRateStart >= 10_000) {
                    Log.d(TAG, "hop knock sensor rate=${knockRateCount * 1000 / (t - knockRateStart)}Hz")
                    knockRateCount = 0
                }
            }
        }

        override fun onAccuracyChanged(sensor: Sensor, accuracy: Int) = Unit
    }

    /** The admin exit (3 s corner hold) turns Charm mode off until the corner is held again; remembered across restarts. */
    private val prefs by lazy { getSharedPreferences("charm", MODE_PRIVATE) }
    private var charmModeOff: Boolean
        get() = prefs.getBoolean("charm_mode_off", false)
        set(v) = prefs.edit().putBoolean("charm_mode_off", v).apply()

    private val pinned: Boolean
        get() = getSystemService(ActivityManager::class.java).lockTaskModeState != ActivityManager.LOCK_TASK_MODE_NONE
    private val buttons = ButtonShortcuts(onMic = { onMicCue(it) }) { onButton(it) }

    // Offline voice: Moonshine (ears), Needle (command picker), Kitten (mouth). All work runs on one background thread.
    // Proximity, light and battery: cheap, change-only events for the page's little reactions.
    private val extras by lazy { Extras(this) }
    // GPS fixes for the offline map; on only while the map is open or a question waits for a fix (battery and heat).
    private val gps by lazy { LocationFeed(this, ::toPage).also { it.onFix = ::onFix } }
    // What Val knows about its world (clock, sun, battery, light, GPS, satellites) for rule answers and the chat line.
    private val senses by lazy { Senses(this, extras, gps) }
    /** A senses question waiting for GPS (main thread only); a newer one replaces it. */
    private var senseWait: SenseWait? = null
    private val senseTimeout = Runnable { finishSense("timeout") }
    // The magnetometer for the metal detector mode, only while the page has it on.
    private val metal by lazy { MetalDetector(this) }
    private var metalWanted = false
    private val work = Executors.newSingleThreadExecutor { r ->
        // Background priority: speech and command picking must never steal frames from the robot.
        // Normal priority: the background cgroup pins speech onto the slow cores (measured: voice 2.4x slower than real time).
        Thread(r, "charm-work")
    }
    private lateinit var voice: Voice
    /** The fast offline mouth (Android's own voice); Kitten speaks until it is ready, or if it has no offline voice. */
    private lateinit var systemVoice: SystemVoice
    @Volatile private var speechEngine = SpeechEngine.SYSTEM
    private lateinit var brain: Brain
    private lateinit var vision: Vision
    private val cameraGate = CameraGate(this, ASSET_HOST)
    /** Dresden fact cards, read once (first used on the voice thread); null if the asset is broken. */
    private val facts: Facts? by lazy { cards("facts.json") }
    private val everyday: Facts? by lazy { cards("everyday.json") }

    private fun cards(name: String): Facts? =
        runCatching { Facts.parse(assets.open(name).bufferedReader().use { it.readText() }) }
            .onFailure { Log.w(TAG, "$name not loaded", it) }.getOrNull()
    /** The last photo's caption and frame, in memory only. */
    private val photo = PhotoMemory()
    /** The last few exchanges, in memory only, so follow-ups work ("when was it built?"); never logged as text. */
    private val memory = ConversationMemory()

    @SuppressLint("SetJavaScriptEnabled", "ClickableViewAccessibility")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        sensors = getSystemService(SensorManager::class.java)
        vibrator = getSystemService(Vibrator::class.java)

        val pageFiles = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG) // test builds: inspect the page from the Mac
        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true // notes, the timer and the voice setting live in localStorage (on the phone only)
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.mediaPlaybackRequiresUserGesture = false
            setBackgroundColor(android.graphics.Color.BLACK)
            webViewClient = object : WebViewClient() {
                // Bundled files only: anything else is refused, so the page can never reach the internet.
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                    pageFiles.shouldInterceptRequest(request.url)
                        ?: WebResourceResponse("text/plain", "utf-8", 403, "offline", emptyMap(), ByteArrayInputStream(ByteArray(0)))

                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) =
                    request.url.host != ASSET_HOST // never navigate away from the bundled page

                override fun onPageFinished(view: WebView, url: String) {
                    setBrightness(sleep = false) // never stay dimmed across a reload
                    openChannel()
                }

                // If the 3D renderer dies (out of memory on the old GPU), restart the activity instead of crashing.
                override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                    Log.e(TAG, "renderer gone (crash=${detail.didCrash()}), restarting")
                    recreate()
                    return true
                }
            }
            webChromeClient = object : WebChromeClient() {
                override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                    if (BuildConfig.DEBUG) Log.i(TAG, "page: ${m.message()}") // release builds never log page text
                    return true
                }

                // getUserMedia: only our own page, only the camera (CameraGate asks for the permission once).
                override fun onPermissionRequest(request: PermissionRequest) = cameraGate.onPermissionRequest(request)

                override fun onPermissionRequestCanceled(request: PermissionRequest) = cameraGate.onPermissionRequestCanceled(request)
            }
        }

        val exitCorner = View(this).apply { setOnTouchListener(::onExitCornerTouch) }
        val root = FrameLayout(this).apply {
            addView(webView)
            addView(exitCorner, FrameLayout.LayoutParams(dp(72), dp(72)))
        }
        setContentView(root)
        hideSystemBars()
        webView.loadUrl(pageUrl(intent))

        val models = File(getExternalFilesDir(null), "models")
        val tools = File(filesDir, "tools.json").also { f -> assets.open("tools.json").use { i -> f.outputStream().use { i.copyTo(it) } } }
        voice = Voice(models)
        voice.onLevel = ::onMicLevel
        systemVoice = SystemVoice(this) { !voice.listening }
        pickSpeechEngine(intent)
        pickEars(intent)
        brain = Brain(applicationInfo.nativeLibraryDir, models, tools)
        vision = Vision(applicationInfo.nativeLibraryDir, models) // the llama-server for photos and spoken answers
        Router.usePlaces { PlaceFix.fromAssets(assets) } // misheard place names (PlaceFix.kt): the map's names, read once
        background {
            voice.load(wantedStt())?.let { toPage(JSONObject().put("type", "voiceError").put("reason", it)) }
            brain.start()?.let { Log.w(TAG, it) }
            if (BuildConfig.DEBUG) Log.d(TAG, "facts loaded cards=${facts?.size ?: 0} everyday=${everyday?.size ?: 0}")
            vision.warm() // after the voice models, on its own low-priority thread: the first question needs no cold start
            senses.warm() // the map's place names, so the first "where are we" answers at once
            Router.warmPlaces().let { if (BuildConfig.DEBUG) Log.d(TAG, "places loaded names=$it") } // the first "take me to" needs no load
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        intent.getStringExtra(EXTRA_REPLAY)?.let(::replay)
        intent.removeExtra(EXTRA_REPLAY)
        intent.getStringExtra(EXTRA_VOICE_TEST)?.let(::voiceTest)
        intent.removeExtra(EXTRA_VOICE_TEST)
        intent.getStringExtra(EXTRA_ASK_TEST)?.let(::askTest)
        intent.removeExtra(EXTRA_ASK_TEST)
        pickSpeechEngine(intent)
        pickEars(intent)
        intent.getStringExtra(EXTRA_STT_TEST)?.let(::sttTest)
        intent.removeExtra(EXTRA_STT_TEST)
    }

    /** The speech-to-text engine to load: the default, or in debug builds the last `--es stt …` choice. */
    private fun wantedStt(): SttEngine =
        if (BuildConfig.DEBUG) SttEngine.fromWire(debugPrefs.getString(EXTRA_STT, null)) ?: SttEngine.DEFAULT else SttEngine.DEFAULT

    private val debugPrefs by lazy { getSharedPreferences("charm-debug", MODE_PRIVATE) }

    /**
     * Debug A/B hooks for the ears, remembered across restarts: `--es stt moonshine|whisper-tiny|whisper-base` loads
     * that engine (the old one is freed first), `--es mic comm|rec|raw` picks the microphone path.
     */
    private fun pickEars(intent: Intent) {
        if (!BuildConfig.DEBUG) return
        intent.getStringExtra(EXTRA_MIC)?.let { w ->
            intent.removeExtra(EXTRA_MIC)
            MicSource.fromWire(w)?.let { debugPrefs.edit().putString(EXTRA_MIC, it.wire).apply() }
        }
        voice.micSource = MicSource.fromWire(debugPrefs.getString(EXTRA_MIC, null)) ?: MicSource.COMM
        val stt = intent.getStringExtra(EXTRA_STT) ?: return
        intent.removeExtra(EXTRA_STT)
        val e = SttEngine.fromWire(stt) ?: return Unit.also { Log.w(TAG, "stt engine unknown: $stt") }
        debugPrefs.edit().putString(EXTRA_STT, e.wire).apply()
        if (voice.engine != null) background { voice.useEngine(e) } // at start, load() picks it up
    }

    /** Debug A/B hook: `--es tts kitten|system` picks Val's mouth until the next such intent. */
    private fun pickSpeechEngine(intent: Intent) {
        if (!BuildConfig.DEBUG) return
        val want = when (intent.getStringExtra(EXTRA_TTS)) {
            "kitten" -> SpeechEngine.KITTEN
            "system" -> SpeechEngine.SYSTEM
            else -> return
        }
        intent.removeExtra(EXTRA_TTS)
        speechEngine = want
        if (BuildConfig.DEBUG) Log.d(TAG, "tts engine set to ${want.name.lowercase()}")
    }

    /** Cut Val off on both mouths (any thread). */
    private fun stopSpeaking() {
        voice.stopSpeaking()
        systemVoice.stop()
    }

    override fun onResume() {
        super.onResume()
        keepAudible()
        hideSystemBars()
        for (type in intArrayOf(Sensor.TYPE_GRAVITY, Sensor.TYPE_LINEAR_ACCELERATION, Sensor.TYPE_GYROSCOPE)) {
            sensors.getDefaultSensor(type)?.let { sensors.registerListener(this, it, SensorManager.SENSOR_DELAY_GAME) }
                ?: Log.w(TAG, "sensor $type missing")
        }
        webView.onResume()
        extras.start(::toPage)
        gps.resume()
        if (metalWanted) metal.start(::toPage)
        // Test builds never pin themselves (a pinned app blocks reinstalls); use the corner hold to try Charm mode.
        // At most one automatic try per process: if the user declined the pin dialog, it does not come back on every
        // resume (the corner hold still pins on demand).
        if (shouldAutoPin(pinned, charmModeOff, BuildConfig.DEBUG, autoPinTried)) {
            autoPinTried = true
            runCatching { startLockTask() }
        }
    }

    override fun onPause() {
        if (voice.cancel()) toPage(JSONObject().put("type", "heard").put("text", "")) // never keep the mic open in the background
        setBrightness(sleep = false)
        sensors.unregisterListener(this)
        setKnockSensor(false)
        webView.onPause()
        extras.stop()
        gps.stop()
        metal.stop()
        super.onPause()
    }

    override fun onDestroy() {
        // recreate() is the out-of-memory recovery: free everything, or each restart loads another set of models.
        main.removeCallbacksAndMessages(null)
        port?.close()
        port = null
        voice.cancel()
        stopSpeaking()
        systemVoice.shutdown()
        brain.stop()
        vision.shutdown()
        work.execute { voice.release() } // after any decode still running, never under it
        work.shutdown()
        knockThread.quitSafely()
        webView.destroy()
        super.onDestroy()
    }

    override fun onSensorChanged(e: SensorEvent) {
        when (e.sensor.type) {
            Sensor.TYPE_GRAVITY -> {
                e.values.copyInto(gravity, endIndex = 3)
                // Listen for knocks only while lying face up (with a little hysteresis so it never flaps).
                setKnockSensor(gravity[2] > if (knockOn) KNOCK_FLAT_OFF else KNOCK_FLAT_ON)
            }
            Sensor.TYPE_LINEAR_ACCELERATION -> e.values.copyInto(linear, endIndex = 3)
            Sensor.TYPE_GYROSCOPE -> e.values.copyInto(gyro, endIndex = 3)
        }
        val now = SystemClock.uptimeMillis()
        if (now - lastSentMs < SEND_INTERVAL_MS) return
        lastSentMs = now
        port?.postMessage(WebMessageCompat(MotionMessage.encode(now, gravity, linear, gyro)))
    }

    override fun onAccuracyChanged(sensor: Sensor, accuracy: Int) = Unit

    /** The fast accelerometer for knocks: on only while the phone lies face up and Charm is in front. */
    private fun setKnockSensor(on: Boolean) {
        if (on == knockOn) return
        knockOn = on
        if (on) {
            val accel = sensors.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) ?: return
            sensors.registerListener(knockListener, accel, SensorManager.SENSOR_DELAY_FASTEST, knockHandler)
        } else {
            sensors.unregisterListener(knockListener)
            knockHandler.post { knocks.reset() } // a lifted phone forgets a half-finished group
        }
        if (BuildConfig.DEBUG) Log.d(TAG, "hop knock sensor ${if (on) "on" else "off"}")
    }

    /** Touches jolt the phone like a knock: remember when, so the detector ignores them. */
    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        when (ev.actionMasked) {
            MotionEvent.ACTION_DOWN, MotionEvent.ACTION_POINTER_DOWN, MotionEvent.ACTION_UP, MotionEvent.ACTION_POINTER_UP ->
                touchAtMs = SystemClock.elapsedRealtime()
        }
        return super.dispatchTouchEvent(ev)
    }

    /**
     * Volume-down ([DeviceProfile.Button]) is Charm's button (volume-up is broken on the reference phone, so only volume-down is used). Caught in dispatchKeyEvent,
     * before the WebView can take it, and consumed so no volume panel appears.
     */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.keyCode != DeviceProfile.CURRENT.button.keyCode) return super.dispatchKeyEvent(event)
        touchAtMs = SystemClock.elapsedRealtime() // pressing the key jolts the phone: not a knock
        when (event.action) {
            KeyEvent.ACTION_DOWN -> if (event.repeatCount == 0) {
                buttons.down(SystemClock.uptimeMillis())
                main.postDelayed({ buttons.tick(SystemClock.uptimeMillis()) }, HOLD_CHECK_MS)
            }
            KeyEvent.ACTION_UP -> {
                buttons.up(SystemClock.uptimeMillis())
                main.postDelayed({ buttons.tick(SystemClock.uptimeMillis()) }, COUNT_CHECK_MS) // ends a press count
                keepAudible() // the key is Charm's: it must never turn Val's voice down
            }
        }
        return true
    }

    private fun onButton(action: ButtonAction) {
        Log.i(TAG, "button ${action.wire}")
        toPage(JSONObject().put("type", "button").put("name", action.wire))
        when (action) {
            ButtonAction.TALK_START -> startTalking()
            ButtonAction.TALK_END -> finishTalking()
            ButtonAction.LOOK, ButtonAction.MAP, ButtonAction.METAL -> forget("feature") // the page opens a feature: a new topic
            ButtonAction.BACK -> Unit // the page closes what is open (camera, map, metal detector)
        }
    }

    /**
     * The mic pre-roll for the volume key: recording starts at key-down, so the first word is not lost while the hold
     * is confirmed; a short press drops it unheard. Not while Val speaks (the pre-roll would hear Val): then the clip
     * starts at the hold, as before.
     */
    private fun onMicCue(cue: MicCue) {
        when (cue) {
            MicCue.ARM -> {
                if (speaking || voice.listening) return
                if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return
                val armed = voice.startListening(live = false)
                if (BuildConfig.DEBUG) Log.d(TAG, "hop mic pre-roll armed=$armed")
            }
            MicCue.DROP -> if (voice.discard() && BuildConfig.DEBUG) Log.d(TAG, "hop mic pre-roll dropped (short press)")
        }
    }

    private fun startTalking() {
        if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(android.Manifest.permission.RECORD_AUDIO), REQ_MIC)
            return
        }
        stopSpeaking() // the mic must not hear Val's own voice
        val kept = voice.commit() // a volume-key hold keeps its pre-roll from key-down
        if (BuildConfig.DEBUG) Log.d(TAG, "hop mic start pre-roll=${if (kept) "kept" else "none"}")
        if (kept || voice.startListening()) toPage(JSONObject().put("type", "listening"))
        if (!vision.chatReady) vision.warm() // stopped for memory or idle: load it while the user is still talking
    }

    /** Ears → brain: transcribe, pick a command, hand both to the page (which acts it out and asks Val to speak). */
    private fun finishTalking() {
        // On the main thread, so a quick second press can never reuse this take; the mic records TAIL_MS more.
        val take = voice.finish(TAIL_MS) ?: return toPage(JSONObject().put("type", "heard").put("text", ""))
        background {
            val clip = take.await()
            if (clip.isEmpty()) return@background toPage(JSONObject().put("type", "heard").put("text", ""))
            if (BuildConfig.DEBUG) {
                val st = Clip.stats(clip, Voice.SAMPLE_RATE)
                Log.d(TAG, "hop mic peak=${"%.1f".format(st.peakDb)}dB rms=${"%.1f".format(st.rmsDb)}dB dur=${st.ms}ms src=${voice.micSource.wire}")
                saveClip(clip)
            }
            understand(clip)
        }
    }

    /**
     * Debug builds only: keep the last [Clip.RING] clips as 16 kHz WAV in the app's own `files/clips/` for the on-phone
     * speech-to-text bake-off (`--es sttTest …`). Never in release builds, never uploaded, never committed; they go
     * when the app is uninstalled or the folder is deleted.
     */
    private fun saveClip(clip: FloatArray) {
        if (!BuildConfig.DEBUG) return
        runCatching {
            val dir = File(getExternalFilesDir(null), "clips").apply { mkdirs() }
            val slot = Clip.ringSlot(List(Clip.RING) { i -> Clip.ringFile(dir, i).takeIf { it.isFile }?.lastModified() })
            Clip.ringFile(dir, slot).writeBytes(Clip.wav(clip, Voice.SAMPLE_RATE))
            Log.d(TAG, "hop mic clip saved slot=$slot")
        }.onFailure { Log.w(TAG, "clip not saved", it) }
    }

    /**
     * Debug test hook: `--es sttTest moonshine|whisper-tiny|whisper-base` re-transcribes every saved clip (oldest
     * first) with that engine, logs time and text per clip, then loads the usual engine again. Text is logged only
     * here, in debug builds, for the developer's own clips.
     */
    private fun sttTest(wire: String) {
        if (!BuildConfig.DEBUG) return
        val e = SttEngine.fromWire(wire) ?: return Unit.also { Log.w(TAG, "sttTest engine unknown: $wire") }
        background {
            val clips = File(getExternalFilesDir(null), "clips").listFiles { f -> f.name.matches(CLIP_NAME) }
                ?.sortedBy { it.lastModified() }.orEmpty()
            val back = wantedStt()
            voice.useEngine(e)?.let { Log.w(TAG, "stt engine=${e.wire} failed: $it") }
            val used = voice.engine?.wire ?: "none"
            var total = 0L
            for ((i, f) in clips.withIndex()) {
                val t0 = SystemClock.uptimeMillis()
                val text = voice.transcribeWav(f)
                val ms = SystemClock.uptimeMillis() - t0
                total += ms
                val dur = (f.length() - 44) / 2 * 1000 / Voice.SAMPLE_RATE
                Log.i(TAG, "stt engine=$used clip=$i dur=${dur}ms ms=$ms text=$text")
            }
            Log.i(TAG, "stt engine=$used clips=${clips.size} total=${total}ms")
            voice.useEngine(back)
        }
    }

    @Volatile private var utterance = 0

    private fun understand(clip: FloatArray) {
        val started = SystemClock.uptimeMillis()
        if (!voice.ready) return toPage(JSONObject().put("type", "voiceError").put("reason", "waking"))
        val heard = voice.transcribe(clip)
        utterance++ // a newer question makes every older answer stale
        if (BuildConfig.DEBUG) Log.d(TAG, "hop stt chars=${heard.length} ms=${SystemClock.uptimeMillis() - started}")
        toPage(JSONObject().put("type", "heard").put("text", heard))
        route(heard, started)
    }

    /**
     * Brain → page (Router.kt): keyword rules first, then Needle; an action goes to the page as "command", anything
     * else is answered by the chat model and goes to the page as "answer" (with "thinking" while it works).
     */
    private fun route(heard: String, started: Long) {
        val text = Router.normalize(heard)
        if (text.isBlank()) return sendCommand(Command("none", JSONObject(), 0.0), heard, started)
        // Conversation memory (ConversationMemory.kt): a short follow-up leans on the remembered subject.
        val recent = memory.recent(SystemClock.uptimeMillis())
        val topicTurn = recent.lastOrNull { it.topic != null }
        val topic = topicTurn?.topic
        val thing = topicTurn?.thing == true // a photo's thing is talked about, never walked to
        val followUp = recent.isNotEmpty() && ConversationMemory.isFollowUp(text)
        if (BuildConfig.DEBUG && recent.isNotEmpty()) Log.d(TAG, "hop memory turns=${recent.size} topic=${if (topic != null) "yes" else "no"} followup=${if (followUp) "yes" else "no"}")
        // "Take me there" after a place or a fact: walk to the remembered subject. Other rules never use memory.
        if (topic != null && !thing && ConversationMemory.isThere(text)) {
            val cmd = Router.navigateTo(topic)
            if (BuildConfig.DEBUG) Log.d(TAG, "hop memory there place=${if (cmd.args.has("confirm")) "unsure" else "yes"}")
            remember(heard, cmd)
            return sendCommand(cmd, heard, started)
        }
        val ruled = Router.rule(text)
        if (ruled?.name == "forget_context") {
            forget("asked")
            return sendCommand(ruled, heard, started)
        }
        // Fact cards (no model): Dresden first, then everyday answers. Rules always run first; a clear everyday
        // answer skips Needle too, so "why is the sky blue" can never be guessed into a photo or a dance.
        val card = if (ruled == null) lookupCards(text, if (followUp) topic else null) else null
        val carried = if (followUp) topic else null
        // A clear card (Dresden or everyday) is answered at once, without waiting ~1.5 s for the command model.
        if (card?.hit?.mode == Facts.Mode.DIRECT) {
            rememberTopic(heard, cardTopic(card), carried, thing)
            return cardAnswer(card, heard, started)
        }
        val cmd = ruled ?: Router.fixTimer(brain.pick(text), text) // the model's timer only knows minutes
        val via = when {
            ruled != null -> Router.Via.RULE
            Router.acts(cmd) -> Router.Via.NEEDLE
            else -> Router.Via.CHAT
        }
        if (BuildConfig.DEBUG) {
            val kind = if (cmd.name == "smalltalk") " kind=${cmd.args.optString("kind")}" else "" // a fixed label, never user words
            Log.d(TAG, "hop route=${via.name.lowercase()} cmd=${cmd.name}$kind conf=${"%.2f".format(java.util.Locale.ROOT, cmd.confidence)} ms=${SystemClock.uptimeMillis() - started}")
        }
        if (cmd.name in SenseFormat.COMMANDS) {
            remember(heard, topic = null)
            return senseAnswer(cmd, heard, started)
        }
        if (via != Router.Via.CHAT) {
            remember(heard, cmd, carried, thing)
            return sendCommand(cmd, heard, started)
        }

        rememberTopic(heard, card?.let(::cardTopic), carried, thing)
        val id = utterance
        val now = SystemClock.uptimeMillis()

        // The Polaroid is still up: ask the vision model about the same frame again.
        photo.frame(now)?.let { frame ->
            val warm = vision.chatReady && vision.chatModel == ServerModel.VISION
            if (BuildConfig.DEBUG) Log.d(TAG, "hop photo ask again warm=$warm")
            toPage(JSONObject().put("type", "thinking").put("warming", !warm).put("ms", PHOTO_ASK_MS))
            vision.describe(frame, VisionApi.askPrompt(heard)) { r ->
                val clean = if (r is VisionReply.Text) ChatApi.clean(r.text)?.let { VisionReply.Text(it, r.ms) } ?: VisionReply.Failed("empty answer") else r
                deliver(id, heard, started, clean, "photo")
            }
            return
        }

        val caption = photo.caption(now)
        val senseLine = runCatching { SenseFormat.chatLine(senses.snapshot()) }.getOrNull()
        val context = listOfNotNull(
            senseLine?.let(ChatApi::senseContext),
            caption?.let(ChatApi::photoContext),
            card?.let { ChatApi.factContext(it.hit.card.text) },
        )
        if (BuildConfig.DEBUG) {
            Log.d(TAG, "hop chat senseCtx=${if (senseLine != null) "yes" else "no"} photoCtx=${if (caption != null) "yes" else "no"} factCtx=${card?.source ?: "no"}")
        }
        // A follow-up gets the remembered turns (about 150 tokens at most, +0.3–0.5 s of prompt reading on the SD710).
        val pairs = if (followUp) ConversationMemory.chatTurns(recent) else emptyList()
        if (BuildConfig.DEBUG && pairs.isNotEmpty()) Log.d(TAG, "hop chat memory turns=${pairs.size} tokens≈${ConversationMemory.tokens(pairs)}")
        toPage(JSONObject().put("type", "thinking").put("warming", !vision.chatReady).put("ms", vision.chatModel.chatReadMs))
        vision.chat(heard, context, pairs, onReady = {
            if (id == utterance) toPage(JSONObject().put("type", "thinking").put("warming", false).put("ms", vision.chatModel.chatReadMs))
        }) { r -> deliver(id, heard, started, r, "chat") }
    }

    /**
     * The card for [text]; a follow-up with no card of its own ("when was it built") is looked up again with the
     * remembered [topic] added ("… frauenkirche"). A follow-up that names its own subject ("what about the Zwinger")
     * keeps its own card.
     */
    private fun lookupCards(text: String, topic: String?): Facts.Pick? {
        val own = lookupCards(text)
        if (own != null || topic == null) return own
        // "And Germany?" after "capital of France": a new subject, so the old card must not answer; the chat model
        // gets the remembered turns instead (seen on the phone: it answered France again).
        if (NEW_SUBJECT.containsMatchIn(text)) return null
        return lookupCards(ConversationMemory.withTopic(text, topic)).also {
            if (BuildConfig.DEBUG) Log.d(TAG, "hop memory card carry=${it?.hit?.card?.id ?: "none"}")
        }
    }

    /** The subject of a card for the memory (Facts.subject). */
    private fun cardTopic(card: Facts.Pick): String? =
        (if (card.source == Facts.DRESDEN) facts else everyday)?.subject(card.hit.card)

    /**
     * Starts a memory turn for [heard]. A command that opens a feature (camera, map, metal detector, trams) starts a
     * new topic first; a walk somewhere remembers the place, so "how tall is it" works there.
     */
    private fun remember(heard: String, cmd: Command, carried: String? = null, thing: Boolean = false) {
        if (cmd.name in OPENS_FEATURE) forget("feature")
        val place = when (cmd.name) {
            "navigate_to" -> cmd.args.optString("place")
            "transit" -> cmd.args.optString("dest").takeIf { it != "home" }
            else -> null
        }?.takeIf { it.isNotBlank() }
        if (place != null) remember(heard, place) else rememberTopic(heard, null, carried.takeIf { cmd.name !in OPENS_FEATURE }, thing)
    }

    /** A turn about its own subject ([own], from a card) or else the [carried] one, which keeps its photo [thing] mark. */
    private fun rememberTopic(heard: String, own: String?, carried: String?, thing: Boolean) =
        if (own != null) remember(heard, own) else remember(heard, carried, thing && carried != null)

    private fun remember(heard: String, topic: String?, thing: Boolean = false) {
        memory.record(heard, topic, SystemClock.uptimeMillis(), thing)
        if (BuildConfig.DEBUG) Log.d(TAG, "hop memory turn topic=${if (topic != null) "yes" else "no"}")
    }

    /** Val's reply joins the newest memory turn ([from]: native or page, for the log only). */
    private fun rememberSaid(text: String, from: String) {
        val kept = memory.said(text, SystemClock.uptimeMillis())
        if (BuildConfig.DEBUG) Log.d(TAG, "hop memory said from=$from kept=$kept")
    }

    /** Drops the conversation memory ("forget that", a feature opened). */
    private fun forget(why: String) {
        val n = memory.clear()
        if (BuildConfig.DEBUG && n > 0) Log.d(TAG, "hop memory cleared why=$why turns=$n")
    }

    /** Both card files looked up and one card chosen (Facts.choose); debug logs name each file's best card. */
    private fun lookupCards(text: String): Facts.Pick? {
        val dresden = facts?.lookup(text)
        val daily = everyday?.lookup(text)
        if (BuildConfig.DEBUG) {
            for ((hop, h) in listOf("facts" to dresden, "everyday" to daily)) {
                Log.d(TAG, "hop $hop hit=${h?.card?.id ?: "none"} score=${"%.2f".format(java.util.Locale.ROOT, h?.score ?: 0.0)} mode=${h?.mode?.name?.lowercase() ?: "none"}")
            }
        }
        return Facts.choose(dresden, daily)
    }

    /** A card said as it is: the page shows it with the FACT tag, no model involved. */
    private fun cardAnswer(card: Facts.Pick, heard: String, started: Long) {
        rememberSaid(card.hit.card.text, "native")
        toPage(
            JSONObject().put("type", "answer").put("text", heard).put("ok", true).put("reply", card.hit.card.text)
                .put("source", card.source).put("ms", SystemClock.uptimeMillis() - started),
        )
    }

    /** A model's answer → the page as "answer", unless the user already asked something newer. */
    private fun deliver(id: Int, heard: String, started: Long, r: VisionReply, source: String) {
        val ms = SystemClock.uptimeMillis() - started
        if (id != utterance) { // the user already asked something else: never answer the wrong question
            if (BuildConfig.DEBUG) Log.d(TAG, "hop $source dropped stale id=$id now=$utterance ms=$ms")
            return
        }
        val msg = JSONObject().put("type", "answer").put("text", heard).put("ms", ms).put("source", source)
        when (r) {
            is VisionReply.Text -> {
                msg.put("ok", true).put("reply", r.text)
                rememberSaid(r.text, "native")
            }
            // The one model is shared with photos: say which job keeps it busy.
            is VisionReply.Failed -> msg.put("ok", false).put("reason", if (r.reason == "busy") "busy ${vision.busyWith}" else r.reason)
        }
        if (BuildConfig.DEBUG) Log.d(TAG, "hop $source model=${vision.chatModel.name} ok=${r is VisionReply.Text} llm=${(r as? VisionReply.Text)?.ms} ms=$ms")
        else if (r is VisionReply.Failed) Log.w(TAG, "$source failed: ${r.reason}")
        toPage(msg)
    }

    private fun sendCommand(cmd: Command, heard: String, started: Long) = toPage(
        JSONObject().put("type", "command").put("name", cmd.name).put("args", cmd.args)
            .put("confidence", cmd.confidence).put("text", heard).put("ms", SystemClock.uptimeMillis() - started),
    )

    private class SenseWait(val id: Int, val cmd: Command, val heard: String, val started: Long, val needFix: Boolean)

    /**
     * A senses question (work thread): answered from the snapshot at once, or, when it needs GPS that is not fresh
     * (where are we, how high, how fast, how many satellites), after GPS runs for a while: up to [FIX_WAIT_MS] for a
     * fix ("let me look at the sky" goes out first), [SKY_WAIT_MS] for the satellite list.
     */
    private fun senseAnswer(cmd: Command, heard: String, started: Long) {
        val snap = senses.snapshot()
        val needs = SenseFormat.needsGps(cmd.name, snap)
        if (BuildConfig.DEBUG) Log.d(TAG, "hop senses cmd=${cmd.name} wait=${if (needs) "gps" else "no"} fix=${snap.fix?.ageS?.let { "${it}s" } ?: "none"} sky=${snap.sky?.total ?: "none"}")
        if (!needs) return sendSense(cmd, snap, heard, started, "now")
        val wait = SenseWait(utterance, cmd, heard, started, needFix = cmd.name != "sky")
        main.post { startSenseWait(wait) }
    }

    /** Main thread: switch GPS on for a waiting question, or answer at once when GPS cannot run. */
    private fun startSenseWait(w: SenseWait) {
        main.removeCallbacks(senseTimeout)
        senseWait = w
        val r = gps.want(GPS_ASK, true)
        if (BuildConfig.DEBUG) Log.d(TAG, "hop senses gps=${r.name.lowercase()}")
        when (r) {
            LocationFeed.Start.DENIED -> return finishSense("denied")
            LocationFeed.Start.GPS_OFF -> return finishSense("gpsOff")
            else -> Unit
        }
        if (w.needFix) sendCommand(Command(w.cmd.name, JSONObject().put("looking", true), 1.0), w.heard, w.started)
        main.postDelayed(senseTimeout, if (w.needFix) FIX_WAIT_MS else SKY_WAIT_MS)
    }

    /** Every live fix (main thread): a good one ends a waiting question at once. */
    private fun onFix(l: android.location.Location) {
        val w = senseWait ?: return
        if (w.needFix && l.hasAccuracy() && l.accuracy <= GOOD_FIX_M) finishSense("fix")
    }

    /** Main thread: the wait is over (a fix, the timeout, or no GPS at all); answer with what we know now. */
    private fun finishSense(why: String) {
        val w = senseWait ?: return
        senseWait = null
        main.removeCallbacks(senseTimeout)
        val sky = gps.sky // before GPS stops and forgets the satellites
        gps.want(GPS_ASK, false)
        background {
            if (w.id != utterance) {
                if (BuildConfig.DEBUG) Log.d(TAG, "hop senses dropped stale cmd=${w.cmd.name}")
                return@background
            }
            sendSense(w.cmd, senses.snapshot(sky), w.heard, w.started, why)
        }
    }

    /** The command with the snapshot's values filled in; the page turns them into words (assistant.ts). */
    private fun sendSense(cmd: Command, snap: Snapshot, heard: String, started: Long, why: String) {
        val args = SenseFormat.args(cmd.name, snap)
        cmd.args.keys().forEach { k -> if (!args.has(k)) args.put(k, cmd.args.get(k)) } // the rule's own args ("ask")
        if (why == "denied" || why == "gpsOff") args.put("reason", why)
        if (BuildConfig.DEBUG) Log.d(TAG, "hop senses done cmd=${cmd.name} why=$why near=${if (args.has("near")) "yes" else "no"} keys=${args.length()}")
        sendCommand(Command(cmd.name, args, 1.0), heard, started)
    }

    /** Debug test hook: `--es voiceTest <wav under the models folder>` runs ears → brain → page without a live voice. */
    private fun voiceTest(name: String) {
        if (!BuildConfig.DEBUG || !name.matches(Regex("[A-Za-z0-9_-]{1,36}\\.wav"))) return
        background {
            val started = SystemClock.uptimeMillis()
            val heard = voice.transcribeWav(File(File(getExternalFilesDir(null), "models"), name))
            utterance++
            Log.i(TAG, "voiceTest heard=${heard.length} chars stt=${SystemClock.uptimeMillis() - started}ms")
            toPage(JSONObject().put("type", "heard").put("text", heard))
            route(heard, started)
        }
    }

    /** Debug test hook: `--es askTest "<question>"` sends typed text through route → chat → page (no microphone). */
    private fun askTest(text: String) {
        if (!BuildConfig.DEBUG) return
        val q = text.take(MAX_SAY)
        background {
            val started = SystemClock.uptimeMillis()
            utterance++
            toPage(JSONObject().put("type", "heard").put("text", q))
            route(q, started)
        }
    }

    /** Voice work runs one task at a time on the background thread; a failure is logged, never fatal. */
    private fun background(task: () -> Unit) {
        if (work.isShutdown) return
        work.execute {
            try {
                task()
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
            } catch (e: Exception) {
                Log.e(TAG, "voice task failed", e)
                toPage(JSONObject().put("type", "voiceError").put("reason", "something went wrong"))
            }
        }
    }

    private var levelsSent = 0

    /** Mic level (mic thread, ≤15 Hz) → page, for the listening meter. Logged once a second, not per message. */
    private fun onMicLevel(v: Float) {
        if (BuildConfig.DEBUG && ++levelsSent % Voice.LEVEL_HZ == 0) Log.d(TAG, "mic level sent=$levelsSent v=${Math.round(v * 100)}%")
        toPage(JSONObject().put("type", "level").put("v", Math.round(v * 100) / 100.0))
    }

    /** Messages to the page, always on the main thread. */
    private fun toPage(json: JSONObject) {
        val text = json.toString()
        main.post {
            val p = port
            if (BuildConfig.DEBUG && json.optString("type") !in STREAMED) Log.d(TAG, "toPage ${json.optString("type")} port=${p != null}")
            p?.postMessage(WebMessageCompat(text))
        }
    }

    /** A private message channel to the page: motion goes in, haptics/screen requests come out. */
    private fun openChannel() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.CREATE_WEB_MESSAGE_CHANNEL) ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.POST_WEB_MESSAGE)
        ) {
            Log.e(TAG, "WebView too old for message channels")
            return
        }
        port?.close()
        val (mine, theirs) = WebViewCompat.createWebMessageChannel(webView)
        mine.setWebMessageCallback(object : WebMessagePortCompat.WebMessageCallbackCompat() {
            override fun onMessage(p: WebMessagePortCompat, message: WebMessageCompat?) {
                message?.data?.let(PageEvent::parse)?.let(::handle)
            }
        })
        port = mine
        WebViewCompat.postWebMessage(webView, WebMessageCompat("charm-port", arrayOf(theirs)), Uri.parse("https://$ASSET_HOST"))
        intent.getStringExtra(EXTRA_REPLAY)?.let { main.postDelayed({ replay(it) }, 2000) }
        intent.removeExtra(EXTRA_REPLAY) // replay once, not on every reload
        extras.stop() // a reloaded page gets the current states again
        extras.start(::toPage)
        metalWanted = false // a reloaded page starts with the metal detector closed
        metal.stop()
        gps.want(GPS_MAP, false) // … and with the map closed
    }

    private fun handle(e: PageEvent) {
        when (e) {
            is PageEvent.Haptic -> {
                val now = SystemClock.uptimeMillis()
                if (now - lastHapticMs >= MIN_HAPTIC_GAP_MS) { // a page bug can never buzz non-stop
                    lastHapticMs = now
                    knockMuteUntilMs = SystemClock.elapsedRealtime() + e.pattern.durationMs + KNOCK_AFTER_BUZZ_MS
                    vibrator.vibrate(e.pattern.effect())
                }
            }
            is PageEvent.Screen -> setBrightness(e.sleep)
            is PageEvent.Log -> Log.i(TAG, e.text)
            is PageEvent.Said -> rememberSaid(e.text, "page")
            is PageEvent.Say -> background {
                if (e.reply) rememberSaid(e.text, "page") // rule replies (timers, small talk) are only known here
                // "speaking" goes out when the first sample plays, never before: until then the page shows THINKING.
                val asked = SystemClock.uptimeMillis()
                var played = 0L
                speaking = true // the speaker shakes the table: no knocks while Val talks
                val onStart = { est: Long ->
                    if (BuildConfig.DEBUG) Log.d(TAG, "hop tts first-audio ms=${SystemClock.uptimeMillis() - asked} est=$est")
                    toPage(JSONObject().put("type", "speaking").put("ms", est))
                }
                val onChunk = { i: Int, text: String, ms: Long ->
                    toPage(JSONObject().put("type", "chunk").put("i", i).put("text", text).put("ms", ms))
                }
                val onWord = { i: Int, end: Int -> toPage(JSONObject().put("type", "word").put("i", i).put("end", end)) }
                try {
                    val system = speechEngine == SpeechEngine.SYSTEM && systemVoice.ready
                    if (BuildConfig.DEBUG) {
                        if (speechEngine == SpeechEngine.SYSTEM && !system) Log.d(TAG, "hop tts system voice not used: ${systemVoice.notReady}")
                        val name = if (system) systemVoice.voiceName else "kitten-${Voice.KITTEN_VOICE}"
                        Log.d(TAG, "hop tts engine=${if (system) "system" else "kitten"} voice=$name offline=true")
                    }
                    played = if (system) systemVoice.speak(e.text, onStart, onChunk, onWord) else voice.speak(e.text, onStart = onStart, onChunk = onChunk)
                } finally {
                    knockMuteUntilMs = SystemClock.elapsedRealtime() + KNOCK_AFTER_BUZZ_MS
                    speaking = false
                    if (BuildConfig.DEBUG) Log.d(TAG, "hop tts done total=${SystemClock.uptimeMillis() - asked} audio=$played")
                    // Always, also when speaking failed: the page must not stay on SPEAKING, and ok=false shows the text.
                    toPage(JSONObject().put("type", "spoken").put("ok", played > 0))
                }
            }
            is PageEvent.Gps -> {
                gps.want(GPS_MAP, e.on, explicit = true)
                if (BuildConfig.DEBUG) Log.d(TAG, "hop gps ${if (e.on) "on" else "off"}")
            }
            is PageEvent.Metal -> {
                metalWanted = e.on
                if (!e.on) metal.stop()
                val found = !e.on || metal.start(::toPage)
                if (!found) toPage(JSONObject().put("type", "magError").put("reason", "no sensor"))
                if (BuildConfig.DEBUG) Log.d(TAG, "hop metal ${if (e.on) "on" else "off"}${if (found) "" else " (no sensor)"}")
            }
            is PageEvent.Describe -> vision.describe(e.image, e.prompt) { r ->
                if (r is VisionReply.Text) {
                    Log.i(TAG, "vision ${r.ms} ms")
                    // Kept in memory only, for follow-up questions; the frame is dropped after PhotoMemory.FRAME_MS.
                    photo.remember(r.text, e.image, SystemClock.uptimeMillis())
                    main.postDelayed({ photo.expire(SystemClock.uptimeMillis()) }, PhotoMemory.FRAME_MS + 1_000)
                    // The photo's subject becomes the topic of the question that asked for it ("what is this").
                    val subject = ConversationMemory.captionSubject(r.text)
                    val kept = subject != null && memory.learnTopic(subject, SystemClock.uptimeMillis())
                    if (BuildConfig.DEBUG) Log.d(TAG, "hop memory photo topic=${if (subject != null) "yes" else "no"} kept=$kept")
                } else {
                    Log.w(TAG, "vision failed")
                }
                toPage(JSONObject(VisionMessage.encode(e.id, r)))
            }
            is PageEvent.Polaroid -> {
                photo.showing(e.on)
                if (BuildConfig.DEBUG) Log.d(TAG, "hop polaroid on=${e.on}")
            }
        }
    }

    /** Test mode (debug builds only): `adb shell am start -n …/.MainActivity --es replay shake` replays a motion trace. */
    private fun replay(name: String) {
        if (!BuildConfig.DEBUG || !name.matches(Regex("[A-Za-z]{1,20}"))) return
        webView.evaluateJavascript("window.charmReplay && window.charmReplay('$name')", null)
    }

    /**
     * The volume keys belong to Charm (and one is broken), so nobody can turn the sound up by hand: make sure
     * Val's voice is never muted. Only raises the media volume, never lowers it.
     */
    private fun keepAudible() {
        val audio = getSystemService(android.media.AudioManager::class.java) ?: return
        // Both voices play with USAGE_ASSISTANT. The assistant stream itself is hidden from apps, so raise the stream
        // the platform says controls that usage (STREAM_MUSIC on most phones), plus STREAM_MUSIC itself.
        val assistant = android.media.AudioAttributes.Builder().setUsage(android.media.AudioAttributes.USAGE_ASSISTANT).build()
        for (stream in setOf(android.media.AudioManager.STREAM_MUSIC, assistant.volumeControlStream)) {
            runCatching {
                val want = audio.getStreamMaxVolume(stream) * 3 / 4
                val now = audio.getStreamVolume(stream)
                if (now < want) {
                    audio.setStreamVolume(stream, want, 0)
                    if (BuildConfig.DEBUG) Log.d(TAG, "hop volume stream=$stream $now -> $want")
                }
            }
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<String>, grantResults: IntArray) {
        if (cameraGate.onRequestPermissionsResult(requestCode, grantResults)) return
        if (requestCode == LocationFeed.REQUEST_CODE) {
            if (gps.hasPermission) gps.resume()
            else {
                gps.denied() // before onResume, which would otherwise report the refusal again
                toPage(JSONObject().put("type", "fixError").put("reason", "denied"))
                finishSense("denied")
            }
        }
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    }

    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        // Give the vision model's RAM back only under real pressure; screen-off (UI_HIDDEN) keeps the warm model.
        if (trimFreesVision(level)) vision.stop()
    }

    private var exitHold: Runnable? = null

    private fun onExitCornerTouch(v: View, e: MotionEvent): Boolean {
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                exitHold = Runnable { toggleCharmMode() }.also { main.postDelayed(it, EXIT_HOLD_MS) }
                return true
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> exitHold?.let(main::removeCallbacks)
        }
        return false
    }

    private fun toggleCharmMode() {
        vibrator.vibrate(HapticPattern.BUMP.effect())
        if (pinned || !charmModeOff) {
            charmModeOff = true
            runCatching { stopLockTask() }
            Toast.makeText(this, "Charm mode off (hold the corner again to turn it on)", Toast.LENGTH_LONG).show()
        } else {
            charmModeOff = false
            runCatching { startLockTask() }
            Toast.makeText(this, "Charm mode on", Toast.LENGTH_SHORT).show()
        }
    }

    private fun setBrightness(sleep: Boolean) {
        window.attributes = window.attributes.apply {
            screenBrightness = if (sleep) 0.02f else WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
        }
    }

    private fun hideSystemBars() {
        window.insetsController?.apply {
            hide(WindowInsets.Type.systemBars())
            systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    private fun pageUrl(intent: Intent): String {
        val debug = if (BuildConfig.DEBUG && intent.getBooleanExtra(EXTRA_DEBUG, false)) "?debug=1" else ""
        return "https://$ASSET_HOST/assets/charm/index.html$debug"
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    companion object {
        private const val TAG = "Charm"
        private const val ASSET_HOST = "appassets.androidplatform.net"
        /** One automatic pin try per process (survives recreate()); see [shouldAutoPin]. Main thread only. */
        private var autoPinTried = false
        private const val SEND_INTERVAL_MS = 20L // 50 Hz to the page
        private const val EXIT_HOLD_MS = 3000L
        private val HOLD_CHECK_MS = DeviceProfile.CURRENT.button.holdMs + 10 // just after a press becomes a hold
        private val NEW_SUBJECT = Regex("^(?:and|what about|how about|and what about) (?!it\\b|that\\b|this\\b|there\\b|them\\b)\\S+")
        private val COUNT_CHECK_MS = DeviceProfile.CURRENT.button.gapMs + 20 // just after a press count ends
        private const val MIN_HAPTIC_GAP_MS = 80L
        private val KNOCK_FLAT_ON = DeviceProfile.CURRENT.sensors.knockListenOnZ // gravity z (m/s²) to start listening for knocks …
        private val KNOCK_FLAT_OFF = DeviceProfile.CURRENT.sensors.knockListenOffZ // … and to stop
        private const val KNOCK_AFTER_BUZZ_MS = 250L // the table settles after our own buzz or voice
        private const val REQ_MIC = 7
        /** How long the page waits for a question about the last photo (image tokens are usually cached by then). */
        private const val PHOTO_ASK_MS = 20_000
        /** Streams with their own once-a-second log line (mic level, magnetometer), not one per message. */
        private val STREAMED = setOf("level", "mag", "sky")
        /** Commands that open a feature (camera, map, metal detector, trams): the conversation starts a new topic. */
        private val OPENS_FEATURE = setOf("take_photo", "describe_photo", "where_am_i", "navigate_to", "transit", "next_departure", "metal")
        /** Who wants GPS (LocationFeed.want): the open map, and a senses question waiting for a fix. */
        private const val GPS_MAP = "map"
        private const val GPS_ASK = "ask"
        /** How long a question waits for a fix, and for the satellite list. */
        private const val FIX_WAIT_MS = 60_000L
        private const val SKY_WAIT_MS = 4_000L
        /** A fix this good ends the wait at once. */
        private const val GOOD_FIX_M = 100f
        const val EXTRA_REPLAY = "replay"
        const val EXTRA_DEBUG = "debug"
        const val EXTRA_VOICE_TEST = "voiceTest"
        const val EXTRA_ASK_TEST = "askTest"
        const val EXTRA_TTS = "tts"
        const val EXTRA_STT = "stt"
        const val EXTRA_MIC = "mic"
        const val EXTRA_STT_TEST = "sttTest"
        /** The mic keeps recording this long after the release (people let go while finishing the last word). */
        private const val TAIL_MS = 300L
        private val CLIP_NAME = Regex("clip-\\d+\\.wav")
    }
}

/** Release builds pin themselves once per process, unless already pinned or Charm mode is off (pure, for tests). */
internal fun shouldAutoPin(pinned: Boolean, charmModeOff: Boolean, debug: Boolean, tried: Boolean): Boolean =
    !pinned && !charmModeOff && !debug && !tried

/** Trim levels that free the vision model: real memory pressure only, never UI_HIDDEN or BACKGROUND (pure). */
internal fun trimFreesVision(level: Int): Boolean =
    level == ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW ||
        level == ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL ||
        level >= ComponentCallbacks2.TRIM_MEMORY_MODERATE
