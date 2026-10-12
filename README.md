# Val

your own little companion robot, living inside an old Android phone. no wifi, no SIM, no cloud. nothing leaves the phone (ﾉ◕ヮ◕)ﾉ*

Val is a tiny pink 3D robot that *is* the whole phone: you unlock it and Val is just there, floating on a true-black screen. tilt the phone and Val slides, hold the button and talk to it, point the camera at something and ask "what is this?". every model runs on the phone itself, in airplane mode, and the small models can be wrong, so treat Val as a friend, not an oracle.

(in the code the app is called **Charm**, so you will see that name in package names and scripts.)

## What it does

- **a character that feels alive.** Val slides downhill when you tilt the phone, falls to the other end when you flip it, moves onto a side edge after you hold it sideways for 5 s, and tumbles when you shake it. poke, tap, double tap, carry it around with a long press.
- **one button for everything.** hold volume-down to talk, let go and Val answers out loud. 1 press closes the camera or map, 2 presses open the camera, 3 the map, 4 or more presses, the metal detector.
- **questions.** about 100 hand-written fact cards for Dresden (an example city pack) and about 190 everyday answers are checked first. the phone's own senses answer time, date, battery, place and satellites. everything else goes to a small on-phone chat model.
- **"what is this?"** a retro viewfinder and shutter. a small vision model describes the photo on a tap-to-reveal Polaroid, and you can ask follow-up questions.
- **an offline city map** (Dresden by default) with GPS straight from the chip, place search, walking routes, and tram and bus trips from a bundled timetable (next departures, planned journeys, "take me home").
- **senses.** knock on the table and Val notices. a metal detector (magnetometer). peekaboo when you cover the top of the phone. sleepy in the dark, sunglasses in bright light.
- **a timer** that counts down around the edge of the screen.
- **little easter eggs.** dance, flip a coin, roll a dice, sunrise, sunset and moon phase, notes Val remembers for you, and more to find (˶ᵔ ᵕ ᵔ˶)

## How it works

you hold volume-down and talk. then, cheapest answer first:

1. **speech to text:** Moonshine base (Moonshine tiny as fallback), running in the app through sherpa-onnx.
2. **keyword rules** catch fixed phrases right away.
3. **fact cards, everyday answers and the phone's senses** (time, battery, place, satellites). most questions stop here.
4. **Needle** picks a command, but only if it is at least 0.9 sure. Needle 3 is a 35 MB function-calling model, fine-tuned with LoRA (a small add-on trained on top of the model) on our own commands.
5. **LFM2.5-VL-450M** answers everything else, and describes photos. llama.cpp's `llama-server` runs it only on the phone itself (127.0.0.1).

then Val acts it out (three.js in a WebView) and the phone's own offline voice speaks, with the text typed in sync. Kitten nano is the bundled fallback voice.

- **the app:** a Kotlin shell with a full-screen WebView. the three.js page loads from the app's own assets, and the app refuses every request that is not local.
- **kiosk:** Charm becomes the home screen when you pick it in Settings → Apps → Default apps → Home app, or when you run `sh scripts/charm-mode.sh on` (see Charm mode below). release builds then pin themselves to the screen. a 3 s hold in the top-left corner turns that off and on again.

## Adapting it to your phone

we tuned Val for a 2019 mid-range phone (Snapdragon 710, 4 GB RAM, Android 11). other phones need the profile adjusted.

- **`android/app/src/main/java/io/github/haardhikk/charm/DeviceProfile.kt`** holds every phone-specific knob: threads, model files, timeouts, the button, and sensor thresholds. `DeviceProfile.REALME_3_PRO` is the tuned reference. copy it, change what differs, and point `CURRENT` at your copy.
- **`web/src/device.ts`** has the page's knobs: pixel-ratio cap, idle frame rate, map pre-warm delay.
- **`web/build.mjs`** compiles the page for `chrome94` (the reference phone's WebView). raise it if your WebView is newer.
- **`scripts/prepare-phone.sh`** pushes the model files. the file names must match `DeviceProfile`.
- **the button:** `DeviceProfile.Button.keyCode` is volume-down because volume-up is broken on the reference phone.

### Swap the models

every model is a swappable part. a weaker phone can take a lighter one, a stronger phone a bigger one. the file names live in `DeviceProfile.models`, and `scripts/prepare-phone.sh` pushes the files, so you change both. then measure on the phone.

| Job | What Val uses now | Lighter, for a weaker phone | Bigger, for a stronger phone | What to change |
|---|---|---|---|---|
| speech to text | Moonshine base (sherpa-onnx) | Moonshine tiny (already the fallback) | a Whisper model for sherpa-onnx (tiny and base entries exist; see things we tried) | `models.stt`, an entry in the `SttEngine` enum (`SttEngine.kt`); a new model family also needs its config in `Voice.kt`. for Whisper, also remove the line in `scripts/prepare-phone.sh` that deletes `whisper-tiny/` and `whisper-base/` on the phone, and push the files `SttEngine` names |
| commands | Needle 3, fine-tuned on our commands | the base Needle 3 (same 35 MB, no training) | no need: it is tiny already | `needleTuned` / `needleBase`; train your own with `scripts/train-needle.sh` |
| chat and photos | LFM2.5-VL-450M (Q4_K_M) plus its projector | the same model with fewer image tokens (`llmImageMaxTokens`) and a smaller context | LFM2.5-VL-1.6B (`LiquidAI/LFM2.5-VL-1.6B-GGUF`), or another vision model that llama.cpp supports (for example Qwen2.5-VL 3B), with its mmproj file | `visionModel`, `visionProjector`; a text-only chat model goes in `chatModel1_2b`. bigger models need more RAM and longer timeouts (`chatReadMs`, `photoBudgetMs`) |
| voice | the phone's own offline text-to-speech | the same (it is the fastest) | another sherpa-onnx voice (VITS, Kokoro) as the fallback | the phone's text-to-speech settings; another sherpa-onnx voice needs its config in `Voice.kt` |

any GGUF model that `llama-server` runs works for chat and photos, as long as it fits in RAM next to the rest.

### Adapting it to your city

the map, places, footpaths and timetable are **not** in the repo. everyone downloads and builds their own with the commands in Setup step 3. Dresden is just the default example. to use another city, change:

- the `Region` blocks at the top of `scripts/build-map-data.py` and `scripts/build-transit.py` (the OSM extract, the GTFS feed, the bounding box and the timezone);
- `MODE_COLORS` in `scripts/build-transit.py` (the line colours, optional);
- the default stop of the self-check (`--stop Postplatz`) in `scripts/check-transit.py`;
- the page's map constants: `TILES` and `BOUNDS` in `web/src/map/view.ts`, and the well-known sights in the place search, `web/src/map/search.ts`;
- the timezone (`Europe/Berlin`) in `web/src/transit/raptor.ts`;
- the place-name repair (well-known names, aliases, misheard "Dresden") in `android/app/src/main/java/io/github/haardhikk/charm/PlaceFix.kt`;
- the position used when there is no GPS fix: `DRESDEN` in `web/src/delight/sun.ts`, and `DRESDEN_LAT`, `DRESDEN_LON` plus the geoid height offset (`DRESDEN_GEOID_M`) in `Senses.kt`;
- `earthFieldUt` in `DeviceProfile` (the local magnetic field, for the metal detector);
- Val's persona: `SYSTEM` in `Chat.kt` ("living offline in a phone in Dresden", "offline Dresden map") and Val's fixed lines in `web/src/assistant.ts` ("I'm from Dresden!", "made in Dresden", "my Dresden map");
- the fact cards: `android/app/src/main/assets/facts.json` is an example city pack for Dresden. replace it with cards for your city in the same format (`id`, `keys`, optional `also`, `text`, `src`), and keep the `val-*` cards, which are about Val, not the city.

## How it was tuned for the reference phone

the reference phone has a Snapdragon 710 (8 cores: 2 big, 6 little), 4 GB RAM and Android 11. the goal was simple: it must never feel slow.

- **cheapest answer first.** keyword rules, fact cards and the phone's senses answer before any model runs. the command model acts only when it is sure.
- **2 threads per model.** llama.cpp, Needle, speech to text and the fallback voice each use 2 threads. the chat/vision server also runs at nice 8 (a lower CPU priority), below the UI but not low enough for Android to push it onto the little cores. the character stays smooth on what is left.
- **the phone's own voice.** Android's built-in offline voice starts in about 0.25 s. the bundled neural voice took 4 to 6 s, so Kitten is only the fallback now.
- **Moonshine base for speech to text:** 0.4 to 0.7 s per sentence.
- **prompt-cache checkpoints.** LFM2 is a hybrid model, so a cached prompt can only be resumed at a saved checkpoint. `--checkpoint-min-step 64` lets llama.cpp reuse the shared instructions. without it, most questions re-read about 450 tokens, which took over 10 s on the phone.
- **the big model sleeps.** the chat/vision server is stopped after 10 min idle or when Android is short on memory, and it warms up again as soon as you press to talk.
- **a light page.** 30 fps when nothing moves, pixel ratio capped at 1.5, shader warm-up in small idle steps, the map pre-warmed only when the phone is calm, and the place-search index built in short idle slices.
- **small APK.** the llama.cpp binaries are stripped (`scripts/strip-elf.py`).

### Tips

- start from `DeviceProfile.REALME_3_PRO` and change one thing at a time.
- measure on your phone, not on your laptop. `adb logcat` shows the timings.
- keep the thread counts low. the character needs cores too.
- check that your phone has an offline text-to-speech voice installed (Settings → text-to-speech). without one, Val falls back to Kitten, which is much slower.
- test everything in airplane mode.

### Things we tried

- **FM radio and emergency alerts:** there is no API for them without root on this phone, so we dropped them.
- **Whisper** for speech to text: it looped on real clips, so we use Moonshine. the Whisper entries stay in `SttEngine` for comparison.
- **the 1.2B chat model** (LFM2.5-1.2B-Instruct): too slow on this chip, so the 450M vision model also answers chat. to try it anyway, download `LFM2.5-1.2B-Instruct-Q4_K_M.gguf` from Hugging Face `LiquidAI/LFM2.5-1.2B-Instruct-GGUF` into `.cache/models/llm/` and run `CHARM_CHAT=1.2b sh scripts/prepare-phone.sh`. the app uses it for chat whenever the file is on the phone.
- **real kiosk mode (device owner):** the phone's vendor refuses it, so Charm is the home screen plus screen pinning instead.

### Future scope

- stay offline by default. internet could become an opt-in later, but local-first stays the goal.
- an e-ink display, either from old phone hardware or as a module we build ourselves.
- phones with more sensors (LiDAR, NFC): use them. for example, tap two phones together over NFC to pair, then talk to each other over Bluetooth like a walkie-talkie.
- a small robot body: a two-servo neck the phone sits on, or wheels.
- a compass mode ("point me home").

## Setup

everything installs inside the repo, under `.cache/` and `.venv/`. nothing is installed globally, and none of the downloads go into git.

### Requirements

- a Mac (the commands below use the macOS JDK layout; on Linux, put a JDK 17 at `.cache/jdk` and adjust `JAVA_HOME` in `scripts/env.sh`);
- Node.js 22 or newer (tested with 24) and Python 3.12;
- an Android phone, arm64, Android 11 (API 30) or newer, with developer options and USB or wireless debugging on.

### 1. Toolchain

| What | Version | Source | Goes to |
|---|---|---|---|
| JDK | Temurin 17 | adoptium.net | `.cache/jdk/` (so that `.cache/jdk/Contents/Home/bin/java` exists) |
| Android command-line tools | latest | developer.android.com/studio#command-tools | `.cache/android/cmdline-tools/latest/` |
| Android SDK packages | `platform-tools`, `platforms;android-35`, `build-tools;35.0.0`, `build-tools;34.0.0` (some Gradle tasks fetch it) | `sdkmanager` | `.cache/android/` |
| Gradle | 8.11.1 | the wrapper downloads it | `.cache/gradle/` |
| osmium (Python) | 4.0.2 | PyPI | `.venv/` |

the two downloads need a little unpacking:

- **JDK:** unpack the Temurin 17 `.tar.gz` into `.cache/`, then rename the `jdk-17…` folder to `.cache/jdk`.
- **command-line tools:** unzip them into `.cache/android/cmdline-tools`, then rename the `cmdline-tools` folder inside to `latest`.

```bash
mkdir -p .cache/android/cmdline-tools
tar -xzf ~/Downloads/OpenJDK17U-jdk_*_mac_hotspot_*.tar.gz -C .cache && mv .cache/jdk-17* .cache/jdk
unzip -q ~/Downloads/commandlinetools-mac-*_latest.zip -d .cache/android/cmdline-tools && mv .cache/android/cmdline-tools/cmdline-tools .cache/android/cmdline-tools/latest
. scripts/env.sh
yes | sdkmanager --sdk_root="$ANDROID_HOME" --licenses
sdkmanager --sdk_root="$ANDROID_HOME" "platform-tools" "platforms;android-35" "build-tools;35.0.0" "build-tools;34.0.0"
python3 -m venv .venv
.venv/bin/python -m pip install "osmium==4.0.2"
```

### 2. Models and runtimes

| What | Version | Source | Goes to |
|---|---|---|---|
| sherpa-onnx Android AAR | 1.13.8 | `https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-1.13.8.aar` | `.cache/runtimes/sherpa-onnx-1.13.8.aar` |
| Moonshine base (English, int8) | 2026-02-27 | `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-moonshine-base-en-quantized-2026-02-27.tar.bz2` | `.cache/models/stt/sherpa-onnx-moonshine-base-en-quantized-2026-02-27/` |
| Moonshine tiny (English, int8) | 2026-02-27 | `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27.tar.bz2` | `.cache/models/stt/sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27/` |
| Kitten nano (English, int8) | v0.8 | `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kitten-nano-en-v0_8-int8.tar.bz2` | `.cache/models/tts/kitten-nano-en-v0_8-int8/` |
| Needle 3 model and Android engine | revision `93e88ede867e4311c39151285e74df513e4b835b` | Hugging Face `Cactus-Compute/needle3`: `needle3.cact`, `android-arm64/needle` | `.cache/models/cmd/needle3.cact`, `.cache/models/cmd/android-arm64/needle` |
| llama.cpp Android binaries | b11541 | `https://github.com/ggml-org/llama.cpp/releases/download/b11541/llama-b11541-bin-android-arm64.tar.gz` | `.cache/downloads/llama/` (keep it packed) |
| LFM2.5-VL-450M (Q4_K_M) and its projector (Q8_0) | `main` | Hugging Face `LiquidAI/LFM2.5-VL-450M-GGUF`: `LFM2.5-VL-450M-Q4_K_M.gguf`, `mmproj-LFM2.5-VL-450m-Q8_0.gguf` | `.cache/models/vlm/` |

```bash
GH=https://github.com
HF=https://huggingface.co
mkdir -p .cache/runtimes .cache/models/stt .cache/models/tts .cache/models/cmd/android-arm64 .cache/models/vlm .cache/downloads/llama
curl -L -o .cache/runtimes/sherpa-onnx-1.13.8.aar $GH/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-1.13.8.aar
curl -L $GH/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-moonshine-base-en-quantized-2026-02-27.tar.bz2 | tar -xjf - -C .cache/models/stt
curl -L $GH/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27.tar.bz2 | tar -xjf - -C .cache/models/stt
curl -L $GH/k2-fsa/sherpa-onnx/releases/download/tts-models/kitten-nano-en-v0_8-int8.tar.bz2 | tar -xjf - -C .cache/models/tts
NEEDLE=$HF/Cactus-Compute/needle3/resolve/93e88ede867e4311c39151285e74df513e4b835b
curl -L -o .cache/models/cmd/needle3.cact $NEEDLE/needle3.cact
curl -L -o .cache/models/cmd/android-arm64/needle $NEEDLE/android-arm64/needle
curl -L -o .cache/downloads/llama/llama-b11541-bin-android-arm64.tar.gz $GH/ggml-org/llama.cpp/releases/download/b11541/llama-b11541-bin-android-arm64.tar.gz
curl -L -o .cache/models/vlm/LFM2.5-VL-450M-Q4_K_M.gguf $HF/LiquidAI/LFM2.5-VL-450M-GGUF/resolve/main/LFM2.5-VL-450M-Q4_K_M.gguf
curl -L -o .cache/models/vlm/mmproj-LFM2.5-VL-450m-Q8_0.gguf $HF/LiquidAI/LFM2.5-VL-450M-GGUF/resolve/main/mmproj-LFM2.5-VL-450m-Q8_0.gguf
```

### 3. Map and timetable data

none of this is in the repo: you download it and build your own. the commands below fetch Dresden, the default example. for another city, change the `Region` blocks first (see Adapting it to your city).

| What | Source | Goes to |
|---|---|---|
| vector tiles, z0 to z15, bbox `13.57,50.96,13.97,51.18` | a Protomaps daily basemap build (we used 2026-10-09), cut with `pmtiles` (go-pmtiles 1.31.2) | `.cache/downloads/map/dresden.pmtiles` (about 26 MB) |
| OSM extract for places and footpaths | BBBike: `https://download.bbbike.org/osm/bbbike/Dresden/Dresden.osm.pbf` | `.cache/downloads/map/Dresden.osm.pbf` |
| tram and bus timetable (VVO area GTFS) | `https://github.com/kiliankoe/vvo/releases/latest/download/vvo-gtfs.zip` | `.cache/downloads/transit/vvo-gtfs.zip` |
| Noto Sans Regular and Medium glyphs, ranges `0-255`, `256-511`, `8192-8447` | `https://github.com/protomaps/basemaps-assets` (`fonts/`) | `.cache/downloads/map/assets/fonts/Noto Sans Regular/`, `.../Noto Sans Medium/` |
| dark sprites `dark.json`, `dark.png`, `dark@2x.json`, `dark@2x.png` | `https://github.com/protomaps/basemaps-assets` (`sprites/v4/`) | `.cache/downloads/map/assets/sprites/v4/` |

```bash
mkdir -p .cache/tools .cache/downloads/map/assets/sprites/v4 .cache/downloads/transit
# pmtiles CLI (Apple silicon build shown; pick yours from the go-pmtiles 1.31.2 release)
curl -L -o .cache/tools/pmtiles.zip https://github.com/protomaps/go-pmtiles/releases/download/v1.31.2/go-pmtiles-1.31.2_Darwin_arm64.zip
unzip -o .cache/tools/pmtiles.zip pmtiles -d .cache/tools && rm .cache/tools/pmtiles.zip
# Pick a current build date from https://maps.protomaps.com/builds/ (daily builds are kept for a short time)
.cache/tools/pmtiles extract https://build.protomaps.com/<YYYYMMDD>.pmtiles .cache/downloads/map/dresden.pmtiles \
  --bbox=13.57,50.96,13.97,51.18 --maxzoom=15
curl -L -o .cache/downloads/map/Dresden.osm.pbf https://download.bbbike.org/osm/bbbike/Dresden/Dresden.osm.pbf
curl -L -o .cache/downloads/transit/vvo-gtfs.zip https://github.com/kiliankoe/vvo/releases/latest/download/vvo-gtfs.zip
ASSETS=https://github.com/protomaps/basemaps-assets/raw/main
for font in "Noto Sans Regular" "Noto Sans Medium"; do
  mkdir -p ".cache/downloads/map/assets/fonts/$font"
  for r in 0-255 256-511 8192-8447; do
    curl -L -o ".cache/downloads/map/assets/fonts/$font/$r.pbf" "$ASSETS/fonts/$(echo "$font" | sed 's/ /%20/g')/$r.pbf"
  done
done
for f in dark.json dark.png dark@2x.json dark@2x.png; do
  curl -L -o .cache/downloads/map/assets/sprites/v4/$f $ASSETS/sprites/v4/$f
done
```

### 4. Build and install

```bash
# every new shell: point the tools at .cache/
. scripts/env.sh
# offline places, footpaths and timetable (the timetable covers 14 days starting the day before you build it; --date YYYYMMDD to pick)
# run these before the page build: without them the map is empty (the build only warns)
.venv/bin/python -I scripts/build-map-data.py
.venv/bin/python -I scripts/build-transit.py
.venv/bin/python -I scripts/check-transit.py      # quick self-check: next departures from Postplatz
# the page: install, test, bundle into the app's assets
npm --prefix web ci && npm --prefix web test && npm --prefix web run build
# connect the phone (USB, or wireless debugging: Developer options → Wireless debugging → Pair device with pairing code)
adb pair <ip:pairing-port> <code> && adb connect <ip:port>
# native helpers into the APK, model files onto the phone
sh scripts/prepare-phone.sh
# build and install (installRelease pins itself as a kiosk; installDebug never does)
(cd android && ./gradlew installDebug)
```

tests: `npm --prefix web test`, `npm --prefix web run typecheck`, `(cd android && ./gradlew :app:testDebugUnitTest :app:lintDebug)`.

the release build is signed with the local debug key, so `installRelease` works on a test phone. it is not meant for a store.

debug builds keep the last 10 voice clips on the phone, for testing speech to text. use `installRelease` for everyday use, or delete them with `adb shell rm -r /sdcard/Android/data/io.github.haardhikk.charm/files/clips`.

### Optional script variables

| Variable | Used by | What it does |
|---|---|---|
| `ADB_SERIAL` | `prepare-phone.sh`, `charm-mode.sh` | picks a phone when more than one is connected |
| `CHARM_NEEDLE=val` | `prepare-phone.sh` | also pushes your fine-tuned command model (`needle3-val.cact`, see below), which the app then prefers |
| `STRIP=0` | `prepare-phone.sh` | keeps llama.cpp's debug info (about 170 MB more in the APK) |
| `CHARM_CACHE` | `web/build.mjs`, the web tests | where the cache with the map data lives, seen from `web/` (default `../.cache`) |
| `CHARM_MAP_DERIVED` | the web tests | the folder with the built map and timetable data (default `$CHARM_CACHE/downloads/map/derived`); the tests on real data are skipped when it is empty |
| `NEEDLE_ROWS` | `train-needle.sh` | the folder with your own training rows (default `.cache/needle/rows`) |

## Optional extras

### Fine-tune Needle on your own commands

we fine-tuned Needle with LoRA on our own commands. our rows and our tuned model are not in the repo, but the kit is, so you can train on yours. it runs on an Apple-silicon Mac (about 40 min for ~1,200 rows). the script installs its pinned kit (`cactus-needle[train]==3.2.0`, `mlx==0.29.3`) into `.venv`, trains a LoRA adapter on your rows, merges it, and scores the base and the tuned model on your held-out rows.

put your rows in `.cache/needle/rows/` (or point `NEEDLE_ROWS` at another folder), one JSON object per line:

| File | Needed | What |
|---|---|---|
| `train.jsonl` | yes | the training rows |
| `test.jsonl` | yes | held-out rows for scoring, never seen in training |
| `calib.jsonl` | no | fresh rows to fit the confidence score on (else `train.jsonl` is reused) |
| `test-rules.jsonl` | no | questions the app answers by its own rules: Needle must answer or stay out, never act |

each row has the `query` (what was said, as speech to text writes it) and the `answers` (the tool call, or `[]` for chatter that should not call anything). tool names and arguments come from `android/app/src/main/assets/tools.json`. test rows may add `accept`, other argument values that also count as right. for example:

```json
{"query": "set a timer for ten minutes", "answers": [{"name": "set_timer", "arguments": {"minutes": 10}}]}
{"query": "haha you are funny", "answers": []}
```

```bash
sh scripts/train-needle.sh                 # writes .cache/models/cmd/needle3-val.cact
CHARM_NEEDLE=val sh scripts/prepare-phone.sh
```

the script stops with a message when `train.jsonl` or `test.jsonl` is missing, and `scripts/needle-tool.py rows` checks every row against the tool list before training.

### Charm mode

turns the phone into a Val-only device and back. no root needed, and it is fully reversible.

```bash
sh scripts/charm-mode.sh plan     # lists what `on` would switch off, changes nothing
sh scripts/charm-mode.sh on       # switches off every other app with a home-screen icon, Charm becomes home
sh scripts/charm-mode.sh off      # switches exactly those apps back on
```

the keep-list (Settings, dialer, WebView, text-to-speech, keyboard, clock and so on) is tuned for Realme/ColorOS. run `plan` first and extend `KEEP` in the script for your phone.

## Limitations

- the small chat model can be wrong. fact cards cover the common questions, but free questions go to a 450M model that can make things up.
- speech to text struggles in loud rooms. speak close to the phone.
- the timetable is the published schedule, with no delays, and covers 14 days starting the day before you build it. run `build-transit.py` again after that.
- GPS needs the sky. indoors there is no fix.
- the first photo takes about 17 s while the vision model warms up.
- the first ~10 s after start-up are busy (models and shaders load). let the phone settle.
- knock thresholds depend on the table.
- tuned and tested on one phone only.

## Credits and licences

the code is MIT ([LICENSE](LICENSE)). third-party material bundled in the app is listed in [`web/CREDITS`](web/CREDITS).

| What | Source | Licence |
|---|---|---|
| map data, place search, footpaths | © OpenStreetMap contributors | ODbL 1.0 |
| tram and bus timetable | DELFI e.V. via gtfs.de, VVO-area cut by kiliankoe/vvo | CC BY 4.0 |
| Val's 3D model (RobotExpressive) | Tomás Laulhé (Quaternius), modifications by Don McCurdy; three.js examples | CC0 1.0 |
| three.js 0.170 | three.js authors | MIT |
| MapLibre GL JS, PMTiles, @protomaps/basemaps | MapLibre, Protomaps | BSD-3-Clause |
| MiniSearch | Luca Ongaro | MIT |
| Noto Sans glyphs | Noto Fonts | SIL OFL 1.1 |
| Moonshine base and tiny (English), speech to text | Moonshine AI | MIT (licence file shipped with the model) |
| sherpa-onnx runtime | k2-fsa | Apache-2.0 |
| Kitten TTS nano (fallback voice) | KittenML | Apache-2.0 (licence file shipped with the model) |
| espeak-ng data (used by the Kitten voice) | espeak-ng authors | GPL-3.0; pushed to the phone with the model files, not part of the app package |
| Needle 3 command model and runtime | Cactus Compute | Apache-2.0 |
| LFM2.5-VL-450M, vision and chat | Liquid AI | LFM Open License v1.0 |
| llama.cpp (local server for the vision/chat model) | ggml authors | MIT |

a fine-tuned `needle3-val.cact` is a derivative of Needle 3. ours is not in the repo; `scripts/train-needle.sh` builds one from your own rows.

LFM2.5-VL-450M is under the LFM Open License v1.0, which is free for personal, research and small-business use. check Liquid AI's terms for larger commercial use.
