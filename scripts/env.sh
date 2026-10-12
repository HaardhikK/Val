# Source this from the repo root: `. scripts/env.sh`
# Points every Android/Java/Gradle tool at the in-repo .cache/.
# Deleting .cache/ removes the whole toolchain.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"

export ANDROID_HOME="$REPO_ROOT/.cache/android"
export ANDROID_USER_HOME="$REPO_ROOT/.cache/android-user"   # Gradle's debug keystore stays in the repo (adb ignores this and uses ~/.android)
export GRADLE_USER_HOME="$REPO_ROOT/.cache/gradle"
export PIP_CACHE_DIR="$REPO_ROOT/.cache/pip"
export npm_config_cache="$REPO_ROOT/.cache/npm"

if [ -d "$REPO_ROOT/.cache/jdk/Contents/Home" ]; then
  export JAVA_HOME="$REPO_ROOT/.cache/jdk/Contents/Home"
  PATH="$JAVA_HOME/bin:$PATH"
fi

PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
export PATH

mkdir -p "$ANDROID_USER_HOME"
