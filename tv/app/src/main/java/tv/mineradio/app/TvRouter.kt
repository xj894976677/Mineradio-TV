package tv.mineradio.app

import android.content.Context
import android.net.Uri
import android.os.Build
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FilterInputStream
import java.io.InputStream
import java.io.RandomAccessFile
import java.util.Locale

/**
 * Answers every request the WebView makes, so the page is one origin and nothing leaves the TV:
 *
 *   /                 Mineradio's index.html with the TV layer added (tv-preload.js, tv.css, tv.js)
 *   /js, /css, ...    Mineradio's files, straight from the assets (the repository's public/)
 *   /tv/...           the TV layer (assets/tv)
 *   /tvapi/...        the offline library: list, audio (with byte ranges, for seeking), cover, lyric
 *   /api/...          Mineradio's online back end: answered "offline"
 *   any other host    an empty 204
 *
 * tv/dev/dev-server.js serves the same contract on a desktop.
 */
class TvRouter(private val context: Context, private val onRescan: () -> Unit) {
    companion object {
        const val HOST = "app.mineradio.tv"
        const val ORIGIN = "https://$HOST"
        private val MIME = mapOf(
            "html" to "text/html", "js" to "text/javascript", "css" to "text/css", "json" to "application/json",
            "png" to "image/png", "jpg" to "image/jpeg", "jpeg" to "image/jpeg", "webp" to "image/webp", "svg" to "image/svg+xml",
            "gif" to "image/gif", "ico" to "image/x-icon", "bin" to "application/octet-stream",
            "woff" to "font/woff", "woff2" to "font/woff2", "ttf" to "font/ttf", "otf" to "font/otf",
            "mp3" to "audio/mpeg", "flac" to "audio/flac", "wav" to "audio/wav", "ogg" to "audio/ogg", "opus" to "audio/ogg",
            "m4a" to "audio/mp4", "aac" to "audio/aac", "mp4" to "video/mp4", "webm" to "video/webm", "txt" to "text/plain",
        )
        private val TEXT = setOf("html", "js", "css", "json", "svg", "txt")
        private const val HEAD_TAG = "<script src=\"tv/tv-preload.js\"></script>"
        private const val BODY_TAG = "<link rel=\"stylesheet\" href=\"tv/tv.css\"><script src=\"tv/tv.js\"></script>"
    }

    fun handle(request: WebResourceRequest): WebResourceResponse {
        val uri = request.url
        if (uri.host != HOST) return empty(204, "No Content")
        val path = uri.path?.ifEmpty { "/" } ?: "/"
        return try {
            when {
                path == "/" || path == "/index.html" -> index()
                path.startsWith("/tvapi/") -> tvApi(path, uri, request)
                path.startsWith("/api/") -> json("{\"ok\":false,\"code\":503,\"offline\":true,\"error\":\"OFFLINE_TV\"}")
                else -> asset(path.trimStart('/'))
            }
        } catch (e: Throwable) {
            empty(500, "Error")
        }
    }

    private fun index(): WebResourceResponse {
        var html = context.assets.open("index.html").use { it.readBytes().toString(Charsets.UTF_8) }
        val head = Regex("<head[^>]*>", RegexOption.IGNORE_CASE).find(html)
        if (head != null) html = html.substring(0, head.range.last + 1) + HEAD_TAG + html.substring(head.range.last + 1)
        val end = html.lastIndexOf("</body>", ignoreCase = true)
        html = if (end >= 0) html.substring(0, end) + BODY_TAG + html.substring(end) else html + BODY_TAG
        return bytes(html.toByteArray(Charsets.UTF_8), "text/html", "utf-8", noStore = true)
    }

    private fun asset(name: String): WebResourceResponse {
        if (name.contains("..")) return empty(403, "Forbidden")
        val ext = name.substringAfterLast('.', "").lowercase(Locale.ROOT)
        val stream = try { context.assets.open(name) } catch (e: Exception) { return empty(404, "Not Found") }
        val response = WebResourceResponse(MIME[ext] ?: "application/octet-stream", if (ext in TEXT) "utf-8" else null, stream)
        response.responseHeaders = mapOf("Cache-Control" to "no-cache")
        return response
    }

    private fun tvApi(path: String, uri: Uri, request: WebResourceRequest): WebResourceResponse {
        when (path) {
            "/tvapi/library" -> return json(MusicLibrary.json(context))
            "/tvapi/rescan" -> { onRescan(); return json("{\"ok\":true}") }
            "/tvapi/device" -> return json("{\"ok\":true,\"model\":\"${Build.MODEL.replace("\"", "")}\",\"sdk\":${Build.VERSION.SDK_INT}}")
        }
        val track = uri.getQueryParameter("id")?.toIntOrNull()?.let { MusicLibrary.track(it) } ?: return json("{\"ok\":false}", 404, "Not Found")
        return when (path) {
            "/tvapi/audio" -> audio(track.file, request.requestHeaders.entries.firstOrNull { it.key.equals("Range", true) }?.value)
            "/tvapi/lyric" -> json(org.json.JSONObject().put("ok", true).put("lyric", MusicLibrary.lyric(track)).toString())
            "/tvapi/cover" -> {
                val data = MusicLibrary.cover(track) ?: return empty(404, "Not Found")
                val png = data.size > 3 && data[0] == 0x89.toByte() && data[1] == 'P'.code.toByte()
                bytes(data, if (png) "image/png" else "image/jpeg", null, noStore = false)
            }
            else -> json("{\"ok\":false}", 404, "Not Found")
        }
    }

    /** The file, or the byte range asked for: the audio element seeks with Range requests. */
    private fun audio(file: File, range: String?): WebResourceResponse {
        if (!file.canRead()) return empty(404, "Not Found")
        val size = file.length()
        val mime = MIME[file.extension.lowercase(Locale.ROOT)] ?: "application/octet-stream"
        val m = range?.let { Regex("bytes=(\\d*)-(\\d*)").find(it) }
        if (m == null) {
            return WebResourceResponse(mime, null, 200, "OK", mapOf("Accept-Ranges" to "bytes", "Content-Length" to size.toString()), file.inputStream())
        }
        val (a, b) = m.destructured
        val start: Long
        val end: Long
        if (a.isEmpty()) { // "-N": the last N bytes
            val n = b.toLongOrNull() ?: 0
            start = (size - n).coerceAtLeast(0); end = size - 1
        } else {
            start = a.toLong(); end = (b.toLongOrNull() ?: (size - 1)).coerceAtMost(size - 1)
        }
        if (start > end || start >= size) {
            return WebResourceResponse(mime, null, 416, "Range Not Satisfiable", mapOf("Content-Range" to "bytes */$size"), ByteArrayInputStream(ByteArray(0)))
        }
        val length = end - start + 1
        val headers = mapOf("Accept-Ranges" to "bytes", "Content-Range" to "bytes $start-$end/$size", "Content-Length" to length.toString())
        return WebResourceResponse(mime, null, 206, "Partial Content", headers, RangeStream(file, start, length))
    }

    private class RangeStream(file: File, start: Long, private var left: Long) : InputStream() {
        private val raf = RandomAccessFile(file, "r").apply { seek(start) }
        override fun read(): Int {
            if (left <= 0) return -1
            val v = raf.read()
            if (v >= 0) left--
            return v
        }
        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (left <= 0) return -1
            val n = raf.read(b, off, minOf(len.toLong(), left).toInt())
            if (n > 0) left -= n
            return n
        }
        override fun available(): Int = minOf(left, Int.MAX_VALUE.toLong()).toInt()
        override fun close() = raf.close()
    }

    private fun json(body: String, status: Int = 200, reason: String = "OK") =
        WebResourceResponse("application/json", "utf-8", status, reason, mapOf("Cache-Control" to "no-store"), ByteArrayInputStream(body.toByteArray(Charsets.UTF_8)))

    private fun bytes(data: ByteArray, mime: String, encoding: String?, noStore: Boolean) =
        WebResourceResponse(mime, encoding, 200, "OK", mapOf("Cache-Control" to if (noStore) "no-store" else "max-age=600", "Content-Length" to data.size.toString()), ByteArrayInputStream(data))

    private fun empty(status: Int, reason: String) =
        WebResourceResponse("text/plain", "utf-8", status, reason, emptyMap(), ByteArrayInputStream(ByteArray(0)))
}
