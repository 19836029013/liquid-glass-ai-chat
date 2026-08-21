package com.dsapp.liquidglasschat;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Base64;
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

import androidx.core.content.FileProvider;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
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
import java.util.ArrayList;
import java.util.List;

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
                JSONArray modelIds = new JSONArray();
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
                        if (data != null) {
                            count = data.length();
                            for (int i = 0; i < data.length(); i++) {
                                JSONObject mo = data.optJSONObject(i);
                                if (mo != null) {
                                    String mid = mo.optString("id", "").trim();
                                    if (!mid.isEmpty()) modelIds.put(mid);
                                } else if (data.opt(i) instanceof String) {
                                    String mid = data.optString(i).trim();
                                    if (!mid.isEmpty()) modelIds.put(mid);
                                }
                            }
                        }
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
                JSONObject out = resultObj("ok", true,
                        "message", count > 0 ? "连接成功 · 检测到 " + count + " 个模型" : "连接成功");
                try {
                    out.put("models", modelIds);
                } catch (JSONException ignored) {
                }
                postEvent("test", out);
            } catch (Exception e) {
                postEvent("test", resultObj("ok", false, "message", friendlyError(e)));
            } finally {
                if (conn != null) conn.disconnect();
            }
        }).start();
    }

    private void doQueryModels(final String requestJson) {
        new Thread(() -> {
            HttpURLConnection conn = null;
            try {
                JSONObject req = new JSONObject(requestJson);
                String base = req.optString("base_url", "").trim();
                base = base.replaceAll("/+$", "");
                base = base.replaceFirst("(?i)/v1/chat/completions$", "");
                base = base.replaceFirst("(?i)/chat/completions$", "");
                base = base.replaceFirst("(?i)/v1beta$", "");
                base = base.replaceFirst("(?i)/v1$", "");
                String key = req.optString("api_key", "");
                if (base.isEmpty() || key.isEmpty()) {
                    postEvent("models", resultObj("ok", false, "message", "请先填写 API 地址和 Key"));
                    return;
                }
                JSONArray modelIds = new JSONArray();
                String[] candidates = {base + "/models", base + "/v1/models"};
                List<String> details = new ArrayList<>();
                boolean has401Or403 = false;
                boolean all404OrNone = true;
                for (String cand : candidates) {
                    int code = 0;
                    String bodySnippet = "";
                    try {
                        conn = (HttpURLConnection) new URL(cand).openConnection();
                        conn.setRequestMethod("GET");
                        conn.setRequestProperty("Authorization", "Bearer " + key);
                        conn.setConnectTimeout(15000);
                        conn.setReadTimeout(15000);
                        code = conn.getResponseCode();
                        if (code >= 200 && code < 300) {
                            JSONObject obj = new JSONObject(readFully(conn.getInputStream()));
                            JSONArray data = obj.optJSONArray("data");
                            if (data != null) {
                                for (int i = 0; i < data.length(); i++) {
                                    JSONObject mo = data.optJSONObject(i);
                                    String mid = mo != null ? mo.optString("id", "").trim() : String.valueOf(data.opt(i)).trim();
                                    if (!mid.isEmpty()) modelIds.put(mid);
                                }
                                if (modelIds.length() > 0) break;
                            }
                            if (modelIds.length() == 0) bodySnippet = "200 无模型列表";
                        } else {
                            bodySnippet = truncate(readFully(conn.getErrorStream()), 240).replace("\n", " ").trim();
                        }
                    } catch (Exception ignored) {
                    } finally {
                        if (conn != null) {
                            conn.disconnect();
                            conn = null;
                        }
                    }
                    if (code == 401 || code == 403) has401Or403 = true;
                    if (code != 404) all404OrNone = false;
                    details.add(cand + " → " + (code == 0 ? "网络错误" : "HTTP " + code)
                            + (bodySnippet.isEmpty() ? "" : " " + bodySnippet));
                }
                if (modelIds.length() == 0) {
                    String msg;
                    if (has401Or403) {
                        msg = "模型查询失败：API Key 无效、已过期，或没有模型列表权限";
                    } else if (all404OrNone) {
                        msg = "模型查询失败：没有找到 /models 接口。请确认 API 地址填写的是 OpenAI-compatible 根地址，例如 https://api.deepseek.com";
                    } else {
                        msg = "模型查询失败：接口没有返回可用模型。" + String.join("；", details)
                                + "。请检查 API 地址和 Key 是否正确，账户是否已完成实名认证且有余额。";
                    }
                    postEvent("models", resultObj("ok", false, "message", msg));
                    return;
                }
                JSONObject out = resultObj("ok", true, "message", "找到 " + modelIds.length() + " 个模型");
                try {
                    out.put("models", modelIds);
                } catch (JSONException ignored) {
                }
                postEvent("models", out);
            } catch (Exception e) {
                postEvent("models", resultObj("ok", false, "message", friendlyError(e)));
            } finally {
                if (conn != null) conn.disconnect();
            }
        }).start();
    }

    private void doShareImage(final String dataUrl, final String title, final String text) {
        new Thread(() -> {
            try {
                if (dataUrl == null || !dataUrl.startsWith("data:image")) {
                    runOnUiThread(() -> {
                        try {
                            Intent i = new Intent(Intent.ACTION_SEND);
                            i.setType("text/plain");
                            i.putExtra(Intent.EXTRA_SUBJECT, title == null ? "" : title);
                            i.putExtra(Intent.EXTRA_TEXT, text == null ? "" : text);
                            startActivity(Intent.createChooser(i, "分享"));
                        } catch (Exception ignored) {
                        }
                    });
                    return;
                }
                String base64 = dataUrl.substring(dataUrl.indexOf(',') + 1);
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                File dir = new File(getCacheDir(), "share");
                if (!dir.exists() && !dir.mkdirs()) return;
                File file = new File(dir, "whale-card.png");
                try (FileOutputStream fos = new FileOutputStream(file)) {
                    fos.write(bytes);
                }
                final Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", file);
                runOnUiThread(() -> {
                    try {
                        Intent send = new Intent(Intent.ACTION_SEND);
                        send.setType("image/png");
                        send.putExtra(Intent.EXTRA_STREAM, uri);
                        send.putExtra(Intent.EXTRA_SUBJECT, title == null ? "" : title);
                        send.putExtra(Intent.EXTRA_TEXT, text == null ? "" : text);
                        send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        startActivity(Intent.createChooser(send, "分享鲸鱼娘卡片"));
                    } catch (Exception ignored) {
                    }
                });
            } catch (Exception ignored) {
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
            } catch (Exception e) {
                sendUpdateState("error", 0, "更新启动失败：" + friendlyError(e));
                return;
            }
            downloadAndInstall(url, version, sha256);
        });
    }

    private void downloadAndInstall(final String url, final String version, final String sha256) {
        new Thread(() -> {
            HttpURLConnection conn = null;
            File target = null;
            try {
                sendUpdateState("downloading", 5, "正在连接下载服务器");
                conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setInstanceFollowRedirects(true);
                conn.setConnectTimeout(20000);
                conn.setReadTimeout(60000);
                conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android)");
                conn.connect();
                int code = conn.getResponseCode();
                if (code >= 400) {
                    sendUpdateState("error", 0, "下载失败：HTTP " + code);
                    return;
                }
                long total = conn.getContentLengthLong();
                File dir = new File(getCacheDir(), "updates");
                if (!dir.exists() && !dir.mkdirs()) {
                    sendUpdateState("error", 0, "无法创建下载目录");
                    return;
                }
                target = new File(dir, "app-update-" + (version == null || version.isEmpty() ? "latest" : version) + ".apk");
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                long done = 0;
                try (InputStream in = conn.getInputStream(); FileOutputStream out = new FileOutputStream(target)) {
                    byte[] buffer = new byte[64 * 1024];
                    int n;
                    long lastReport = 0;
                    while ((n = in.read(buffer)) > 0) {
                        out.write(buffer, 0, n);
                        digest.update(buffer, 0, n);
                        done += n;
                        if (total > 0 && done - lastReport > Math.max(total / 100, 64 * 1024)) {
                            int pct = 5 + (int) Math.round(85.0 * done / total);
                            sendUpdateState("downloading", Math.min(pct, 90), "正在下载安装包 " + pct + "%");
                            lastReport = done;
                        }
                    }
                }
                if (sha256 != null && !sha256.trim().isEmpty()) {
                    StringBuilder sb = new StringBuilder();
                    for (byte b : digest.digest()) {
                        sb.append(String.format("%02x", b));
                    }
                    if (!sb.toString().equalsIgnoreCase(sha256.trim())) {
                        sendUpdateState("error", 0, "安装包 SHA-256 校验失败");
                        return;
                    }
                }
                Uri fileUri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", target);
                sendUpdateState("installing", 92, "正在打开系统安装器");
                Intent open = new Intent(Intent.ACTION_VIEW);
                open.setDataAndType(fileUri, "application/vnd.android.package-archive");
                open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
                startActivity(open);
            } catch (Exception e) {
                sendUpdateState("error", 0, "下载失败：" + friendlyError(e));
            } finally {
                if (conn != null) conn.disconnect();
            }
        }).start();
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
        public void queryModels(String requestJson) {
            doQueryModels(requestJson);
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

        @JavascriptInterface
        public void shareImage(String dataUrl, String title, String text) {
            doShareImage(dataUrl, title, text);
        }
    }

    private class AndroidUpdaterBridge {
        @JavascriptInterface
        public void installApk(String url, String version, String sha256) {
            updaterInstallApk(url, version, sha256);
        }
    }
}
