package com.dsapp.liquidglasschat;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.Intent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.SslErrorHandler;
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

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

public class MainActivity extends Activity {

    private static final String PREFS = "liquid_glass_chat";
    private static final String KEY_API_CONFIG = "api_config";
    private static final String KEY_APP_STATE = "app_state";
    private static final int FILE_CHOOSER_REQUEST = 1001;

    private WebView webView;
    private ProgressBar loadingBar;
    private View errorView;
    private TextView errorMessage;
    private SharedPreferences prefs;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private ValueCallback<Uri[]> fileChooserCallback;
    private long updaterDownloadId = -1L;
    private String updaterExpectedSha256 = "";
    private BroadcastReceiver updaterReceiver = null;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        webView = findViewById(R.id.webView);
        loadingBar = findViewById(R.id.loadingBar);
        errorView = findViewById(R.id.errorView);
        errorMessage = findViewById(R.id.errorMessage);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setAllowFileAccess(true);
        settings.setAllowFileAccessFromFileURLs(true);
        settings.setAllowUniversalAccessFromFileURLs(true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                loadingBar.setProgress(0);
                loadingBar.setVisibility(View.VISIBLE);
                errorView.setVisibility(View.GONE);
                webView.setVisibility(View.VISIBLE);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                loadingBar.setVisibility(View.GONE);
                if (!prefs.contains(KEY_API_CONFIG)) {
                    handler.postDelayed(() -> {
                        if (!isFinishing() && !isDestroyed()) openSettingsModal();
                    }, 500);
                }
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    showError("页面加载失败：" + errorDescription(error));
                }
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel();
                showError("SSL 证书错误：" + error.getPrimaryError());
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                loadingBar.setProgress(newProgress);
                if (newProgress >= 100) {
                    loadingBar.setVisibility(View.GONE);
                }
            }

            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback, FileChooserParams fileChooserParams) {
                if (fileChooserCallback != null) {
                    fileChooserCallback.onReceiveValue(null);
                }
                fileChooserCallback = filePathCallback;
                try {
                    startActivityForResult(fileChooserParams.createIntent(), FILE_CHOOSER_REQUEST);
                    return true;
                } catch (Exception e) {
                    fileChooserCallback = null;
                    return false;
                }
            }
        });

        webView.addJavascriptInterface(new JsBridge(), "Android");
        webView.addJavascriptInterface(new AndroidUpdaterBridge(), "AndroidUpdater");

        ((Button) findViewById(R.id.retryButton)).setOnClickListener(v -> webView.reload());
        ((Button) findViewById(R.id.settingsButton)).setOnClickListener(v -> openSettingsModal());

        webView.loadUrl("file:///android_asset/index.html");
    }

    private void openSettingsModal() {
        webView.evaluateJavascript("window.__openSettings&&window.__openSettings('api')", null);
    }

    private String errorDescription(WebResourceError error) {
        try {
            return error.getDescription().toString();
        } catch (Exception ignored) {
            return "无法加载页面";
        }
    }

    private void showError(String message) {
        loadingBar.setVisibility(View.GONE);
        webView.setVisibility(View.GONE);
        errorMessage.setText(message);
        errorView.setVisibility(View.VISIBLE);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER_REQUEST) {
            Uri[] results = null;
            if (resultCode == RESULT_OK && data != null) {
                if (data.getData() != null) {
                    results = new Uri[]{data.getData()};
                } else if (data.getClipData() != null) {
                    int count = data.getClipData().getItemCount();
                    if (count > 0) {
                        results = new Uri[count];
                        for (int i = 0; i < count; i++) {
                            results[i] = data.getClipData().getItemAt(i).getUri();
                        }
                    }
                }
            }
            if (fileChooserCallback != null) {
                fileChooserCallback.onReceiveValue(results);
                fileChooserCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    private HttpURLConnection openConnection(String url) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setRequestMethod("POST");
        conn.setRequestProperty("Content-Type", "application/json");
        conn.setRequestProperty("Accept", "text/event-stream");
        conn.setConnectTimeout(20000);
        conn.setReadTimeout(180000);
        conn.setInstanceFollowRedirects(true);
        return conn;
    }

    private String readFully(InputStream in) throws IOException {
        if (in == null) return "";
        StringBuilder sb = new StringBuilder();
        byte[] buf = new byte[4096];
        int n;
        while ((n = in.read(buf)) != -1) {
            sb.append(new String(buf, 0, n, StandardCharsets.UTF_8));
        }
        return sb.toString();
    }

    private String truncate(String s, int max) {
        if (s == null) return "";
        return s.length() <= max ? s : s.substring(0, max);
    }

    private static JSONObject jsonObject(String key, String value) {
        JSONObject o = new JSONObject();
        try {
            o.put(key, value);
        } catch (JSONException ignored) {
        }
        return o;
    }

    private static JSONObject resultObj(Object... kv) {
        JSONObject o = new JSONObject();
        try {
            for (int i = 0; i + 1 < kv.length; i += 2) {
                o.put(String.valueOf(kv[i]), kv[i + 1]);
            }
        } catch (JSONException ignored) {
        }
        return o;
    }

    private String extractContent(Object value) {
        if (value == null || value == JSONObject.NULL) return "";
        if (value instanceof String) return (String) value;
        if (value instanceof JSONArray) {
            StringBuilder sb = new StringBuilder();
            JSONArray arr = (JSONArray) value;
            for (int i = 0; i < arr.length(); i++) {
                Object item = arr.opt(i);
                if (item instanceof JSONObject) {
                    String text = ((JSONObject) item).optString("text", "");
                    if (text.isEmpty()) text = ((JSONObject) item).optString("content", "");
                    sb.append(text);
                } else if (item instanceof String) {
                    sb.append(item);
                }
            }
            return sb.toString();
        }
        return "";
    }

    private void postEvent(String name, JSONObject data) {
        String payload = data == null ? "{}" : data.toString();
        final String js = "window.AndroidEvents&&window.AndroidEvents.onEvent("
                + JSONObject.quote(name) + "," + JSONObject.quote(payload) + ")";
        runOnUiThread(() -> webView.evaluateJavascript(js, null));
    }

    private void postEvent(String name) {
        postEvent(name, new JSONObject());
    }

    private String friendlyError(Exception e) {
        if (e instanceof UnknownHostException) return "无法解析服务器地址，请检查网络或 API 地址";
        if (e instanceof SocketTimeoutException) return "连接超时，请检查 API 地址和网络";
        String msg = e.getMessage();
        return (msg == null || msg.isEmpty()) ? e.getClass().getSimpleName() : msg;
    }

    private void doStreamChat(final String requestJson) {
        new Thread(() -> {
            HttpURLConnection conn = null;
            try {
                JSONObject req = new JSONObject(requestJson);
                String url = req.optString("url", "");
                String apiKey = req.optString("apiKey", "");
                JSONObject payload = req.optJSONObject("payload");
                if (url.isEmpty() || payload == null) {
                    postEvent("error", jsonObject("message", "请求参数错误"));
                    return;
                }
                conn = openConnection(url);
                if (!apiKey.isEmpty()) conn.setRequestProperty("Authorization", "Bearer " + apiKey);
                conn.setDoOutput(true);
                try (OutputStream os = conn.getOutputStream()) {
                    os.write(payload.toString().getBytes(StandardCharsets.UTF_8));
                }
                int code = conn.getResponseCode();
                if (code >= 400) {
                    String body = truncate(readFully(conn.getErrorStream()), 500);
                    postEvent("error", jsonObject("message", "API " + code + ": " + body));
                    return;
                }
                BufferedReader reader = new BufferedReader(
                        new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8));
                String line;
                while ((line = reader.readLine()) != null) {
                    if (!line.startsWith("data:")) continue;
                    String raw = line.substring(5).trim();
                    if (raw.equals("[DONE]")) break;
                    try {
                        JSONObject obj = new JSONObject(raw);
                        JSONArray choices = obj.optJSONArray("choices");
                        if (choices == null || choices.length() == 0) continue;
                        JSONObject first = choices.optJSONObject(0);
                        if (first == null) continue;
                        JSONObject delta = first.optJSONObject("delta");
                        if (delta == null) continue;
                        String content = extractContent(delta.opt("content"));
                        if (!content.isEmpty()) postEvent("delta", jsonObject("text", content));
                        String reasoning = extractContent(delta.opt("reasoning_content"));
                        if (!reasoning.isEmpty()) postEvent("reasoning", jsonObject("text", reasoning));
                    } catch (JSONException ignored) {
                    }
                }
                postEvent("done");
            } catch (Exception e) {
                postEvent("error", jsonObject("message", friendlyError(e)));
            } finally {
                if (conn != null) conn.disconnect();
            }
        }).start();
    }

    private void doCompleteChat(final String requestJson) {
        new Thread(() -> {
            HttpURLConnection conn = null;
            try {
                JSONObject req = new JSONObject(requestJson);
                String url = req.optString("url", "");
                String apiKey = req.optString("apiKey", "");
                JSONObject payload = req.optJSONObject("payload");
                if (url.isEmpty() || payload == null) {
                    postEvent("error", jsonObject("message", "请求参数错误"));
                    return;
                }
                conn = openConnection(url);
                if (!apiKey.isEmpty()) conn.setRequestProperty("Authorization", "Bearer " + apiKey);
                conn.setDoOutput(true);
                try (OutputStream os = conn.getOutputStream()) {
                    os.write(payload.toString().getBytes(StandardCharsets.UTF_8));
                }
                int code = conn.getResponseCode();
                if (code >= 400) {
                    String body = truncate(readFully(conn.getErrorStream()), 500);
                    postEvent("error", jsonObject("message", "API " + code + ": " + body));
                    return;
                }
                JSONObject obj = new JSONObject(readFully(conn.getInputStream()));
                String text = "";
                JSONArray choices = obj.optJSONArray("choices");
                if (choices != null && choices.length() > 0) {
                    JSONObject first = choices.optJSONObject(0);
                    if (first != null) {
                        JSONObject message = first.optJSONObject("message");
                        if (message != null) text = extractContent(message.opt("content"));
                    }
                }
                postEvent("complete", jsonObject("text", text));
            } catch (Exception e) {
                postEvent("error", jsonObject("message", friendlyError(e)));
            } finally {
                if (conn != null) conn.disconnect();
            }
        }).start();
    }

    private void doTestApi(final String requestJson) {
        new Thread(() -> {
            HttpURLConnection conn = null;
            try {
                JSONObject req = new JSONObject(requestJson);
                String base = req.optString("base_url", "").replaceAll("/+$", "");
                String key = req.optString("api_key", "");
                String model = req.optString("model", "deepseek-chat");
                if (base.isEmpty() || key.isEmpty()) {
                    postEvent("test", resultObj("ok", false, "message", "请先填写 API 地址和 Key"));
                    return;
                }
                int count = 0;
                try {
                    conn = (HttpURLConnection) new URL(base + "/models").openConnection();
                    conn.setRequestMethod("GET");
                    conn.setRequestProperty("Authorization", "Bearer " + key);
                    conn.setConnectTimeout(15000);
                    conn.setReadTimeout(15000);
                    int code = conn.getResponseCode();
                    if (code >= 200 && code < 300) {
                        JSONObject obj = new JSONObject(readFully(conn.getInputStream()));
                        JSONArray data = obj.optJSONArray("data");
                        if (data != null) count = data.length();
                    }
                } catch (Exception ignored) {
                } finally {
                    if (conn != null) {
                        conn.disconnect();
                        conn = null;
                    }
                }
                if (count == 0) {
                    try {
                        conn = openConnection(base + "/chat/completions");
                        conn.setRequestProperty("Authorization", "Bearer " + key);
                        conn.setDoOutput(true);
                        JSONObject payload = new JSONObject();
                        payload.put("model", model);
                        JSONArray messages = new JSONArray();
                        JSONObject sys = new JSONObject();
                        sys.put("role", "system");
                        sys.put("content", "ping");
                        JSONObject usr = new JSONObject();
                        usr.put("role", "user");
                        usr.put("content", "ping");
                        messages.put(sys);
                        messages.put(usr);
                        payload.put("messages", messages);
                        payload.put("max_tokens", 1);
                        payload.put("stream", false);
                        try (OutputStream os = conn.getOutputStream()) {
                            os.write(payload.toString().getBytes(StandardCharsets.UTF_8));
                        }
                        int code = conn.getResponseCode();
                        if (code >= 400) {
                            String body = truncate(readFully(conn.getErrorStream()), 300);
                            postEvent("test", resultObj("ok", false, "message", "API " + code + ": " + body));
                            return;
                        }
                    } catch (Exception e) {
                        postEvent("test", resultObj("ok", false, "message", friendlyError(e)));
                        return;
                    }
                }
                postEvent("test", resultObj("ok", true,
                        "message", count > 0 ? "连接成功 · 检测到 " + count + " 个模型" : "连接成功"));
            } catch (Exception e) {
                postEvent("test", resultObj("ok", false, "message", friendlyError(e)));
            } finally {
                if (conn != null) conn.disconnect();
            }
        }).start();
    }

    private void updaterInstallApk(final String url, final String version, final String sha256) {
        runOnUiThread(() -> {
            try {
                if (Build.VERSION.SDK_INT >= 26 && !getPackageManager().canRequestPackageInstalls()) {
                    startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                            Uri.parse("package:" + getPackageName())));
                    sendUpdateState("permission", 0, "请允许安装未知应用，然后再次点击立即更新");
                    return;
                }
                updaterExpectedSha256 = sha256 == null ? "" : sha256.trim().toLowerCase();
                String fileName = "app-update-" + (version == null || version.isEmpty() ? "latest" : version) + ".apk";
                DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url))
                        .setTitle("正在更新")
                        .setDescription("正在下载 " + (version == null ? "" : version))
                        .setMimeType("application/vnd.android.package-archive")
                        .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                        .setDestinationInExternalFilesDir(this, Environment.DIRECTORY_DOWNLOADS, fileName);
                DownloadManager manager = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                updaterDownloadId = manager.enqueue(request);
                registerUpdaterReceiver(manager);
                sendUpdateState("downloading", 5, "正在下载安装包");
                pollUpdaterProgress(manager);
            } catch (Exception e) {
                sendUpdateState("error", 0, "更新启动失败：" + friendlyError(e));
            }
        });
    }

    private void registerUpdaterReceiver(final DownloadManager manager) {
        if (updaterReceiver != null) {
            try {
                unregisterReceiver(updaterReceiver);
            } catch (Exception ignored) {
            }
        }
        updaterReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L) != updaterDownloadId) return;
                try {
                    Uri uri = manager.getUriForDownloadedFile(updaterDownloadId);
                    if (uri == null) {
                        sendUpdateState("error", 0, "下载安装包失败");
                        return;
                    }
                    if (!updaterExpectedSha256.isEmpty() && !verifySha256(uri, updaterExpectedSha256)) {
                        sendUpdateState("error", 0, "安装包 SHA-256 校验失败");
                        return;
                    }
                    sendUpdateState("installing", 92, "正在打开系统安装器");
                    Intent open = new Intent(Intent.ACTION_VIEW);
                    open.setDataAndType(uri, "application/vnd.android.package-archive");
                    open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    startActivity(open);
                } catch (Exception e) {
                    sendUpdateState("error", 0, "无法打开安装器：" + friendlyError(e));
                } finally {
                    try {
                        unregisterReceiver(this);
                    } catch (Exception ignored) {
                    }
                }
            }
        };
        IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(updaterReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(updaterReceiver, filter);
        }
    }

    private void pollUpdaterProgress(final DownloadManager manager) {
        new Thread(() -> {
            try {
                while (updaterDownloadId != -1L) {
                    DownloadManager.Query q = new DownloadManager.Query();
                    q.setFilterById(updaterDownloadId);
                    Cursor c = manager.query(q);
                    if (c != null && c.moveToFirst()) {
                        int status = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                        long total = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
                        long done = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
                        if (status == DownloadManager.STATUS_RUNNING && total > 0) {
                            int pct = 5 + (int) Math.round(85.0 * done / total);
                            sendUpdateState("downloading", Math.min(pct, 90), "正在下载安装包 " + pct + "%");
                        } else if (status == DownloadManager.STATUS_SUCCESSFUL || status == DownloadManager.STATUS_FAILED) {
                            c.close();
                            break;
                        }
                        c.close();
                    }
                    Thread.sleep(600);
                }
            } catch (Exception ignored) {
            }
        }).start();
    }

    private boolean verifySha256(Uri uri, String expected) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            InputStream input = getContentResolver().openInputStream(uri);
            if (input == null) return false;
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) > 0) {
                digest.update(buffer, 0, read);
            }
            input.close();
            StringBuilder sb = new StringBuilder();
            for (byte b : digest.digest()) {
                sb.append(String.format("%02x", b));
            }
            return sb.toString().equalsIgnoreCase(expected);
        } catch (Exception e) {
            return false;
        }
    }

    private void sendUpdateState(String state, int progress, String message) {
        String safe = JSONObject.quote(message == null ? "" : message);
        final String script = "window.dispatchEvent(new CustomEvent('native-update-state',{detail:{state:'"
                + state + "',progress:" + progress + ",message:" + safe + "}}));";
        runOnUiThread(() -> webView.evaluateJavascript(script, null));
    }

    @Override
    public void onBackPressed() {
        if (webView.getVisibility() == View.VISIBLE && webView.canGoBack()) {
            webView.goBack();
        } else {
            moveTaskToBack(true);
        }
    }

    private class JsBridge {
        @JavascriptInterface
        public String getConfig() {
            return prefs.getString(KEY_API_CONFIG, null);
        }

        @JavascriptInterface
        public void saveConfig(String json) {
            if (json == null) return;
            prefs.edit().putString(KEY_API_CONFIG, json).apply();
        }

        @JavascriptInterface
        public String getState() {
            return prefs.getString(KEY_APP_STATE, null);
        }

        @JavascriptInterface
        public void saveState(String json) {
            if (json == null) return;
            prefs.edit().putString(KEY_APP_STATE, json).apply();
        }

        @JavascriptInterface
        public void openSettings() {
            runOnUiThread(() -> openSettingsModal());
        }

        @JavascriptInterface
        public void streamChat(String requestJson) {
            doStreamChat(requestJson);
        }

        @JavascriptInterface
        public void completeChat(String requestJson) {
            doCompleteChat(requestJson);
        }

        @JavascriptInterface
        public void testApi(String requestJson) {
            doTestApi(requestJson);
        }

        @JavascriptInterface
        public void openUrl(String url) {
            if (url == null || url.trim().isEmpty()) return;
            runOnUiThread(() -> {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url.trim())));
                } catch (Exception ignored) {
                }
            });
        }
    }

    private class AndroidUpdaterBridge {
        @JavascriptInterface
        public void installApk(String url, String version, String sha256) {
            updaterInstallApk(url, version, sha256);
        }
    }
}
