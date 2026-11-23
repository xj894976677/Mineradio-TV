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
        versionCode = 2
        versionName = "0.2.0"
    }

    // The web UI is Mineradio's own, unmodified: public/ at the repository root is packaged as
    // the assets root, next to this module's TV layer (assets/tv/).
    sourceSets["main"].assets.srcDirs("src/main/assets", "../../public", layout.buildDirectory.dir("backendAssets"))

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
    androidResources { noCompress += listOf("bin", "zip") }
}

// Mineradio's back end as one asset (see Backend.kt). `npm install --omit=dev` at the repository
// root first. The Qishui modules stay out: tv/backend/start.js answers for them.
val packBackend by tasks.registering(Zip::class) {
    val root = rootProject.projectDir.parentFile
    archiveFileName.set("backend.zip")
    destinationDirectory.set(layout.buildDirectory.dir("backendAssets"))
    isPreserveFileTimestamps = false
    isReproducibleFileOrder = true
    from(root) {
        include("server.js", "package.json", "dj-analyzer.js", "kugou-api.js", "qq-vip-api.js", "spotify-api.js", "LICENSE", "NOTICE.md")
        include("cuefield/**", "tv/backend/**", "node_modules/**")
        exclude("**/*.md", "**/*.map", "**/*.ts", "**/test/**", "**/tests/**", "**/docs/**", "**/example/**", "**/examples/**", "**/.github/**", "node_modules/.package-lock.json", "node_modules/.bin/**")
    }
    doFirst { check(File(root, "node_modules/NeteaseCloudMusicApi").isDirectory) { "run `npm install --omit=dev` in ${root.path} first" } }
}
tasks.named("preBuild") { dependsOn(packBackend) }

kotlin { compilerOptions { jvmTarget.set(JvmTarget.JVM_17) } }
