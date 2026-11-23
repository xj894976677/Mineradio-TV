# Mineradio TV

Mineradio's stage on an Android TV, for music on a USB drive. Offline: no account, no server.

- `app/` is the Android TV app: a full-screen WebView showing Mineradio's own web UI (`../public`,
  unmodified), a router that serves it and the offline library (`TvRouter.kt`, `MusicLibrary.kt`),
  and the TV layer over the stage (`app/src/main/assets/tv/`: remote keys, library and settings
  panels, now-playing card).
- `dev/dev-server.js` serves the same thing on a desktop for work on the TV layer:
  `node tv/dev/dev-server.js <music-folder>` then open http://127.0.0.1:8790 (needs ffmpeg / ffprobe).

## What it does

- Plugging in a drive starts playing; the last track and position resume on the next start.
- Title, artist, album and cover come from the files' tags; a same-name `.lrc` is the lyrics and a
  `cover.jpg` / `folder.jpg` in the folder is the cover of files that embed none.
- Remote: OK play / pause, left / right previous / next (hold to seek), up the library (all songs,
  folders, albums, artists), down the settings (play order, visual, lyrics, render detail), back
  twice to leave.
- Mineradio's online sources (`*-api.js`, `server.js`) are not part of the TV app.

## Build

```bash
cd tv
echo "sdk.dir=$HOME/Library/Android/sdk" > local.properties
JAVA_HOME=/opt/homebrew/opt/openjdk@17 ./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell appops set tv.mineradio.app MANAGE_EXTERNAL_STORAGE allow   # where the TV has no settings page for it
```

Licensed GPL-3.0-only, as Mineradio is. Not yet checked on a TV.
