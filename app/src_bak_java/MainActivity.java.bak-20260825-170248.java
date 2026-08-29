package com.dsapp.liquidglasschat;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.ValueCallback;
import android.widget.Button;
import android.widget.ProgressBar;
import android.widget.TextView;

import androidx.core.graphics.Insets;
import androidx.core.content.ContextCompat;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;

import org.json.JSONObject;
import org.json.JSONArray;

import java.util.ArrayDeque;

public class MainActivity extends Activity {
    private static final int NOTIFY_PERMISSION_REQUEST = 1002;
    private static final int FILE_CHOOSER_REQUEST = 2011;
    public static final String EXTRA_OPEN_SESSION_ID = "com.dsapp.dshremote.OPEN_SESSION_ID";
    public static final String EXTRA_OPEN_SESSION_TITLE = "com.dsapp.dshremote.OPEN_SESSION_TITLE";
    public static final String EXTRA_OPEN_PROJECT_ID = "com.dsapp.dshremote.OPEN_PROJECT_ID";
    public static final String EXTRA_OPEN_PROJECT_NAME = "com.dsapp.dshremote.OPEN_PROJECT_NAME";
    private WebView webView;
    private ProgressBar loadingBar;
    private android.view.View errorView;
    private TextView errorMessage;
    private int safeTopInset;
    private int safeBottomInset;
    private int keyboardBottomInset;
    private ValueCallback<Uri[]> fileChooserCallback;
    private final ArrayDeque<String> pendingJsMessages = new ArrayDeque<>();
    private boolean jsFlushScheduled;
    private boolean webPageReady;
    private final BroadcastReceiver remoteReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            String payload = intent.getStringExtra(RemoteService.EXTRA_PAYLOAD);
            if (payload != null) pushMessageToJs(payload);
        }
    };

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        webView = findViewById(R.id.webView);
        loadingBar = findViewById(R.id.loadingBar);
        errorView = findViewById(R.id.errorView);
        errorMessage = findViewById(R.id.errorMessage);

        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView())
                .setAppearanceLightStatusBars(true);
        WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView())
                .setAppearanceLightNavigationBars(true);

        ViewCompat.setOnApplyWindowInsetsListener(webView, (view, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars()
                    | WindowInsetsCompat.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            float density = getResources().getDisplayMetrics().density;
            safeTopInset = Math.round(bars.top / density);
            safeBottomInset = Math.round(bars.bottom / density);
            int keyboardInsetPx = insets.isVisible(WindowInsetsCompat.Type.ime())
                    ? Math.max(0, ime.bottom - bars.bottom) : 0;
            keyboardBottomInset = Math.round(keyboardInsetPx / density);
            applySafeAreaToWebView();
            return insets;
        });
        ViewCompat.requestApplyInsets(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadWithOverviewMode(false);
        settings.setUseWideViewPort(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setAllowFileAccess(true);
        settings.setAllowFileAccessFromFileURLs(true);
        settings.setAllowUniversalAccessFromFileURLs(true);
        settings.setTextZoom(100);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                webPageReady = false;
                loadingBar.setVisibility(ProgressBar.VISIBLE);
                errorView.setVisibility(android.view.View.GONE);
                webView.setVisibility(android.view.View.VISIBLE);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                webPageReady = true;
                loadingBar.setVisibility(ProgressBar.GONE);
                applySafeAreaToWebView();
                pushMessageToJs(RemoteService.getSnapshotJson(MainActivity.this));
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showError("页面加载失败：" + error.getDescription());
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                loadingBar.setProgress(newProgress);
                if (newProgress >= 100) loadingBar.setVisibility(ProgressBar.GONE);
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                android.util.Log.i("DSHRemote", "onShowFileChooser called, params=" + (params != null ? params.getAcceptTypes() != null ? java.util.Arrays.toString(params.getAcceptTypes()) : "null-accept" : "no-params"));
                if (fileChooserCallback != null) fileChooserCallback.onReceiveValue(null);
                fileChooserCallback = callback;
                Intent intent;
                try {
                    intent = params.createIntent();
                } catch (Exception error) {
                    intent = new Intent(Intent.ACTION_OPEN_DOCUMENT)
                            .addCategory(Intent.CATEGORY_OPENABLE)
                            .setType("image/*")
                            .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                }
                try {
                    startActivityForResult(intent, FILE_CHOOSER_REQUEST);
                } catch (Exception error) {
                    fileChooserCallback = null;
                    callback.onReceiveValue(null);
                    return false;
                }
                return true;
            }
        });

        webView.addJavascriptInterface(new RemoteJsBridge(this), "AndroidRemote");
        ((Button) findViewById(R.id.retryButton)).setOnClickListener(v -> webView.reload());
        ((Button) findViewById(R.id.settingsButton)).setOnClickListener(v -> pushMessageToJs("{\"type\":\"open-settings\"}"));
        webView.loadUrl("file:///android_asset/index.html");
        routeNotificationIntent(getIntent());

        IntentFilter filter = new IntentFilter(RemoteService.ACTION_MESSAGE);
        ContextCompat.registerReceiver(this, remoteReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED);
        requestNotificationPermission();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        routeNotificationIntent(intent);
    }

    private void routeNotificationIntent(Intent intent) {
        if (intent == null) return;
        String sessionId = intent.getStringExtra(EXTRA_OPEN_SESSION_ID);
        if (sessionId == null || sessionId.trim().isEmpty()) return;
        try {
            JSONObject data = new JSONObject()
                    .put("id", sessionId)
                    .put("title", intent.getStringExtra(EXTRA_OPEN_SESSION_TITLE))
                    .put("projectId", intent.getStringExtra(EXTRA_OPEN_PROJECT_ID))
                    .put("projectName", intent.getStringExtra(EXTRA_OPEN_PROJECT_NAME));
            pushMessageToJs(new JSONObject().put("type", "open-session").put("data", data).toString());
            intent.removeExtra(EXTRA_OPEN_SESSION_ID);
            intent.removeExtra(EXTRA_OPEN_SESSION_TITLE);
            intent.removeExtra(EXTRA_OPEN_PROJECT_ID);
            intent.removeExtra(EXTRA_OPEN_PROJECT_NAME);
        } catch (Exception ignored) {
        }
    }

    private void applySafeAreaToWebView() {
        if (webView == null) return;
        String js = "(function(){var r=document.documentElement;"
                + "r.style.setProperty('--native-safe-top','" + safeTopInset + "px');"
                + "r.style.setProperty('--native-safe-bottom','" + safeBottomInset + "px');"
                + "r.style.setProperty('--native-keyboard-bottom','" + keyboardBottomInset + "px');"
                + "})()";
        webView.evaluateJavascript(js, null);
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFY_PERMISSION_REQUEST);
        }
    }

    private void pushMessageToJs(String payload) {
        if (payload == null) return;
        runOnUiThread(() -> {
            synchronized (pendingJsMessages) {
                while (pendingJsMessages.size() >= 640) pendingJsMessages.removeFirst();
                pendingJsMessages.addLast(payload);
            }
            scheduleJsFlush();
        });
    }

    private void scheduleJsFlush() {
        if (webView == null || !webPageReady) return;
        synchronized (pendingJsMessages) {
            if (jsFlushScheduled) return;
            jsFlushScheduled = true;
        }
        webView.post(this::flushJsMessages);
    }

    private void flushJsMessages() {
        if (webView == null || !webPageReady) {
            synchronized (pendingJsMessages) { jsFlushScheduled = false; }
            return;
        }
        JSONArray batch = new JSONArray();
        boolean more;
        synchronized (pendingJsMessages) {
            int count = 0;
            while (!pendingJsMessages.isEmpty() && count++ < 80) {
                batch.put(pendingJsMessages.removeFirst());
            }
            more = !pendingJsMessages.isEmpty();
            if (!more) jsFlushScheduled = false;
        }
        if (batch.length() > 0) {
            webView.evaluateJavascript(
                    "window.DshRemote&&window.DshRemote.onNativeMessages(" + batch + ")", null);
        }
        if (more) webView.postDelayed(this::flushJsMessages, 16L);
    }

    private void showError(String message) {
        loadingBar.setVisibility(ProgressBar.GONE);
        webView.setVisibility(android.view.View.GONE);
        errorMessage.setText(message);
        errorView.setVisibility(android.view.View.VISIBLE);
    }

    @Override
    protected void onResume() {
        super.onResume();
        pushMessageToJs(RemoteService.getSnapshotJson(this));
        RemoteService.requestSnapshot(this);
    }

    @Override
    protected void onStart() {
        super.onStart();
        RemoteService.setAppInForeground(true);
    }

    @Override
    protected void onStop() {
        RemoteService.setAppInForeground(false);
        super.onStop();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER_REQUEST) {
            ValueCallback<Uri[]> callback = fileChooserCallback;
            fileChooserCallback = null;
            android.util.Log.i("DSHRemote", "onActivityResult FILE_CHOOSER resultCode=" + resultCode + " data=" + data);
            if (callback != null) {
                Uri[] results = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
                android.util.Log.i("DSHRemote", "parseResult results=" + (results != null ? String.valueOf(results.length) : "null"));
                callback.onReceiveValue(results);
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    protected void onDestroy() {
        webPageReady = false;
        synchronized (pendingJsMessages) {
            pendingJsMessages.clear();
            jsFlushScheduled = false;
        }
        if (fileChooserCallback != null) {
            fileChooserCallback.onReceiveValue(null);
            fileChooserCallback = null;
        }
        try {
            unregisterReceiver(remoteReceiver);
        } catch (Exception ignored) {
        }
        if (webView != null) webView.destroy();
        super.onDestroy();
    }

    public static final class RemoteJsBridge {
        private final Context context;

        RemoteJsBridge(Context context) {
            this.context = context.getApplicationContext();
        }

        @JavascriptInterface
        public String getSettings() { return RemoteService.getSettingsJson(context); }

        @JavascriptInterface
        public String getSnapshot() { return RemoteService.getSnapshotJson(context); }

        @JavascriptInterface
        public boolean isConnected() { return RemoteService.isTransportConnected(); }

        @JavascriptInterface
        public void connect(String endpoint, String token) { RemoteService.connect(context, endpoint, token); }

        @JavascriptInterface
        public void disconnect() { RemoteService.disconnect(context); }

        @JavascriptInterface
        public void downloadUpdate() { RemoteService.downloadUpdate(context); }

        @JavascriptInterface
        public void checkForUpdate() { RemoteService.checkForUpdate(context); }

        @JavascriptInterface
        public void requestSnapshot() { RemoteService.requestSnapshot(context); }

        @JavascriptInterface
        public boolean requestHistory(String sessionId, long beforeSeq, int limit) {
            return RemoteService.requestHistory(context, sessionId, beforeSeq, limit);
        }

        @JavascriptInterface
        public boolean refreshHistory(String sessionId, int limit) {
            return RemoteService.refreshHistory(context, sessionId, limit);
        }

        @JavascriptInterface
        public boolean activateSession(String sessionId) {
            return RemoteService.activateSession(context, sessionId);
        }

        @JavascriptInterface
        public boolean requestSessionContext(String sessionId) {
            return RemoteService.requestSessionContext(context, sessionId);
        }

        @JavascriptInterface
        public boolean createSession(String cwd, String projectId, String projectName) {
            return RemoteService.createSession(context, cwd, projectId, projectName);
        }

        @JavascriptInterface
        public void sendPrompt(String text) {
            sendPrompt(text, "[]", "");
        }

        @JavascriptInterface
        public void sendPrompt(String text, String attachmentsJson) {
            sendPrompt(text, attachmentsJson, "");
        }

        @JavascriptInterface
        public void sendPrompt(String text, String attachmentsJson, String sessionId) {
            android.util.Log.i("DSHRemote", "JS sendPrompt called: textLen=" + (text == null ? -1 : text.length()) + " sessionId=" + sessionId);
            JSONObject data = object("text", text);
            try {
                JSONArray attachments = new JSONArray(attachmentsJson == null ? "[]" : attachmentsJson);
                data.put("attachments", attachments);
            } catch (Exception ignored) { }
            try {
                RemoteService.control(context, "prompt.send", data, sessionId);
                android.util.Log.i("DSHRemote", "prompt.send dispatched to service");
            } catch (Exception error) {
                android.util.Log.e("DSHRemote", "prompt.send dispatch failed", error);
            }
        }

        @JavascriptInterface
        public void stopTask() { stopTask(""); }

        @JavascriptInterface
        public void stopTask(String sessionId) { RemoteService.control(context, "task.stop", new JSONObject(), sessionId); }

        @JavascriptInterface
        public void continueTask() { continueTask(""); }

        @JavascriptInterface
        public void continueTask(String sessionId) { RemoteService.control(context, "task.continue", new JSONObject(), sessionId); }

        @JavascriptInterface
        public void resolveApproval(boolean allow, String requestId) { resolveApproval(allow, requestId, ""); }

        @JavascriptInterface
        public void resolveApproval(boolean allow, String requestId, String sessionId) {
            RemoteService.control(context, allow ? "approval.allow" : "approval.deny", object("requestId", requestId), sessionId);
        }

        private JSONObject object(String key, String value) {
            JSONObject result = new JSONObject();
            try { result.put(key, value == null ? "" : value); } catch (Exception ignored) { }
            return result;
        }
    }
}
