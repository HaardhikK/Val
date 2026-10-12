plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "io.github.haardhikk.charm"
    compileSdk = 35
    buildToolsVersion = "35.0.0"

    defaultConfig {
        applicationId = "io.github.haardhikk.charm"
        minSdk = 30
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // Local builds only: signed with the local debug key so `installRelease` works on a test phone.
            // Not for a store; a real release would use its own key from outside the repo.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        buildConfig = true
    }

    // Executables (the Needle server) ship as lib*.so so Android extracts them to nativeLibraryDir, where exec is allowed.
    sourceSets["main"].jniLibs.srcDirs("../../.cache/jnilibs")
    // The 26 MB map tiles and the footpath graph are read whole; storing them uncompressed makes that fast.
    androidResources {
        noCompress += listOf("pmtiles", "graph")
    }

    packaging {
        jniLibs {
            useLegacyPackaging = true
        }
    }

    lint {
        warningsAsErrors = false
        abortOnError = true
    }
}

dependencies {
    implementation("androidx.webkit:webkit:1.12.1")
    // Offline speech-to-text and text-to-speech (Apache-2.0). Downloaded into .cache/ (README → Setup), never committed.
    implementation(files("../../.cache/runtimes/sherpa-onnx-1.13.8.aar"))

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303") // real org.json for JVM unit tests (android.jar only has stubs)
}
