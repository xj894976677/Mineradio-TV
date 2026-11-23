package tv.mineradio.app

import android.content.Context
import android.system.Os
import android.util.Log
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.zip.ZipInputStream
import kotlin.concurrent.thread

/** The one native call: Node's main(), which returns when the script ends. See tv/native. */
object NodeBridge {
    @JvmStatic external fun startNode(args: Array<String>): Int
}

/**
 * Mineradio's own back end (server.js: NetEase, QQ and Kugou accounts, search, playlists, song
 * addresses), running on the TV itself under Node (nodejs-mobile's libnode.so), listening on
 * 127.0.0.1 only. Nothing outside the TV is needed, and nothing outside it can reach the port.
 *
 * - The back end ships as one asset, backend.zip (server.js, the provider modules, node_modules,
 *   tv/backend/start.js), unpacked to the app's files on the first start after an install or update.
 * - Node can be started once in a process; it runs until the process ends.
 * - Without a 64-bit ARM libnode the state is "failed" and the app plays offline music only.
 */
object Backend {
    private const val TAG = "MineradioTV"
    const val PORT = 38917

    /** off, preparing (unpacking), starting, ready, failed */
    @Volatile var state = "off"; private set
    @Volatile var error = ""; private set
    private var started = false

    @Synchronized
    fun start(context: Context) {
        if (started) return
        started = true
        val app = context.applicationContext
        state = "preparing"
        thread(name = "mrtv-backend-prepare", isDaemon = true) {
            try {
                val dir = unpack(app)
                val data = File(app.filesDir, "backend-data").apply { mkdirs() }
                mapOf(
                    "PORT" to PORT.toString(),
                    "HOST" to "127.0.0.1",
                    "MINERADIO_ROOT" to dir.absolutePath,
                    "HOME" to app.filesDir.absolutePath,
                    "TMPDIR" to app.cacheDir.absolutePath,
                    "COOKIE_FILE" to File(data, "netease-cookie").absolutePath,
                    "QQ_COOKIE_FILE" to File(data, "qq-cookie").absolutePath,
                    "KUGOU_COOKIE_FILE" to File(data, "kugou-cookie").absolutePath,
                    "MINERADIO_BEAT_CACHE_DIR" to File(app.cacheDir, "beatmaps").absolutePath,
                    "CUEFIELD_FEEDBACK_FILE" to File(data, "cuefield-feedback.jsonl").absolutePath,
                    "MINERADIO_LISTEN_SYNC_FILE" to File(data, "listen-sync-journal.json").absolutePath,
                    "MRTV_LOG_FILE" to File(app.cacheDir, "backend.log").absolutePath,
                ).forEach { (k, v) -> Os.setenv(k, v, true) }
                System.loadLibrary("node")
                System.loadLibrary("nodebridge")
                state = "starting"
                val script = File(dir, "tv/backend/start.js").absolutePath
                // V8 wants a deep stack: Node's own main thread has 8 MB.
                Thread(null, {
                    val code = runCatching { NodeBridge.startNode(arrayOf("node", script)) }.getOrElse { -1 }
                    Log.w(TAG, "node ended with $code")
                    state = "failed"; error = "node ended ($code)"
                }, "mrtv-node", 8L shl 20).start()
                waitUntilListening()
            } catch (e: Throwable) {
                Log.w(TAG, "backend failed", e)
                state = "failed"; error = e.javaClass.simpleName + ": " + (e.message ?: "")
            }
        }
    }

    private fun waitUntilListening() {
        repeat(120) {
            if (state == "failed") return
            val ok = runCatching {
                val c = URL("http://127.0.0.1:$PORT/api/app/version").openConnection() as HttpURLConnection
                c.connectTimeout = 800; c.readTimeout = 2000
                try { c.responseCode in 200..499 } finally { c.disconnect() }
            }.getOrDefault(false)
            if (ok) { state = "ready"; Log.i(TAG, "backend ready"); return }
            Thread.sleep(500)
        }
        if (state != "failed") { state = "failed"; error = "did not start listening" }
    }

    /** backend.zip to files/backend, once per installed build. */
    private fun unpack(context: Context): File {
        val dir = File(context.filesDir, "backend")
        val stamp = File(dir, ".stamp")
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        val want = "${info.lastUpdateTime}"
        if (stamp.exists() && stamp.readText() == want) return dir
        dir.deleteRecursively()
        dir.mkdirs()
        val root = dir.canonicalPath + File.separator
        var files = 0
        ZipInputStream(context.assets.open("backend.zip").buffered(1 shl 16)).use { zip ->
            val buffer = ByteArray(1 shl 16)
            while (true) {
                val entry = zip.nextEntry ?: break
                val out = File(dir, entry.name)
                if (!out.canonicalPath.startsWith(root)) continue
                if (entry.isDirectory) { out.mkdirs(); continue }
                out.parentFile?.mkdirs()
                out.outputStream().use { o -> while (true) { val n = zip.read(buffer); if (n < 0) break; o.write(buffer, 0, n) } }
                files++
            }
        }
        stamp.writeText(want)
        Log.i(TAG, "backend unpacked: $files files")
        return dir
    }
}
