import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "tv.mineradio.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "tv.mineradio.app"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
    }

    // The web UI is Mineradio's own, unmodified: public/ at the repository root is packaged as
    // the assets root, next to this module's TV layer (assets/tv/).
    sourceSets["main"].assets.srcDirs("src/main/assets", "../../public")

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    androidResources { noCompress += listOf("bin") }
}

kotlin { compilerOptions { jvmTarget.set(JvmTarget.JVM_17) } }
