package tv.mineradio.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ApplicationInfo
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.widget.FrameLayout
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient

/**
 * Mineradio's stage in a full-screen WebView, driven by the remote.
 *
 * The page is Mineradio's own web UI plus the TV layer (assets/tv/tv.js); [TvRouter] serves both
 * and the offline library. Remote keys are handed to the page by name (MRTV.nativeKey) instead of
 * as WebView key events: what DOM key a D-pad centre or a media key becomes differs between
 * WebView versions, and the WebView's own focus navigation must not move anything.
 */
class MainActivity : Activity() {
    private lateinit var web: WebView
    private lateinit var root: FrameLayout
    private var qqWeb: WebView? = null
    private lateinit var router: TvRouter
    private val main = Handler(Looper.getMainLooper())
    private var pageReady = false
    private var lastAccess = ""

    private val mountReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            // The volume is listed a moment after the broadcast; the media library later still.
            main.removeCallbacks(rescan)
            main.postDelayed(rescan, 1500)
        }
    }
    private val rescan = Runnable { MusicLibrary.rescan(this) { notifyLibrary() } }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_LAYOUT_STABLE

        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) WebView.setWebContentsDebuggingEnabled(true)
        router = TvRouter(this) { main.post(rescan) }
        web = WebView(this).apply {
            setBackgroundColor(Color.BLACK)
            isFocusable = true
            isFocusableInTouchMode = true
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.useWideViewPort = true
            settings.loadWithOverviewMode = true
            settings.setSupportZoom(false)
            if (Build.VERSION.SDK_INT >= 26) setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
            addJavascriptInterface(Bridge(), "MineradioTVNative")
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? = router.handle(request)
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = request.url.host != TvRouter.HOST
                override fun onPageFinished(view: WebView, url: String) { pageReady = true }
            }
            webChromeClient = object : WebChromeClient() {
                override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                    if (message.messageLevel() == ConsoleMessage.MessageLevel.ERROR) Log.w(TAG, "js: ${message.message()} (${message.sourceId()}:${message.lineNumber()})")
                    return true
                }
            }
        }
        root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK); addView(web, FrameLayout.LayoutParams(-1, -1)) }
        setContentView(root)

        registerReceiver(mountReceiver, IntentFilter().apply {
            addAction(Intent.ACTION_MEDIA_MOUNTED)
            addAction(Intent.ACTION_MEDIA_UNMOUNTED)
            addAction(Intent.ACTION_MEDIA_EJECT)
            addAction(Intent.ACTION_MEDIA_REMOVED)
            addAction(Intent.ACTION_MEDIA_BAD_REMOVAL)
            addDataScheme("file")
        })

        Backend.start(this)
        lastAccess = MusicLibrary.access(this)
        if (lastAccess == "none") askForAudioPermission()
        rescan.run()
        web.loadUrl(TvRouter.ORIGIN + "/")
    }

    private fun askForAudioPermission() {
        val permission = if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_AUDIO else Manifest.permission.READ_EXTERNAL_STORAGE
        runCatching { requestPermissions(arrayOf(permission), 1) }
    }

    /** All-files access, which also reads .lrc and cover.jpg; firmwares without that page get the audio permission. */
    private fun askForAllFiles() {
        if (Build.VERSION.SDK_INT >= 30) {
            val intents = listOf(
                Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:$packageName")),
                Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION),
            )
            for (intent in intents) {
                if (runCatching { startActivity(intent) }.isSuccess) return
            }
        }
        askForAudioPermission()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        accessMayHaveChanged()
    }

    private fun accessMayHaveChanged() {
        val now = MusicLibrary.access(this)
        if (now != lastAccess) { lastAccess = now; rescan.run() }
    }

    private fun notifyLibrary() = js("window.MRTV && MRTV.onLibraryChanged && MRTV.onLibraryChanged()")

    private fun js(code: String) {
        main.post { if (pageReady) web.evaluateJavascript(code, null) }
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val name = when (event.keyCode) {
            KeyEvent.KEYCODE_DPAD_UP -> "up"
            KeyEvent.KEYCODE_DPAD_DOWN -> "down"
            KeyEvent.KEYCODE_DPAD_LEFT -> "left"
            KeyEvent.KEYCODE_DPAD_RIGHT -> "right"
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER, KeyEvent.KEYCODE_BUTTON_A -> "ok"
            KeyEvent.KEYCODE_BACK, KeyEvent.KEYCODE_ESCAPE, KeyEvent.KEYCODE_BUTTON_B -> "back"
            KeyEvent.KEYCODE_MENU -> "menu"
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_MEDIA_PLAY, KeyEvent.KEYCODE_MEDIA_PAUSE -> "playpause"
            KeyEvent.KEYCODE_MEDIA_NEXT -> "next"
            KeyEvent.KEYCODE_MEDIA_PREVIOUS -> "prev"
            KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> "ff"
            KeyEvent.KEYCODE_MEDIA_REWIND -> "rw"
            else -> return super.dispatchKeyEvent(event)
        }
        if (qqWeb != null) {
            // QQ's page needs no keys: the phone does the signing in. Back leaves it.
            if (name == "back" && event.action == KeyEvent.ACTION_UP) closeQqLogin(false)
            return true
        }
        if (!pageReady) {
            if (name == "back" && event.action == KeyEvent.ACTION_UP) finish()
            return true
        }
        val phase = if (event.action == KeyEvent.ACTION_DOWN) "down" else "up"
        web.evaluateJavascript("window.MRTV && MRTV.nativeKey && MRTV.nativeKey('$name','$phase',${event.repeatCount})", null)
        return true
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
        accessMayHaveChanged()
        js("window.MRTV && MRTV.onHostResume && MRTV.onHostResume()")
    }

    override fun onPause() {
        // Leaving for Home or another app stops the music: a TV has one sound.
        if (pageReady) web.evaluateJavascript("window.MRTV && MRTV.onHostPause && MRTV.onHostPause()", null)
        web.onPause()
        super.onPause()
    }

    // ---- QQ Music sign-in --------------------------------------------------------------------
    // QQ's own sign-in page (a QR code for the QQ phone app) in a second WebView over the stage.
    // When QQ Music's session cookies appear, they go to the back end on this TV
    // (/api/qq/login/cookie, as Mineradio's desktop app does from its sign-in window) and the
    // page closes. Nothing is typed, and the cookies go nowhere else.
    private val qqPoll = object : Runnable {
        override fun run() {
            if (qqWeb == null) return
            val cookies = QQ_COOKIE_URLS.mapNotNull { runCatching { CookieManager.getInstance().getCookie(it) }.getOrNull() }
                .flatMap { it.split(';') }.map { it.trim() }.filter { it.contains('=') }.distinctBy { it.substringBefore('=') }
            val signedIn = cookies.any { c -> QQ_SESSION_KEYS.any { c.startsWith("$it=") && c.length > it.length + 8 } }
            if (!signedIn) { main.postDelayed(this, 1500); return }
            val cookie = cookies.joinToString("; ")
            thread(name = "mrtv-qq-login") {
                val ok = runCatching {
                    val c = URL("${TvRouter.ORIGIN}/api/qq/login/cookie").openConnection() as HttpURLConnection
                    c.requestMethod = "POST"; c.doOutput = true; c.connectTimeout = 4000; c.readTimeout = 20000
                    c.setRequestProperty("Content-Type", "application/json")
                    c.outputStream.use { it.write(org.json.JSONObject().put("cookie", cookie).toString().toByteArray()) }
                    val body = (if (c.responseCode in 200..299) c.inputStream else c.errorStream)?.use { it.readBytes().toString(Charsets.UTF_8) }.orEmpty()
                    org.json.JSONObject(body).optBoolean("loggedIn")
                }.getOrDefault(false)
                main.post {
                    if (qqWeb == null) return@post
                    if (ok) closeQqLogin(true) else main.postDelayed(this, 2500) // the session may still be settling
                }
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun openQqLogin() {
        if (qqWeb != null) return
        val cm = CookieManager.getInstance()
        cm.setAcceptCookie(true)
        val view = WebView(this).apply {
            setBackgroundColor(Color.WHITE)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.userAgentString = QQ_USER_AGENT
            settings.useWideViewPort = true
            settings.loadWithOverviewMode = true
            isFocusable = false
            webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView, url: String) {
                    // The QR code is small on a page laid out for a desk: bring it up to TV size.
                    if (url.contains("graph.qq.com") || url.contains("xui.ptlogin2.qq.com")) {
                        view.evaluateJavascript("document.documentElement.style.zoom='2.2';document.body.style.background='#fff';", null)
                    }
                }
            }
        }
        cm.setAcceptThirdPartyCookies(view, true)
        qqWeb = view
        root.addView(view, FrameLayout.LayoutParams(-1, -1))
        view.loadUrl(QQ_LOGIN_URL)
        main.postDelayed(qqPoll, 2500)
    }

    private fun closeQqLogin(signedIn: Boolean) {
        val view = qqWeb ?: return
        qqWeb = null
        main.removeCallbacks(qqPoll)
        root.removeView(view)
        view.destroy()
        web.requestFocus()
        js("window.MRTV && MRTV.onQqLogin && MRTV.onQqLogin(${signedIn})")
    }

    override fun onDestroy() {
        qqWeb?.let { runCatching { it.destroy() } }
        runCatching { unregisterReceiver(mountReceiver) }
        main.removeCallbacksAndMessages(null)
        web.destroy()
        super.onDestroy()
    }

    private inner class Bridge {
        @JavascriptInterface fun exit() { main.post { finish() } }
        @JavascriptInterface fun requestAccess() { main.post { askForAllFiles() } }
        @JavascriptInterface fun loginQQ() { main.post { openQqLogin() } }
        @JavascriptInterface fun access(): String = MusicLibrary.access(this@MainActivity)
    }

    private companion object {
        const val TAG = "MineradioTV"
        // QQ's sign-in for QQ Music's web player (its app id), landing back on y.qq.com.
        const val QQ_LOGIN_URL = "https://graph.qq.com/oauth2.0/authorize?response_type=code&state=state&client_id=100497308&redirect_uri=https%3A%2F%2Fy.qq.com%2Fportal%2Fwx_redirect.html%3Flogin_type%3D1%26surl%3Dhttps%253A%252F%252Fy.qq.com%252F"
        const val QQ_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        val QQ_COOKIE_URLS = listOf("https://y.qq.com", "https://qq.com", "https://c.y.qq.com", "https://u.y.qq.com")
        val QQ_SESSION_KEYS = listOf("qqmusic_key", "qm_keyst")
    }
}
