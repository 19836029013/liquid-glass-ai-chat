package com.dsapp.liquidglasschat;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Matrix;
import android.media.ExifInterface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Looper;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.ProgressBar;
import android.widget.TextView;

import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicBoolean;

/** WebView host and the only JavaScript bridge exposed to the local asset page. */
@SuppressLint("ExifInterface") // minSdk 26 supports the platform InputStream constructor; no new dependency.
public final class MainActivity extends Activity {
    public static final String EXTRA_OPEN_SESSION_ID = "com.dsapp.dshremote.OPEN_SESSION_ID";
    public static final String EXTRA_OPEN_SESSION_TITLE = "com.dsapp.dshremote.OPEN_SESSION_TITLE";
    public static final String EXTRA_OPEN_PROJECT_ID = "com.dsapp.dshremote.OPEN_PROJECT_ID";
    public static final String EXTRA_OPEN_PROJECT_NAME = "com.dsapp.dshremote.OPEN_PROJECT_NAME";

    private static final String TAG = "DSHRemoteV2";
    /** DeepSeek-branded chat shell; its Remote entry embeds the existing DSH page. */
    private static final String START_ASSET_URL = "file:///android_asset/magic5-chat/index.html";
    private static final int NOTIFY_PERMISSION_REQUEST = 1002;
    private static final int FILE_CHOOSER_REQUEST = 2011;
    // Four adaptively-compressed images fit the deployed Bridge's 1 MiB inbound frame.
    private static final int MAX_SELECTED_IMAGES = 4;
    private static final int MAX_IMAGE_DIMENSION = 1600;
    private static final int MAX_DECODE_DIMENSION = 2048;
    private static final int MAX_JPEG_BYTES = 150 * 1024;
    private static final int MAX_BATCH_BASE64_CHARS = 840 * 1024;

    private WebView webView;
    private ProgressBar loadingBar;
    private android.view.View errorView;
    private TextView errorMessage;
    private RemoteJsBridge remoteJsBridge;

    private int safeTopInset;
    private int safeBottomInset;
    private int keyboardBottomInset;

    private ValueCallback<Uri[]> fileChooserCallback;
    private Uri pendingCameraUri;
    private File pendingCameraFile;
    private int fileChooserLaunchToken;
    private volatile int imageTaskGeneration;
    private int pendingSelectionLimit;
    /** Selected tasks not yet acknowledged by the front-end's file-picked handler. */
    private int imageSlotsAwaitingFrontend;
    private final ExecutorService imageExecutor = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "dsh-image-processor");
        thread.setDaemon(false);
        return thread;
    });

    private final ArrayDeque<JsFrame> pendingJsMessages = new ArrayDeque<>();
    private boolean jsDeliveryInFlight;
    private int jsDeliveryToken;
    private boolean webPageReady;
    private boolean activityDestroyed;
    private int pageGeneration;
    private String lastSnapshotPayload = "";
    private long observedMessageEpoch = Long.MIN_VALUE;
    private String pendingOpenSessionPayload = "";
    private int rendererRecoveryAttempts;
    private boolean rendererRecoveryScheduled;

    private final RemoteService.MessageListener remoteMessageListener = this::enqueueHubMessage;

    private static final class JsFrame {
        final String payload;
        final boolean hubOwned;
        final boolean releasesImageSlot;
        final long hubEpoch;
        final long hubFrameId;

        JsFrame(String payload, boolean hubOwned, boolean releasesImageSlot, long hubEpoch,
                long hubFrameId) {
            this.payload = payload;
            this.hubOwned = hubOwned;
            this.releasesImageSlot = releasesImageSlot;
            this.hubEpoch = hubOwned ? hubEpoch : 0L;
            this.hubFrameId = hubOwned ? hubFrameId : 0L;
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.webView);
        loadingBar = findViewById(R.id.loadingBar);
        errorView = findViewById(R.id.errorView);
        errorMessage = findViewById(R.id.errorMessage);

        configureWindowInsets();
        configureWebView();

        remoteJsBridge = new RemoteJsBridge(getApplicationContext());
        webView.addJavascriptInterface(remoteJsBridge, "AndroidRemote");
        // A newly created renderer has no endpoint-scoped JS state to clear. Only a later Hub
        // callback bearing a different epoch is allowed to trigger the endpoint reload below.
        observedMessageEpoch = RemoteService.currentMessageEpoch();
        RemoteService.registerMessageListener(remoteMessageListener);

        ((Button) findViewById(R.id.retryButton)).setOnClickListener(view -> {
            rendererRecoveryAttempts = 0;
            rendererRecoveryScheduled = false;
            if (webView != null) webView.reload();
        });
        ((Button) findViewById(R.id.settingsButton)).setOnClickListener(view ->
                enqueueNativeMessage("{\"type\":\"open-settings\",\"source\":\"native\"}"));

        captureNotificationIntent(getIntent());
        webView.loadUrl(START_ASSET_URL);
        requestNotificationPermission();
    }

    private void configureWindowInsets() {
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
            int keyboardPixels = insets.isVisible(WindowInsetsCompat.Type.ime())
                    ? Math.max(0, ime.bottom - bars.bottom) : 0;
            keyboardBottomInset = Math.round(keyboardPixels / density);
            applySafeAreaToWebView();
            return insets;
        });
        ViewCompat.requestApplyInsets(webView);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
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
        settings.setAllowContentAccess(true);
        settings.setAllowFileAccessFromFileURLs(true);
        // Native transport handles Bridge traffic. Do not expose AndroidRemote to arbitrary
        // network pages through file-origin universal access.
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setTextZoom(100);

        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        WebView.setWebContentsDebuggingEnabled(debuggable);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                pageGeneration++;
                webPageReady = false;
                if (remoteJsBridge != null) remoteJsBridge.beginPageLoad();
                discardStaleHubFrames();
                synchronized (pendingJsMessages) {
                    // Hub frames survive renderer replacement and retain their exact FIFO order.
                    // The current snapshot is replayed through MessageHub rather than inserted
                    // locally, so there is no special snapshot frame to remove here.
                    jsDeliveryInFlight = false;
                    jsDeliveryToken++;
                }
                lastSnapshotPayload = "";
                loadingBar.setVisibility(ProgressBar.VISIBLE);
                errorView.setVisibility(android.view.View.GONE);
                webView.setVisibility(android.view.View.VISIBLE);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (!isLocalAssetUrl(url)) return;
                webPageReady = true;
                // A previous renderer failure deliberately NACKs and unregisters this listener.
                // Registering here is the retry boundary for the retained Service frame.
                RemoteService.registerMessageListener(remoteMessageListener);
                loadingBar.setVisibility(ProgressBar.GONE);
                RemoteService.replaySnapshot(MainActivity.this);
                if (!pendingOpenSessionPayload.isEmpty()) {
                    String payload = pendingOpenSessionPayload;
                    pendingOpenSessionPayload = "";
                    enqueueNativeMessage(payload);
                }
                applySafeAreaToWebView();
                drainJsMessages();
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request == null ? null : request.getUrl();
                String url = uri == null ? "" : uri.toString();
                if (isLocalAssetUrl(url) || "about:blank".equals(url)) return false;
                if (uri != null) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, uri));
                    } catch (ActivityNotFoundException ignored) {
                    }
                }
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request,
                                        WebResourceError error) {
                if (request != null && request.isForMainFrame()) {
                    CharSequence description = error == null ? "未知错误" : error.getDescription();
                    showError("页面加载失败：" + description);
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int progress) {
                loadingBar.setProgress(progress);
                if (progress >= 100) loadingBar.setVisibility(ProgressBar.GONE);
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                return launchImageChooser(callback, params);
            }
        });
    }

    private boolean isLocalAssetUrl(String url) {
        return url != null && url.startsWith("file:///android_asset/");
    }

    private void captureNotificationIntent(Intent intent) {
        if (intent == null) return;
        String sessionId = trim(intent.getStringExtra(EXTRA_OPEN_SESSION_ID));
        if (sessionId.isEmpty()) return;
        try {
            JSONObject data = new JSONObject()
                    .put("id", sessionId)
                    .put("title", safe(intent.getStringExtra(EXTRA_OPEN_SESSION_TITLE), "DSH Remote"))
                    .put("projectId", safe(intent.getStringExtra(EXTRA_OPEN_PROJECT_ID), ""))
                    .put("projectName", safe(intent.getStringExtra(EXTRA_OPEN_PROJECT_NAME), "DSH"));
            String payload = new JSONObject()
                    .put("type", "open-session")
                    .put("source", "native")
                    .put("data", data)
                    .toString();
            if (webPageReady) enqueueNativeMessage(payload);
            else pendingOpenSessionPayload = payload;
        } catch (Throwable error) {
            Log.e(TAG, "Unable to route notification intent", error);
        }
        intent.removeExtra(EXTRA_OPEN_SESSION_ID);
        intent.removeExtra(EXTRA_OPEN_SESSION_TITLE);
        intent.removeExtra(EXTRA_OPEN_PROJECT_ID);
        intent.removeExtra(EXTRA_OPEN_PROJECT_NAME);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        captureNotificationIntent(intent);
    }

    private boolean enqueueNativeMessage(String rawPayload) {
        return enqueueJsFrame(rawPayload, false, false, 0L, 0L);
    }

    private boolean enqueueImageResult(String rawPayload, int taskGeneration) {
        if (taskGeneration != imageTaskGeneration || rawPayload == null
                || activityDestroyed || webView == null) return false;
        if (Looper.myLooper() == Looper.getMainLooper()) {
            return enqueueJsFrameOnMain(rawPayload, false, true, 0L, 0L);
        }
        runOnUiThread(() -> {
            if (taskGeneration == imageTaskGeneration) {
                enqueueJsFrameOnMain(rawPayload, false, true, 0L, 0L);
            }
        });
        return true;
    }

    /** MessageHub invokes this on the main looper and retains ownership until JS ACKs it. */
    private boolean enqueueHubMessage(String rawPayload, long epoch, long frameId) {
        if (Looper.myLooper() != Looper.getMainLooper()) return false;
        if (epoch != RemoteService.currentMessageEpoch()) {
            RemoteService.acknowledgeMessage(frameId, true);
            return true;
        }
        if (epoch != observedMessageEpoch) transitionToMessageEpoch(epoch);
        else discardStaleHubFrames();
        if (epoch != RemoteService.currentMessageEpoch()) {
            RemoteService.acknowledgeMessage(frameId, true);
            return true;
        }
        synchronized (pendingJsMessages) {
            for (JsFrame frame : pendingJsMessages) {
                if (frame.hubOwned && frame.hubFrameId == frameId) return true;
            }
        }
        return enqueueJsFrameOnMain(rawPayload, true, false, epoch, frameId);
    }

    private boolean enqueueJsFrame(String rawPayload, boolean hubOwned,
                                   boolean releasesImageSlot, long hubEpoch, long hubFrameId) {
        if (rawPayload == null || activityDestroyed || webView == null) return false;
        if (Looper.myLooper() == Looper.getMainLooper()) {
            return enqueueJsFrameOnMain(rawPayload, hubOwned, releasesImageSlot,
                    hubEpoch, hubFrameId);
        }
        runOnUiThread(() -> enqueueJsFrameOnMain(rawPayload, hubOwned,
                releasesImageSlot, hubEpoch, hubFrameId));
        return true;
    }

    private boolean enqueueJsFrameOnMain(String rawPayload, boolean hubOwned,
                                         boolean releasesImageSlot, long hubEpoch,
                                         long hubFrameId) {
        if (rawPayload == null || activityDestroyed || webView == null) return false;
        discardStaleHubFrames();
        if (hubOwned && hubEpoch != RemoteService.currentMessageEpoch()) {
            RemoteService.acknowledgeMessage(hubFrameId, true);
            return true;
        }
        // Every producer creates a native envelope before it reaches this queue. Do not parse and
        // re-serialize large histories here: doing so can briefly double their base64 heap cost.
        boolean snapshot = isMessageType(rawPayload, "session.snapshot");
        String snapshotFingerprint = snapshot ? snapshotFingerprint(rawPayload) : "";
        if (snapshot && snapshotFingerprint.equals(lastSnapshotPayload)) {
            if (hubOwned) RemoteService.acknowledgeMessage(hubFrameId, true);
            if (releasesImageSlot && imageSlotsAwaitingFrontend > 0) {
                imageSlotsAwaitingFrontend--;
            }
            return true;
        }
        if (snapshot) lastSnapshotPayload = snapshotFingerprint;
        synchronized (pendingJsMessages) {
            pendingJsMessages.addLast(new JsFrame(rawPayload, hubOwned,
                    releasesImageSlot, hubEpoch, hubFrameId));
        }
        drainJsMessages();
        return true;
    }

    /**
     * The frozen app.js cannot clear selectedChat/history from an empty snapshot. Rebuild its
     * realm exactly once when MessageHub proves that a new authenticated endpoint is producing
     * frames. The incoming new-epoch frame remains Hub-owned and is queued after this returns.
     */
    private void transitionToMessageEpoch(long epoch) {
        if (epoch == observedMessageEpoch) return;
        observedMessageEpoch = epoch; // Set first so a synchronous/re-entrant callback cannot reload twice.
        ArrayDeque<JsFrame> discarded = new ArrayDeque<>();
        synchronized (pendingJsMessages) {
            jsDeliveryInFlight = false;
            jsDeliveryToken++;
            java.util.Iterator<JsFrame> iterator = pendingJsMessages.iterator();
            while (iterator.hasNext()) {
                JsFrame frame = iterator.next();
                if (frame.hubOwned) {
                    if (frame.hubEpoch == epoch) continue;
                    iterator.remove();
                    discarded.addLast(frame);
                } else if (frame.releasesImageSlot
                        || isMessageType(frame.payload, "file-picked")
                        || isMessageType(frame.payload, "open-session")) {
                    // These local frames were produced for the old WebView/endpoint selection.
                    iterator.remove();
                }
            }
        }
        pendingOpenSessionPayload = "";
        lastSnapshotPayload = "";
        imageSlotsAwaitingFrontend = 0;
        imageTaskGeneration++;
        pendingSelectionLimit = 0;
        fileChooserLaunchToken++;

        ValueCallback<Uri[]> chooser = fileChooserCallback;
        fileChooserCallback = null;
        if (chooser != null) {
            try {
                chooser.onReceiveValue(null);
            } catch (Throwable error) {
                Log.w(TAG, "Unable to finish retired image chooser", error);
            }
        }
        cleanupPendingCameraFile();

        for (JsFrame frame : discarded) {
            // The retired endpoint can never be replayed into this renderer.
            RemoteService.acknowledgeMessage(frame.hubFrameId, true);
        }

        if (!activityDestroyed && webView != null && isLocalAssetUrl(webView.getUrl())) {
            webPageReady = false; // Prevent the incoming new-epoch frame reaching the old JS realm.
            rendererRecoveryAttempts = 0;
            rendererRecoveryScheduled = false;
            webView.reload();
        }
    }

    /** Drops retired Hub frames but never advances observedMessageEpoch or reloads the page. */
    private void discardStaleHubFrames() {
        long currentEpoch = RemoteService.currentMessageEpoch();
        ArrayDeque<JsFrame> discarded = new ArrayDeque<>();
        synchronized (pendingJsMessages) {
            boolean cancelledDelivery = false;
            java.util.Iterator<JsFrame> iterator = pendingJsMessages.iterator();
            while (iterator.hasNext()) {
                JsFrame frame = iterator.next();
                if (!frame.hubOwned || frame.hubEpoch == currentEpoch) continue;
                if (frame == pendingJsMessages.peekFirst() && jsDeliveryInFlight) {
                    cancelledDelivery = true;
                }
                iterator.remove();
                discarded.addLast(frame);
            }
            if (cancelledDelivery) {
                jsDeliveryInFlight = false;
                jsDeliveryToken++;
            }
        }
        for (JsFrame frame : discarded) {
            RemoteService.acknowledgeMessage(frame.hubFrameId, true);
        }
    }

    private boolean isMessageType(String payload, String expected) {
        // Lightweight top-level discriminator.  JSONObject parsing here used to duplicate very
        // large history/image frames on the UI thread.  Native envelopes always emit type near
        // the beginning, so cap the scan and leave the payload itself untouched.
        int limit = Math.min(payload.length(), 1024);
        int key = payload.indexOf("\"type\"");
        if (key < 0 || key >= limit) return false;
        int colon = payload.indexOf(':', key + 6);
        if (colon < 0 || colon >= limit) return false;
        int cursor = colon + 1;
        while (cursor < limit && Character.isWhitespace(payload.charAt(cursor))) cursor++;
        if (cursor >= limit || payload.charAt(cursor) != '\"') return false;
        int end = payload.indexOf('\"', cursor + 1);
        return end > cursor && end <= limit && expected.equals(payload.substring(cursor + 1, end));
    }

    private String snapshotFingerprint(String payload) {
        try {
            Object data = new JSONObject(payload).opt("data");
            return data == null || data == JSONObject.NULL ? "null" : data.toString();
        } catch (Throwable ignored) {
            return payload;
        }
    }

    /** Delivers exactly one JS message at a time; the evaluate callback is the FIFO acknowledgement. */
    private void drainJsMessages() {
        discardStaleHubFrames();
        if (!webPageReady || webView == null) return;
        final JsFrame frame;
        final String payload;
        final int generation = pageGeneration;
        final int deliveryToken;
        synchronized (pendingJsMessages) {
            if (jsDeliveryInFlight || pendingJsMessages.isEmpty()) return;
            jsDeliveryInFlight = true;
            deliveryToken = ++jsDeliveryToken;
            frame = pendingJsMessages.peekFirst();
            payload = frame.payload;
        }
        String script = "(function(){var d=window.DshRemote;"
                + "if(!d||typeof d.onNativeMessage!=='function')return 0;"
                + "var raw=" + JSONObject.quote(payload) + ";"
                + "try{var parsed=JSON.parse(raw);if(parsed&&parsed.type==='file-picked'&&"
                + "typeof window.dispatchEvent==='function'){window.dispatchEvent(new CustomEvent('native-file-picked',{detail:parsed}));}}catch(e){}"
                + "try{d.onNativeMessage(raw);return 1;}"
                + "catch(e){console.error('DSH native message failed',e);return -1;}})()";
        webView.evaluateJavascript(script, result -> {
            discardStaleHubFrames();
            if (generation != pageGeneration || deliveryToken != jsDeliveryToken) return;
            boolean delivered = "1".equals(result);
            boolean handlerFailed = "-1".equals(result);
            boolean acknowledgeHub = false;
            boolean nackHub = false;
            synchronized (pendingJsMessages) {
                if (pendingJsMessages.peekFirst() == frame) {
                    if (delivered) {
                        pendingJsMessages.removeFirst();
                        acknowledgeHub = frame.hubOwned;
                        if (frame.releasesImageSlot && imageSlotsAwaitingFrontend > 0) {
                            imageSlotsAwaitingFrontend--;
                        }
                    } else if (handlerFailed && frame.hubOwned) {
                        nackHub = true;
                    }
                }
                jsDeliveryInFlight = false;
            }
            if (acknowledgeHub) {
                RemoteService.acknowledgeMessage(frame.hubFrameId, true);
            }
            if (nackHub) {
                RemoteService.acknowledgeMessage(frame.hubFrameId, false);
            }
            if (handlerFailed) {
                // Keep non-Service frames at the head as well; reload is the explicit retry
                // boundary and no message is silently converted into success.
                webPageReady = false;
                Log.e(TAG, "Front-end rejected native frame; retained for page reload: "
                        + compactForLog(payload, 160));
                scheduleRendererRecovery();
            }
            if (delivered) {
                rendererRecoveryAttempts = 0;
                drainJsMessages();
            }
            else if (webView != null) webView.postDelayed(this::drainJsMessages, 50L);
        });
        webView.postDelayed(() -> {
            discardStaleHubFrames();
            if (generation != pageGeneration) return;
            boolean nackHub = false;
            synchronized (pendingJsMessages) {
                if (!jsDeliveryInFlight || deliveryToken != jsDeliveryToken) return;
                if (pendingJsMessages.peekFirst() == frame && frame.hubOwned) {
                    nackHub = true;
                }
                jsDeliveryInFlight = false;
                jsDeliveryToken++;
            }
            if (nackHub) {
                RemoteService.acknowledgeMessage(frame.hubFrameId, false);
            }
            webPageReady = false;
            Log.e(TAG, "WebView did not acknowledge native frame within 10 seconds: "
                    + compactForLog(payload, 160));
            scheduleRendererRecovery();
        }, 10_000L);
    }

    private void scheduleRendererRecovery() {
        if (activityDestroyed || webView == null || rendererRecoveryScheduled) return;
        if (rendererRecoveryAttempts >= 2) {
            showError("页面消息处理失败；消息已安全保留，请点“重试”重新加载");
            return;
        }
        rendererRecoveryAttempts++;
        rendererRecoveryScheduled = true;
        webView.postDelayed(() -> {
            rendererRecoveryScheduled = false;
            if (!activityDestroyed && webView != null) webView.reload();
        }, 250L);
    }

    private void applySafeAreaToWebView() {
        if (webView == null || !webPageReady) return;
        String script = "(function(){var r=document.documentElement;if(!r)return;"
                + "r.style.setProperty('--native-safe-top','" + safeTopInset + "px');"
                + "r.style.setProperty('--native-safe-bottom','" + safeBottomInset + "px');"
                + "r.style.setProperty('--native-keyboard-bottom','" + keyboardBottomInset + "px');"
                + "var f=document.getElementById('remoteApp'),d=f&&f.contentDocument&&f.contentDocument.documentElement;"
                + "if(d){d.style.setProperty('--native-safe-top','" + safeTopInset + "px');"
                + "d.style.setProperty('--native-safe-bottom','" + safeBottomInset + "px');"
                + "d.style.setProperty('--native-keyboard-bottom','" + keyboardBottomInset + "px');}"
                + "})()";
        webView.evaluateJavascript(script, null);
    }

    private void showError(String message) {
        loadingBar.setVisibility(ProgressBar.GONE);
        webView.setVisibility(android.view.View.GONE);
        errorMessage.setText(message);
        errorView.setVisibility(android.view.View.VISIBLE);
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},
                    NOTIFY_PERMISSION_REQUEST);
        }
    }

    // -----------------------------------------------------------------------------------------
    // File chooser and image pipeline
    // -----------------------------------------------------------------------------------------

    private boolean launchImageChooser(ValueCallback<Uri[]> callback,
                                       WebChromeClient.FileChooserParams params) {
        if (fileChooserCallback != null) fileChooserCallback.onReceiveValue(null);
        fileChooserCallback = callback;
        pendingSelectionLimit = 0;
        cleanupPendingCameraFile();
        final int launchToken = ++fileChooserLaunchToken;

        // The frozen page keeps prior selections in state.pendingImages. Count its rendered
        // chips and Java-side image jobs together so repeated picker launches can never build a
        // prompt with more than four attachments.
        String countScript = "(function(){var e=document.getElementById('chatComposerImages');"
                + "return e?e.querySelectorAll('.chat-image-chip').length:0;})()";
        webView.evaluateJavascript(countScript, result -> {
            int existing = 0;
            try {
                existing = Math.max(0, Integer.parseInt(safe(result, "0")
                        .replace("\"", "").trim()));
            } catch (Throwable ignored) {
            }
            openImageChooserIfPending(callback, params, launchToken,
                    MAX_SELECTED_IMAGES - existing - imageSlotsAwaitingFrontend);
        });
        // If the renderer cannot answer, fail closed instead of guessing and allowing a fifth
        // attachment. The callback is still completed, so WebView never remains wedged.
        webView.postDelayed(() -> openImageChooserIfPending(callback, params, launchToken, 0),
                750L);
        return true;
    }

    private void openImageChooserIfPending(ValueCallback<Uri[]> callback,
                                           WebChromeClient.FileChooserParams params,
                                           int launchToken, int remainingSlots) {
        if (activityDestroyed || launchToken != fileChooserLaunchToken
                || fileChooserCallback != callback || pendingSelectionLimit > 0) return;
        if (remainingSlots <= 0) {
            fileChooserCallback = null;
            fileChooserLaunchToken++;
            callback.onReceiveValue(null);
            pushFilePickedError("一次最多添加 " + MAX_SELECTED_IMAGES + " 张图片，请先删除已有图片");
            return;
        }
        pendingSelectionLimit = Math.min(MAX_SELECTED_IMAGES, remainingSlots);

        Intent picker = buildPickerIntent(params, pendingSelectionLimit);
        Intent camera = buildCameraIntent();
        Intent launch = picker;
        if (camera != null) {
            launch = Intent.createChooser(picker, "选择图片");
            launch.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[]{camera});
        }
        try {
            startActivityForResult(launch, FILE_CHOOSER_REQUEST);
            return;
        } catch (Throwable firstError) {
            Log.w(TAG, "Primary image picker failed", firstError);
            cleanupPendingCameraFile();
            try {
                Intent fallback = new Intent(Intent.ACTION_OPEN_DOCUMENT)
                        .addCategory(Intent.CATEGORY_OPENABLE)
                        .setType("image/*")
                        .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, pendingSelectionLimit > 1)
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
                startActivityForResult(fallback, FILE_CHOOSER_REQUEST);
            } catch (Throwable fallbackError) {
                Log.e(TAG, "No usable image picker", fallbackError);
                fileChooserCallback = null;
                pendingSelectionLimit = 0;
                fileChooserLaunchToken++;
                callback.onReceiveValue(null);
                pushFilePickedError("无法打开系统图库：" + errorLabel(fallbackError));
            }
        }
    }

    private Intent buildPickerIntent(WebChromeClient.FileChooserParams params, int selectionLimit) {
        if (Build.VERSION.SDK_INT >= 33) {
            Intent picker = new Intent(MediaStore.ACTION_PICK_IMAGES).setType("image/*")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            int platformLimit = MediaStore.getPickImagesMaxLimit();
            if (selectionLimit > 1 && platformLimit > 1) {
                picker.putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX,
                        Math.min(selectionLimit, platformLimit));
            }
            return picker;
        }

        Intent picker = null;
        if (params != null) {
            try {
                picker = params.createIntent();
            } catch (Throwable ignored) {
            }
        }
        if (picker == null || Intent.ACTION_CHOOSER.equals(picker.getAction())) {
            picker = new Intent(Intent.ACTION_OPEN_DOCUMENT)
                    .addCategory(Intent.CATEGORY_OPENABLE);
        }
        picker.setType("image/*");
        picker.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, selectionLimit > 1);
        picker.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        return picker;
    }

    private Intent buildCameraIntent() {
        try {
            File directory = new File(getCacheDir(), "share");
            if (!directory.isDirectory() && !directory.mkdirs()) return null;
            pendingCameraFile = File.createTempFile("camera-", ".jpg", directory);
            pendingCameraUri = FileProvider.getUriForFile(this,
                    getPackageName() + ".fileprovider", pendingCameraFile);
            Intent camera = new Intent(MediaStore.ACTION_IMAGE_CAPTURE)
                    .putExtra(MediaStore.EXTRA_OUTPUT, pendingCameraUri)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                            | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            camera.setClipData(ClipData.newRawUri("DSH camera output", pendingCameraUri));
            return camera;
        } catch (Throwable error) {
            Log.w(TAG, "Camera intent unavailable", error);
            cleanupPendingCameraFile();
            return null;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != FILE_CHOOSER_REQUEST) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }

        ValueCallback<Uri[]> callback = fileChooserCallback;
        fileChooserCallback = null;
        int selectionLimit = Math.max(1, pendingSelectionLimit);
        pendingSelectionLimit = 0;
        fileChooserLaunchToken++;
        LinkedHashSet<Uri> selected = new LinkedHashSet<>();
        File cameraFile = pendingCameraFile;
        Uri cameraUri = pendingCameraUri;
        pendingCameraFile = null;
        pendingCameraUri = null;

        // An endpoint transition completes the old chooser with null. A late Activity result must
        // not recreate its selections inside the freshly reloaded endpoint.
        if (callback == null) {
            if (cameraFile != null && cameraFile.isFile() && !cameraFile.delete()) {
                Log.w(TAG, "Unable to delete retired camera file: " + cameraFile);
            }
            return;
        }

        if (resultCode == RESULT_OK) {
            try {
                Uri[] parsed = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
                if (parsed != null) {
                    for (Uri uri : parsed) if (uri != null) selected.add(uri);
                }
            } catch (Throwable error) {
                Log.w(TAG, "FileChooserParams.parseResult failed", error);
            }
            if (data != null && data.getData() != null) selected.add(data.getData());
            if (data != null && data.getClipData() != null) {
                ClipData clips = data.getClipData();
                for (int index = 0; index < clips.getItemCount(); index++) {
                    Uri uri = clips.getItemAt(index).getUri();
                    if (uri != null) selected.add(uri);
                }
            }
            if (selected.isEmpty() && cameraUri != null && cameraFile != null
                    && cameraFile.isFile() && cameraFile.length() > 0L) {
                selected.add(cameraUri);
            }
        }

        // This is deliberately null: WebView must never synthesize an unreadable File from a
        // content:// Uri on file:///android_asset. Java sends each image as file-picked instead.
        if (callback != null) callback.onReceiveValue(null);

        if (selected.isEmpty()) {
            if (cameraFile != null && cameraFile.isFile() && !cameraFile.delete()) {
                Log.w(TAG, "Unable to delete unused camera file: " + cameraFile);
            }
            if (resultCode == RESULT_OK) pushFilePickedError("系统图库没有返回可读取的图片");
            return;
        }

        persistReadPermissions(data, selected);
        ImageBatchBudget batchBudget = new ImageBatchBudget(MAX_BATCH_BASE64_CHARS);
        final int taskGeneration = imageTaskGeneration;
        int count = 0;
        for (Uri uri : selected) {
            if (count++ >= selectionLimit) break;
            File deleteAfter = cameraUri != null && cameraUri.equals(uri) ? cameraFile : null;
            imageSlotsAwaitingFrontend++;
            try {
                imageExecutor.execute(() -> processPickedImage(
                        uri, deleteAfter, batchBudget, taskGeneration));
            } catch (RejectedExecutionException ignored) {
                imageSlotsAwaitingFrontend = Math.max(0, imageSlotsAwaitingFrontend - 1);
                if (deleteAfter != null && deleteAfter.isFile()) deleteAfter.delete();
            }
        }
        if (selected.size() > selectionLimit) {
            pushFilePickedError("本次还可添加 " + selectionLimit
                    + " 张图片；其余图片未加入，累计最多 " + MAX_SELECTED_IMAGES + " 张");
        }
        if (cameraFile != null && cameraFile.isFile() && !selected.contains(cameraUri)
                && !cameraFile.delete()) {
            Log.w(TAG, "Unable to delete unused camera file: " + cameraFile);
        }
    }

    @SuppressLint("WrongConstant") // flags is explicitly masked to the two permitted grant bits.
    private void persistReadPermissions(Intent result, Set<Uri> uris) {
        if (result == null) return;
        int flags = result.getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        if (flags == 0) return;
        if ((result.getFlags() & Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION) == 0) return;
        for (Uri uri : uris) {
            try {
                getContentResolver().takePersistableUriPermission(uri, flags);
            } catch (Throwable ignored) {
                // PhotoPicker grants are not persistable; the temporary grant is enough here.
            }
        }
    }

    private void processPickedImage(Uri uri, File deleteAfter, ImageBatchBudget batchBudget,
                                    int taskGeneration) {
        Bitmap bitmap = null;
        Bitmap transformed = null;
        Bitmap flattened = null;
        try {
            if (taskGeneration != imageTaskGeneration) return;
            ImageBounds bounds = readBounds(uri);
            if (bounds.width <= 0 || bounds.height <= 0) {
                throw new IOException("无法读取图片尺寸");
            }
            int sample = 1;
            while (bounds.width / sample > MAX_DECODE_DIMENSION
                    || bounds.height / sample > MAX_DECODE_DIMENSION) {
                sample <<= 1;
            }

            BitmapFactory.Options options = new BitmapFactory.Options();
            options.inSampleSize = sample;
            options.inPreferredConfig = Bitmap.Config.ARGB_8888;
            try (InputStream input = getContentResolver().openInputStream(uri)) {
                if (input == null) throw new IOException("ContentResolver 无法打开图片");
                bitmap = BitmapFactory.decodeStream(input, null, options);
            }
            if (bitmap == null) throw new IOException("BitmapFactory 解码失败");

            float scale = Math.min(1f, (float) MAX_IMAGE_DIMENSION
                    / Math.max(bitmap.getWidth(), bitmap.getHeight()));
            Matrix matrix = exifMatrix(readExifOrientation(uri));
            if (scale < 1f) matrix.postScale(scale, scale);
            if (!matrix.isIdentity()) {
                transformed = Bitmap.createBitmap(bitmap, 0, 0,
                        bitmap.getWidth(), bitmap.getHeight(), matrix, true);
            } else {
                transformed = bitmap;
            }

            Bitmap jpegSource = transformed;
            if (transformed.hasAlpha()) {
                flattened = Bitmap.createBitmap(transformed.getWidth(), transformed.getHeight(),
                        Bitmap.Config.ARGB_8888);
                Canvas canvas = new Canvas(flattened);
                canvas.drawColor(Color.WHITE);
                canvas.drawBitmap(transformed, 0f, 0f, null);
                jpegSource = flattened;
            }

            byte[] jpeg = encodeJpegWithinBudget(jpegSource);
            String encoded = Base64.encodeToString(jpeg, Base64.NO_WRAP);
            if (!batchBudget.reserve(encoded.length())) {
                throw new IOException("本次图片总大小超过安全预算；请分批发送");
            }
            String dataUrl = "data:image/jpeg;base64,"
                    + encoded;
            JSONObject payload = new JSONObject()
                    .put("type", "file-picked")
                    .put("source", "native")
                    .put("data", new JSONObject()
                            .put("name", jpegName(queryDisplayName(uri)))
                            .put("mediaType", "image/jpeg")
                            .put("mimeType", "image/jpeg")
                            .put("dataUrl", dataUrl));
            enqueueImageResult(payload.toString(), taskGeneration);
        } catch (Throwable error) {
            Log.e(TAG, "Image processing failed for " + uri, error);
            if (taskGeneration == imageTaskGeneration) {
                pushProcessedImageError(errorLabel(error), taskGeneration);
            }
        } finally {
            if (flattened != null && !flattened.isRecycled()) flattened.recycle();
            if (transformed != null && transformed != bitmap && !transformed.isRecycled()) {
                transformed.recycle();
            }
            if (bitmap != null && !bitmap.isRecycled()) bitmap.recycle();
            if (deleteAfter != null && deleteAfter.isFile() && !deleteAfter.delete()) {
                Log.w(TAG, "Unable to delete camera temp file: " + deleteAfter);
            }
        }
    }

    /** Starts at the specified JPEG≈80 quality and only reduces quality/size when required. */
    private byte[] encodeJpegWithinBudget(Bitmap source) throws IOException {
        Bitmap working = source;
        ByteArrayOutputStream output = new ByteArrayOutputStream(MAX_JPEG_BYTES);
        int[] qualities = {80, 72, 64, 56, 48};
        try {
            for (;;) {
                for (int quality : qualities) {
                    output.reset();
                    if (!working.compress(Bitmap.CompressFormat.JPEG, quality, output)) {
                        throw new IOException("JPEG 压缩失败");
                    }
                    if (output.size() <= MAX_JPEG_BYTES) return output.toByteArray();
                }
                int longest = Math.max(working.getWidth(), working.getHeight());
                if (longest <= 480) {
                    throw new IOException("图片压缩后仍超过 " + MAX_JPEG_BYTES + " 字节");
                }
                float scale = Math.max(480f / longest, 0.80f);
                int width = Math.max(1, Math.round(working.getWidth() * scale));
                int height = Math.max(1, Math.round(working.getHeight() * scale));
                Bitmap smaller = Bitmap.createScaledBitmap(working, width, height, true);
                if (working != source && !working.isRecycled()) working.recycle();
                working = smaller;
            }
        } finally {
            if (working != source && !working.isRecycled()) working.recycle();
        }
    }

    private ImageBounds readBounds(Uri uri) throws IOException {
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inJustDecodeBounds = true;
        try (InputStream input = getContentResolver().openInputStream(uri)) {
            if (input == null) throw new IOException("ContentResolver 无法打开图片");
            BitmapFactory.decodeStream(input, null, options);
        }
        return new ImageBounds(options.outWidth, options.outHeight);
    }

    private int readExifOrientation(Uri uri) {
        try (InputStream input = getContentResolver().openInputStream(uri)) {
            if (input == null) return ExifInterface.ORIENTATION_NORMAL;
            return new ExifInterface(input).getAttributeInt(
                    ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
        } catch (Throwable ignored) {
            return ExifInterface.ORIENTATION_NORMAL;
        }
    }

    private Matrix exifMatrix(int orientation) {
        Matrix matrix = new Matrix();
        switch (orientation) {
            case ExifInterface.ORIENTATION_FLIP_HORIZONTAL:
                matrix.postScale(-1f, 1f);
                break;
            case ExifInterface.ORIENTATION_ROTATE_180:
                matrix.postRotate(180f);
                break;
            case ExifInterface.ORIENTATION_FLIP_VERTICAL:
                matrix.postScale(1f, -1f);
                break;
            case ExifInterface.ORIENTATION_TRANSPOSE:
                matrix.postRotate(90f);
                matrix.postScale(-1f, 1f);
                break;
            case ExifInterface.ORIENTATION_ROTATE_90:
                matrix.postRotate(90f);
                break;
            case ExifInterface.ORIENTATION_TRANSVERSE:
                matrix.postRotate(-90f);
                matrix.postScale(-1f, 1f);
                break;
            case ExifInterface.ORIENTATION_ROTATE_270:
                matrix.postRotate(-90f);
                break;
            default:
                break;
        }
        return matrix;
    }

    private String queryDisplayName(Uri uri) {
        try (Cursor cursor = getContentResolver().query(uri,
                new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int column = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (column >= 0) {
                    String name = cursor.getString(column);
                    if (!trim(name).isEmpty()) return name;
                }
            }
        } catch (Throwable ignored) {
        }
        return "photo.jpg";
    }

    private String jpegName(String original) {
        String name = safe(original, "photo").replaceAll("(?i)\\.[a-z0-9]{1,8}$", "");
        return (name.isEmpty() ? "photo" : name) + ".jpg";
    }

    private void pushFilePickedError(String message) {
        try {
            enqueueNativeMessage(new JSONObject()
                    .put("type", "file-picked")
                    .put("source", "native")
                    .put("data", new JSONObject()
                            .put("error", true)
                            .put("message", safe(message, "图片处理失败")))
                    .toString());
        } catch (Throwable ignored) {
        }
    }

    private void pushProcessedImageError(String message, int taskGeneration) {
        try {
            enqueueImageResult(new JSONObject()
                    .put("type", "file-picked")
                    .put("source", "native")
                    .put("data", new JSONObject()
                            .put("error", true)
                            .put("message", safe(message, "图片处理失败")))
                    .toString(), taskGeneration);
        } catch (Throwable ignored) {
            runOnUiThread(() -> {
                if (taskGeneration == imageTaskGeneration) {
                    imageSlotsAwaitingFrontend = Math.max(0, imageSlotsAwaitingFrontend - 1);
                }
            });
        }
    }

    private void cleanupPendingCameraFile() {
        if (pendingCameraFile != null && pendingCameraFile.isFile()
                && !pendingCameraFile.delete()) {
            Log.w(TAG, "Unable to delete pending camera file: " + pendingCameraFile);
        }
        pendingCameraFile = null;
        pendingCameraUri = null;
    }

    private static final class ImageBounds {
        final int width;
        final int height;

        ImageBounds(int width, int height) {
            this.width = width;
            this.height = height;
        }
    }

    private static final class ImageBatchBudget {
        private final int maximumChars;
        private int usedChars;

        ImageBatchBudget(int maximumChars) {
            this.maximumChars = maximumChars;
        }

        synchronized boolean reserve(int chars) {
            if (chars < 0 || usedChars + (long) chars > maximumChars) return false;
            usedChars += chars;
            return true;
        }
    }

    // -----------------------------------------------------------------------------------------
    // Activity lifecycle
    // -----------------------------------------------------------------------------------------

    @Override
    protected void onStart() {
        super.onStart();
        RemoteService.setAppInForeground(true);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
        RemoteService.replaySnapshot(this);
        RemoteService.requestSnapshot(this);
    }

    @Override
    protected void onPause() {
        if (webView != null) webView.onPause();
        super.onPause();
    }

    @Override
    protected void onStop() {
        RemoteService.setAppInForeground(false);
        super.onStop();
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (webView == null || activityDestroyed) {
            super.onBackPressed();
            return;
        }
        webView.evaluateJavascript(
                "(function(){try{return window.handleSystemBack?!!window.handleSystemBack():false;}catch(e){return false;}})()",
                result -> {
                    if (!"true".equals(result) && !activityDestroyed) moveTaskToBack(true);
                });
    }

    @Override
    protected void onDestroy() {
        activityDestroyed = true;
        webPageReady = false;
        pageGeneration++;
        discardStaleHubFrames();
        ArrayDeque<JsFrame> retainedHubFrames = new ArrayDeque<>();
        synchronized (pendingJsMessages) {
            for (JsFrame frame : pendingJsMessages) {
                if (frame.hubOwned) retainedHubFrames.addLast(frame);
            }
            pendingJsMessages.clear();
            jsDeliveryInFlight = false;
            jsDeliveryToken++;
            imageSlotsAwaitingFrontend = 0;
        }
        for (JsFrame frame : retainedHubFrames) {
            RemoteService.acknowledgeMessage(frame.hubFrameId, false);
        }
        RemoteService.unregisterMessageListener(remoteMessageListener);
        if (fileChooserCallback != null) {
            fileChooserCallback.onReceiveValue(null);
            fileChooserCallback = null;
        }
        fileChooserLaunchToken++;
        imageTaskGeneration++;
        pendingSelectionLimit = 0;
        cleanupPendingCameraFile();
        imageExecutor.shutdownNow();
        if (remoteJsBridge != null) remoteJsBridge.shutdown();
        if (webView != null) {
            webView.removeJavascriptInterface("AndroidRemote");
            webView.stopLoading();
            webView.setWebChromeClient(null);
            webView.setWebViewClient(null);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    // -----------------------------------------------------------------------------------------
    // Fixed JavaScript interface used by app.js (including its real extra methods)
    // -----------------------------------------------------------------------------------------

    private void postDeepSeekEvent(String name, JSONObject data) {
        if (activityDestroyed || webView == null) return;
        String payload = data == null ? "{}" : data.toString();
        String eventName = JSONObject.quote(name);
        String eventPayload = JSONObject.quote(payload);
        String script = "(function(){"
                + "var n=" + eventName + ",p=" + eventPayload + ";"
                + "var e=window.DeepSeekEvents;"
                + "if(e&&typeof e.onEvent==='function')e.onEvent(n,p);"
                + "})()";
        runOnUiThread(() -> {
            if (!activityDestroyed && webView != null) webView.evaluateJavascript(script, null);
        });
    }

    public final class RemoteJsBridge {
        private final Context context;
        private final AtomicBoolean firstConnect = new AtomicBoolean(true);
        private final DeepSeekApi deepSeekApi = new DeepSeekApi();

        RemoteJsBridge(Context context) {
            this.context = context.getApplicationContext();
        }

        void beginPageLoad() {
            // app.js performs one hard-coded built-in auto-connect on every reload.
            firstConnect.set(true);
        }

        void shutdown() {
            deepSeekApi.shutdown();
        }

        @JavascriptInterface
        public String getApiConfig() {
            return context.getSharedPreferences("deepseek_chat", Context.MODE_PRIVATE)
                    .getString("api_config", "{}");
        }

        /** P0 BUG-004: 内置配对凭据由构建期注入，JS 运行时获取，资产文件不再含真实值。 */
        @JavascriptInterface
        public String getBuiltinCredentials() {
            JSONObject payload = new JSONObject();
            try {
                payload.put("endpoint", BuildConfig.DSH_BUILTIN_ENDPOINT);
                payload.put("token", BuildConfig.DSH_BUILTIN_TOKEN);
            } catch (Exception ignored) {
            }
            return payload.toString();
        }

        /** 设置页显示已安装版本；资产里写死的版本号会随发版过期。 */
        @JavascriptInterface
        public String getAppVersion() {
            return BuildConfig.VERSION_NAME;
        }

        @JavascriptInterface
        public void saveApiConfig(String json) {
            if (json == null) return;
            context.getSharedPreferences("deepseek_chat", Context.MODE_PRIVATE)
                    .edit().putString("api_config", json).apply();
        }

        @JavascriptInterface
        public void streamChat(String requestJson) {
            deepSeekApi.stream(requestJson, MainActivity.this::postDeepSeekEvent);
        }

        @JavascriptInterface
        public void completeChat(String requestJson) {
            deepSeekApi.complete(requestJson, MainActivity.this::postDeepSeekEvent);
        }

        @JavascriptInterface
        public void testApi(String requestJson) {
            deepSeekApi.test(requestJson, MainActivity.this::postDeepSeekEvent);
        }

        @JavascriptInterface
        public void queryModels(String requestJson) {
            deepSeekApi.queryModels(requestJson, MainActivity.this::postDeepSeekEvent);
        }

        @JavascriptInterface
        public String getSettings() {
            return RemoteService.getSettingsJson(context);
        }

        @JavascriptInterface
        public String getSnapshot() {
            return RemoteService.getSnapshotJson(context);
        }

        @JavascriptInterface
        public boolean isConnected() {
            return RemoteService.isTransportConnected();
        }

        @JavascriptInterface
        public void connect(String endpoint, String token) {
            RemoteService.connectFromPage(context, endpoint, token, firstConnect.getAndSet(false));
        }

        @JavascriptInterface
        public void disconnect() {
            RemoteService.disconnect(context);
        }

        @JavascriptInterface
        public void requestSnapshot() {
            RemoteService.requestSnapshot(context);
        }

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
        public boolean createSession(String cwd, String projectId, String projectName, String workspaceId) {
            return RemoteService.createSession(context, cwd, projectId, projectName, workspaceId);
        }

        @JavascriptInterface
        public void sendPrompt(String text, String attachmentsJson, String sessionId) {
            try {
                String rawAttachments = attachmentsJson == null ? "[]" : attachmentsJson;
                if (rawAttachments.length() > MAX_BATCH_BASE64_CHARS + 32_768) {
                    throw new IllegalArgumentException("图片数据超过 Bridge 安全预算，请减少图片");
                }
                JSONArray source = new JSONArray(rawAttachments);
                if (source.length() > MAX_SELECTED_IMAGES) {
                    throw new IllegalArgumentException("一次最多发送 " + MAX_SELECTED_IMAGES
                            + " 张图片，请删除多余图片后重试");
                }
                JSONArray attachments = new JSONArray();
                int base64Chars = 0;
                for (int index = 0; index < source.length(); index++) {
                    JSONObject item = source.optJSONObject(index);
                    if (item == null) {
                        throw new IllegalArgumentException("第 " + (index + 1) + " 个图片附件格式无效");
                    }
                    String data = safe(item.optString("data", ""), "");
                    if (data.isEmpty()) {
                        String dataUrl = safe(item.optString("dataUrl", ""), "");
                        int comma = dataUrl.indexOf(',');
                        if (comma >= 0) data = dataUrl.substring(comma + 1);
                    }
                    if (data.isEmpty()) {
                        throw new IllegalArgumentException("第 " + (index + 1) + " 个图片附件缺少 base64 数据");
                    }
                    base64Chars += data.length();
                    if (base64Chars > MAX_BATCH_BASE64_CHARS) {
                        throw new IllegalArgumentException("图片总大小超过 Bridge 安全预算，请分批发送");
                    }
                    String mediaType = safe(item.optString("mediaType",
                            item.optString("mimeType", "image/jpeg")), "image/jpeg");
                    if (!mediaType.toLowerCase(Locale.ROOT).startsWith("image/")) {
                        throw new IllegalArgumentException("附件不是图片：" + mediaType);
                    }
                    byte[] decoded = Base64.decode(data, Base64.DEFAULT);
                    if (decoded.length == 0 || decoded.length > MAX_JPEG_BYTES) {
                        throw new IllegalArgumentException("第 " + (index + 1)
                                + " 个图片附件解码后大小无效");
                    }
                    attachments.put(new JSONObject()
                            .put("name", safe(item.optString("name", "photo.jpg"), "photo.jpg"))
                            .put("mediaType", mediaType)
                            .put("data", data));
                }
                if (safe(text, "").trim().isEmpty() && attachments.length() == 0) {
                    throw new IllegalArgumentException("消息文字和图片不能同时为空");
                }
                JSONObject payload = new JSONObject()
                        .put("text", safe(text, ""))
                        .put("attachments", attachments);
                int payloadBytes = payload.toString().getBytes(StandardCharsets.UTF_8).length;
                if (payloadBytes > RemoteService.MAX_CONTROL_FRAME_BYTES - 2_048) {
                    throw new IllegalArgumentException("消息和图片合计 " + payloadBytes
                            + " 字节，超过 Bridge 1 MiB 帧上限");
                }
                if (attachments.length() > 0 && !trim(sessionId).isEmpty()) {
                    // The frozen Bridge/DSH topology never echoes inline bytes for user
                    // messages, so register the just-sent images with the bounded cache
                    // that later replaces the text-only echo and history items.
                    RemoteService.rememberOutgoingImages(trim(sessionId), safe(text, ""), attachments);
                }
                // Admission failures carry their exact reason back as control.result; do not
                // add a second generic failure here and mask queue/start diagnostics.
                RemoteService.submitControl(context, "prompt.send", payload, trim(sessionId));
            } catch (Throwable error) {
                RemoteService.reportPromptFailure(sessionId,
                        "图片附件或消息无效：" + errorLabel(error));
            }
        }

        @JavascriptInterface
        public void stopTask(String sessionId) {
            RemoteService.control(context, "task.stop", new JSONObject(), trim(sessionId));
        }

        @JavascriptInterface
        public void continueTask(String sessionId) {
            RemoteService.control(context, "task.continue", new JSONObject(), trim(sessionId));
        }

        @JavascriptInterface
        public void resolveApproval(boolean allow, String requestId, String sessionId) {
            try {
                RemoteService.control(context, allow ? "approval.allow" : "approval.deny",
                        new JSONObject().put("requestId", trim(requestId)), trim(sessionId));
            } catch (Throwable error) {
                RemoteService.reportControlError("审批请求构造失败：" + errorLabel(error));
            }
        }

        /** app.js calls this dynamically although the written 4.1 table omitted it. */
        @JavascriptInterface
        public void selectModel(String provider, String model, String reasoningEffort) {
            try {
                JSONObject data = new JSONObject()
                        .put("provider", trim(provider))
                        .put("model", trim(model))
                        .put("reasoningEffort", trim(reasoningEffort));
                RemoteService.control(context, "session.selectModel", data,
                        RemoteService.getPreferredSessionId(context));
            } catch (Throwable error) {
                RemoteService.reportControlError("模型切换请求构造失败：" + errorLabel(error));
            }
        }

        @JavascriptInterface
        public void checkForUpdate() {
            RemoteService.checkForUpdate(context);
        }

        @JavascriptInterface
        public void downloadUpdate() {
            RemoteService.downloadUpdate(context);
        }
    }

    private static String errorLabel(Throwable error) {
        if (error == null) return "未知错误";
        String name = error.getClass().getSimpleName();
        String detail = trim(error.getMessage());
        return detail.isEmpty() ? name : name + ": " + detail;
    }

    private static String safe(String value, String fallback) {
        return value == null || value.isEmpty() ? fallback : value;
    }

    private static String trim(String value) {
        return value == null ? "" : value.trim();
    }

    private static String compactForLog(String value, int limit) {
        String text = value == null ? "" : value.replaceAll("\\s+", " ");
        return text.length() <= limit ? text : text.substring(0, Math.max(0, limit)) + "…";
    }
}
