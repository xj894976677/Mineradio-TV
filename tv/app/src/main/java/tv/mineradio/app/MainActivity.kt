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
        setContentView(web)

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

    override fun onDestroy() {
        runCatching { unregisterReceiver(mountReceiver) }
        main.removeCallbacksAndMessages(null)
        web.destroy()
        super.onDestroy()
    }

    private inner class Bridge {
        @JavascriptInterface fun exit() { main.post { finish() } }
        @JavascriptInterface fun requestAccess() { main.post { askForAllFiles() } }
        @JavascriptInterface fun access(): String = MusicLibrary.access(this@MainActivity)
    }

    private companion object { const val TAG = "MineradioTV" }
}
