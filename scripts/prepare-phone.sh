#!/bin/sh
# Prepares what the Charm app needs but git does not hold (all from .cache/, never committed):
#   1. native executables for the app's jniLibs (the Needle command server, the llama.cpp vision server),
#   2. the on-phone model files, pushed to the app's external files folder.
# Run from the repo root after the downloads in README → Setup:  sh scripts/prepare-phone.sh
# Set ADB_SERIAL to pick a phone, CHARM_CHAT=1.2b for the larger chat model, CHARM_NEEDLE=val for the fine-tuned Needle. STRIP=0 keeps llama.cpp's debug info (~170 MB more in the APK).
set -eu
cd "$(dirname "$0")/.."
. scripts/env.sh
adb_() { if [ -n "${ADB_SERIAL:-}" ]; then adb -s "$ADB_SERIAL" "$@"; else adb "$@"; fi; }

M=.cache/models
JNI=.cache/jnilibs/arm64-v8a
mkdir -p "$JNI"
cp "$M/cmd/android-arm64/needle" "$JNI/libneedle.so" # executables ship as lib*.so so Android extracts them where exec is allowed

# llama.cpp's server and the shared libraries it needs (DT_NEEDED), plus the CPU backends that fit the SD710
# (Cortex-A75/A55, ARMv8.2 + dotprod; ggml picks the best one at run time from the executable's folder).
LLAMA_TGZ=.cache/downloads/llama/llama-b11541-bin-android-arm64.tar.gz
LLAMA_TMP=$(mktemp -d)
trap 'rm -rf "$LLAMA_TMP"' EXIT
tar -xzf "$LLAMA_TGZ" -C "$LLAMA_TMP"
LLAMA_DIR="$LLAMA_TMP/llama-b11541"
for f in llama-server libllama-server-impl.so libllama-common.so libllama.so libmtmd.so libggml.so libggml-base.so \
  libggml-cpu-android_armv8.0_1.so libggml-cpu-android_armv8.2_1.so libggml-cpu-android_armv8.2_2.so; do
  case "$f" in lib*) out="$f" ;; *) out="lib$f.so" ;; esac
  if [ "${STRIP:-1}" = 0 ]; then cp "$LLAMA_DIR/$f" "$JNI/$out"; else python3 -I scripts/strip-elf.py "$LLAMA_DIR/$f" "$JNI/$out"; fi
done

DEST=/sdcard/Android/data/io.github.haardhikk.charm/files/models
adb_ shell mkdir -p "$DEST/moonshine" "$DEST/kitten" "$DEST/needle" "$DEST/vlm"
# Speech-to-text: Moonshine base is the default ears (about 135 MB; it holds up best in noise), Moonshine tiny the
# fallback the app loads when base is missing (SttEngine.pick). Both are required here.
MOONB=$M/stt/sherpa-onnx-moonshine-base-en-quantized-2026-02-27
adb_ shell mkdir -p "$DEST/moonshine-base"
adb_ push "$MOONB/encoder_model.ort" "$MOONB/decoder_model_merged.ort" "$MOONB/tokens.txt" "$DEST/moonshine-base/" >/dev/null
MOON=$M/stt/sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27
adb_ push "$MOON/encoder_model.ort" "$MOON/decoder_model_merged.ort" "$MOON/tokens.txt" "$DEST/moonshine/" >/dev/null
# Whisper is no longer pushed (it looped on real clips); remove copies left by earlier runs.
adb_ shell rm -rf "$DEST/whisper-tiny" "$DEST/whisper-base"
KIT=$M/tts/kitten-nano-en-v0_8-int8
adb_ push "$KIT/model.int8.onnx" "$KIT/voices.bin" "$KIT/tokens.txt" "$DEST/kitten/" >/dev/null
adb_ push "$KIT/espeak-ng-data" "$DEST/kitten/" >/dev/null
adb_ push "$M/cmd/needle3.cact" "$DEST/needle/" >/dev/null
# CHARM_NEEDLE=val also pushes our fine-tuned command model (scripts/train-needle.sh), which the app then prefers
# (Brain.modelFile); without it that file is removed again, so the base model runs.
if [ "${CHARM_NEEDLE:-}" = val ]; then
  adb_ push "$M/cmd/needle3-val.cact" "$DEST/needle/" >/dev/null
else
  adb_ shell rm -f "$DEST/needle/needle3-val.cact"
fi
adb_ push "$M/vlm/LFM2.5-VL-450M-Q4_K_M.gguf" "$M/vlm/mmproj-LFM2.5-VL-450m-Q8_0.gguf" "$DEST/vlm/" >/dev/null
# Chat model: by default the vision model above also answers questions. CHARM_CHAT=1.2b pushes the larger text model,
# which the app then uses for answers (it checks for the file at start); without it the file is removed again.
if [ "${CHARM_CHAT:-}" = 1.2b ]; then
  adb_ shell mkdir -p "$DEST/llm"
  adb_ push "$M/llm/LFM2.5-1.2B-Instruct-Q4_K_M.gguf" "$DEST/llm/" >/dev/null
else
  adb_ shell rm -f "$DEST/llm/LFM2.5-1.2B-Instruct-Q4_K_M.gguf"
fi
echo "Models on the phone in $DEST; native helpers in $JNI (rebuild the app to include them)."
echo "Debug builds also keep the last 10 voice clips in ${DEST%/models}/clips (your own voice, for comparing speech-to-text engines): delete with  adb shell rm -r ${DEST%/models}/clips"
