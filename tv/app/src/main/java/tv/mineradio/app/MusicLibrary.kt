package tv.mineradio.app

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.MediaMetadataRetriever
import android.os.Build
import android.os.Environment
import android.os.storage.StorageManager
import android.provider.MediaStore
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.ByteBuffer
import java.nio.charset.Charset
import java.nio.charset.CodingErrorAction
import java.text.Collator
import java.util.Locale
import kotlin.concurrent.thread

/**
 * The offline library: every audio file on the TV's storage volumes (USB drives, the internal
 * storage), with what a music player shows for each: title, artist, album, length, cover, lyrics.
 *
 * - With all-files access the volumes are walked, so a same-name `.lrc` is the lyrics and a
 *   `cover.jpg` / `folder.jpg` in the folder is the cover of files that embed none.
 * - With only the audio permission the list comes from the media library: audio and embedded
 *   covers, no sidecar files.
 * - Tags are read in the background after the file list is out (a tag read is 20-60 ms a file on
 *   a TV's USB 2.0 port) and kept in a cache keyed by path, size and date.
 */
object MusicLibrary {
    private const val TAG = "MineradioTV"
    private const val MAX_TRACKS = 30_000
    private const val MAX_DEPTH = 10
    private val AUDIO = setOf("mp3", "flac", "wav", "ogg", "m4a", "aac", "opus")
    private val SKIP_DIRS = setOf("android", "ringtones", "notifications", "alarms", "lost.dir", "system volume information", "\$recycle.bin")
    private val FOLDER_COVERS = listOf("cover.jpg", "cover.png", "folder.jpg", "folder.png", "front.jpg", "album.jpg")

    class Track(
        val id: Int, val file: File, val volume: String, val folder: String,
        val size: Long, val modified: Long,
    ) {
        @Volatile var title: String = file.nameWithoutExtension
        @Volatile var artist: String = ""
        @Volatile var album: String = ""
        @Volatile var durationMs: Long = 0
        @Volatile var embeddedCover: Boolean = false
        @Volatile var lyric: File? = null
        @Volatile var image: File? = null
        val key: String get() = "${file.absolutePath}:$size:$modified"
    }

    @Volatile private var tracks: List<Track> = emptyList()
    @Volatile private var volumes: List<String> = emptyList()
    @Volatile var scanning = false; private set
    @Volatile private var generation = 0
    private val scanLock = Any()

    fun access(context: Context): String = when {
        Build.VERSION.SDK_INT >= 30 && Environment.isExternalStorageManager() -> "all"
        granted(context, if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_AUDIO else Manifest.permission.READ_EXTERNAL_STORAGE) ->
            if (Build.VERSION.SDK_INT >= 30) "media" else "all"
        else -> "none"
    }

    private fun granted(context: Context, permission: String) =
        context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    fun track(id: Int): Track? = tracks.getOrNull(id)

    /** Lists the files now and reads their tags behind; [onChanged] runs when either is done. */
    fun rescan(context: Context, onChanged: () -> Unit) {
        val app = context.applicationContext
        val mine = synchronized(scanLock) { ++generation }
        scanning = true
        thread(name = "mrtv-scan", isDaemon = true) {
            try {
                val found = ArrayList<Track>()
                val names = ArrayList<String>()
                when (access(app)) {
                    "all" -> walkVolumes(app, found, names)
                    "media" -> queryMediaStore(app, found, names)
                }
                if (mine != generation) return@thread
                val cache = MetaCache(File(app.filesDir, "meta-cache.json"))
                found.forEach { cache.apply(it) }
                tracks = found
                volumes = names
                Log.i(TAG, "library: ${found.size} tracks on ${names.joinToString()} (${access(app)})")
                onChanged()
                var read = 0
                for (t in found) {
                    if (mine != generation) return@thread
                    if (cache.has(t)) continue
                    readTags(t)
                    cache.put(t)
                    if (++read % 200 == 0) { cache.save(); onChanged() }
                }
                if (read > 0) cache.save()
            } catch (e: Throwable) {
                Log.w(TAG, "scan failed", e)
            } finally {
                if (mine == generation) { scanning = false; onChanged() }
            }
        }
    }

    private fun walkVolumes(context: Context, out: MutableList<Track>, names: MutableList<String>) {
        val sm = context.getSystemService(Context.STORAGE_SERVICE) as StorageManager
        val roots = LinkedHashMap<File, String>()
        for (v in sm.storageVolumes) {
            if (v.state != Environment.MEDIA_MOUNTED && v.state != Environment.MEDIA_MOUNTED_READ_ONLY) continue
            val dir = if (Build.VERSION.SDK_INT >= 30) v.directory else null
            val label = if (v.isPrimary) "本机" else (v.getDescription(context)?.takeIf { it.isNotBlank() } ?: v.uuid ?: "USB")
            if (dir != null) roots[dir] = label
        }
        if (Build.VERSION.SDK_INT < 30) {
            roots[Environment.getExternalStorageDirectory()] = "本机"
            File("/storage").listFiles()?.filter { it.isDirectory && it.name != "emulated" && it.name != "self" && it.canRead() }
                ?.forEach { roots.putIfAbsent(it, it.name) }
        }
        val collator = Collator.getInstance(Locale.CHINA)
        // Removable volumes first: a drive someone plugs in is what they mean to hear.
        for ((root, label) in roots.entries.sortedBy { if (it.value == "本机") 1 else 0 }) {
            val before = out.size
            walk(root, root, label, 0, out, collator)
            if (out.size > before) names.add(label)
        }
    }

    private fun walk(root: File, dir: File, label: String, depth: Int, out: MutableList<Track>, collator: Collator) {
        if (depth > MAX_DEPTH || out.size >= MAX_TRACKS) return
        val entries = dir.listFiles() ?: return
        entries.sortWith { a, b -> collator.compare(a.name, b.name) }
        var folderImage: File? = null
        var imageLooked = false
        for (f in entries) {
            if (f.name.startsWith(".")) continue
            if (f.isDirectory) continue
            val ext = f.extension.lowercase(Locale.ROOT)
            if (ext !in AUDIO || out.size >= MAX_TRACKS) continue
            if (!imageLooked) {
                imageLooked = true
                folderImage = FOLDER_COVERS.firstNotNullOfOrNull { n -> entries.firstOrNull { it.isFile && it.name.equals(n, ignoreCase = true) } }
            }
            val rel = dir.absolutePath.removePrefix(root.absolutePath).trim('/')
            val t = Track(out.size, f, label, rel, f.length(), f.lastModified())
            val base = f.nameWithoutExtension
            t.lyric = entries.firstOrNull { it.isFile && it.extension.equals("lrc", true) && it.nameWithoutExtension == base }
            t.image = entries.firstOrNull { it.isFile && it.nameWithoutExtension == base && it.extension.lowercase(Locale.ROOT) in setOf("jpg", "jpeg", "png", "webp") } ?: folderImage
            out.add(t)
        }
        for (f in entries) {
            if (!f.isDirectory || f.name.startsWith(".")) continue
            if (f.name.lowercase(Locale.ROOT) in SKIP_DIRS) continue
            walk(root, f, label, depth + 1, out, collator)
        }
    }

    private fun queryMediaStore(context: Context, out: MutableList<Track>, names: MutableList<String>) {
        val volumeNames = if (Build.VERSION.SDK_INT >= 29) MediaStore.getExternalVolumeNames(context) else setOf("external")
        val columns = arrayOf(MediaStore.Audio.Media.DATA, MediaStore.Audio.Media.SIZE, MediaStore.Audio.Media.DATE_MODIFIED, MediaStore.Audio.Media.IS_MUSIC)
        for (name in volumeNames) {
            val uri = if (Build.VERSION.SDK_INT >= 29) MediaStore.Audio.Media.getContentUri(name) else MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
            val label = if (name == "external_primary" || name == "external") "本机" else name.uppercase(Locale.ROOT)
            val before = out.size
            runCatching {
                context.contentResolver.query(uri, columns, null, null, MediaStore.Audio.Media.DATA)?.use { c ->
                    while (c.moveToNext() && out.size < MAX_TRACKS) {
                        val path = c.getString(0) ?: continue
                        val file = File(path)
                        if (file.extension.lowercase(Locale.ROOT) !in AUDIO) continue
                        if (path.split('/').any { it.lowercase(Locale.ROOT) in SKIP_DIRS }) continue
                        val folder = file.parentFile?.absolutePath.orEmpty().substringAfter("/storage/").substringAfter('/').removePrefix("0/").trim('/')
                        out.add(Track(out.size, file, label, folder, c.getLong(1), c.getLong(2) * 1000))
                    }
                }
            }
            if (out.size > before) names.add(label)
        }
    }

    private fun readTags(t: Track) {
        val r = MediaMetadataRetriever()
        try {
            r.setDataSource(t.file.absolutePath)
            r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_TITLE)?.trim()?.takeIf { it.isNotEmpty() }?.let { t.title = it }
            t.artist = (r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ARTIST) ?: r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ALBUMARTIST) ?: "").trim()
            t.album = (r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ALBUM) ?: "").trim()
            t.durationMs = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0
            t.embeddedCover = r.embeddedPicture != null
        } catch (e: Throwable) {
            // An unreadable file stays in the list under its file name; the player says if it cannot play.
        } finally {
            runCatching { r.release() }
        }
    }

    fun cover(t: Track): ByteArray? {
        if (t.embeddedCover) {
            val r = MediaMetadataRetriever()
            try {
                r.setDataSource(t.file.absolutePath)
                r.embeddedPicture?.let { return it }
            } catch (e: Throwable) {
            } finally { runCatching { r.release() } }
        }
        return t.image?.takeIf { it.length() in 1..(12L shl 20) }?.let { runCatching { it.readBytes() }.getOrNull() }
    }

    /** A .lrc as text: UTF-8 or UTF-16 by their marks, else UTF-8 if it decodes cleanly, else GBK. */
    fun lyric(t: Track): String {
        val f = t.lyric ?: return ""
        val bytes = runCatching { if (f.length() > (1L shl 20)) null else f.readBytes() }.getOrNull() ?: return ""
        if (bytes.size >= 3 && bytes[0] == 0xEF.toByte() && bytes[1] == 0xBB.toByte() && bytes[2] == 0xBF.toByte()) return String(bytes, 3, bytes.size - 3, Charsets.UTF_8)
        if (bytes.size >= 2 && bytes[0] == 0xFF.toByte() && bytes[1] == 0xFE.toByte()) return String(bytes, 2, bytes.size - 2, Charsets.UTF_16LE)
        if (bytes.size >= 2 && bytes[0] == 0xFE.toByte() && bytes[1] == 0xFF.toByte()) return String(bytes, 2, bytes.size - 2, Charsets.UTF_16BE)
        return try {
            Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString()
        } catch (e: Exception) {
            String(bytes, runCatching { Charset.forName("GBK") }.getOrDefault(Charsets.UTF_8))
        }
    }

    fun json(context: Context): String {
        val list = JSONArray()
        for (t in tracks) {
            list.put(JSONObject().apply {
                put("id", t.id.toString())
                put("name", t.title)
                put("artist", t.artist)
                put("album", t.album)
                put("folder", t.folder)
                put("volume", t.volume)
                put("duration", t.durationMs / 1000.0)
                put("hasCover", t.embeddedCover || t.image != null)
                put("hasLyric", t.lyric != null)
                put("key", t.key)
            })
        }
        return JSONObject().apply {
            put("ok", true)
            put("access", access(context))
            put("scanning", scanning)
            put("volumes", JSONArray(volumes))
            put("tracks", list)
        }.toString()
    }

    /** Tags already read, so a drive with thousands of files lists in full on its second mount. */
    private class MetaCache(private val file: File) {
        private val map = HashMap<String, JSONObject>()

        init {
            runCatching {
                if (file.exists()) {
                    val root = JSONObject(file.readText())
                    for (k in root.keys()) map[k] = root.getJSONObject(k)
                }
            }
        }

        fun has(t: Track) = map.containsKey(t.key)

        fun apply(t: Track) {
            val o = map[t.key] ?: return
            o.optString("t").takeIf { it.isNotEmpty() }?.let { t.title = it }
            t.artist = o.optString("a")
            t.album = o.optString("l")
            t.durationMs = o.optLong("d")
            t.embeddedCover = o.optBoolean("c")
        }

        fun put(t: Track) {
            map[t.key] = JSONObject().put("t", t.title).put("a", t.artist).put("l", t.album).put("d", t.durationMs).put("c", t.embeddedCover)
        }

        fun save() {
            runCatching {
                // Drives come and go; keep the cache from growing without end.
                if (map.size > 60_000) map.keys.take(map.size - 60_000).forEach { map.remove(it) }
                val root = JSONObject()
                for ((k, v) in map) root.put(k, v)
                val tmp = File(file.parentFile, file.name + ".tmp")
                tmp.writeText(root.toString())
                tmp.renameTo(file)
            }
        }
    }
}
