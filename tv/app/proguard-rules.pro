# The page calls these by name (MineradioTVNative), and libnodebridge.so calls startNode by its JNI name.
-keepclassmembers class tv.mineradio.app.MainActivity$Bridge { @android.webkit.JavascriptInterface <methods>; }
-keep class tv.mineradio.app.NodeBridge { *; }
