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
        versionCode = 3
        versionName = "0.3.0"
    }

    // The web UI is Mineradio's own, unmodified: public/ at the repository root is packaged as
    // the assets root, next to this module's TV layer (assets/tv/).
    sourceSets["main"].assets.srcDirs("src/main/assets", "../../public", layout.buildDirectory.dir("backendAssets"))

    buildTypes {
        release {
            // Small and not debuggable. Signed with the debug key until there is a release key.
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    // libnode.so is 62 MB as it is and 17 MB deflated: compress it in the APK (the system unpacks
    // it at install) rather than store it to be mapped straight from the APK.
    packaging { jniLibs { useLegacyPackaging = true } }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    androidResources { noCompress += listOf("bin", "zip") }
}

// Mineradio's back end as one asset (see Backend.kt): tv/backend/pack.js stages the files the back
// end can reach, the Zip task packs them. `npm install --omit=dev` at the repository root first.
val repoRoot = rootProject.projectDir.parentFile
val stageBackend by tasks.registering(Exec::class) {
    val stage = layout.buildDirectory.dir("backendStage")
    inputs.files(fileTree(repoRoot) { include("server.js", "*-api.js", "dj-analyzer.js", "package.json", "package-lock.json", "cuefield/**", "tv/backend/**") })
    outputs.dir(stage)
    doFirst { check(File(repoRoot, "node_modules/NeteaseCloudMusicApi").isDirectory) { "run `npm install --omit=dev` in ${repoRoot.path} first" } }
    commandLine("node", File(repoRoot, "tv/backend/pack.js").path, stage.get().asFile.path)
}
val packBackend by tasks.registering(Zip::class) {
    dependsOn(stageBackend)
    archiveFileName.set("backend.zip")
    destinationDirectory.set(layout.buildDirectory.dir("backendAssets"))
    isPreserveFileTimestamps = false
    isReproducibleFileOrder = true
    from(layout.buildDirectory.dir("backendStage"))
}
// Mineradio's UI modules as one script (tv/backend/bundle-ui.js), served in place of its loader.
val bundleUi by tasks.registering(Exec::class) {
    val out = layout.buildDirectory.file("backendAssets/tv/index-modules.js")
    inputs.dir(File(repoRoot, "public/js"))
    inputs.files(File(repoRoot, "public/sonic-topography-preset.js"), File(repoRoot, "public/sonic-workshop-preset.js"), File(repoRoot, "tv/backend/bundle-ui.js"))
    outputs.file(out)
    commandLine("node", File(repoRoot, "tv/backend/bundle-ui.js").path, out.get().asFile.path)
}
tasks.named("preBuild") { dependsOn(packBackend, bundleUi) }
