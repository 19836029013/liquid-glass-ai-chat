package com.dsapp.liquidglasschat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Small OpenAI-compatible DeepSeek client used by the chat shell.
 *
 * The API key is never logged. Network work is kept off the WebView/UI thread,
 * and the event sink is responsible for posting results back to the page.
 */
final class DeepSeekApi {
    interface EventSink {
        void onEvent(String name, JSONObject data);
    }

    private static final int CONNECT_TIMEOUT_MS = 20_000;
    private static final int READ_TIMEOUT_MS = 180_000;
    private static final int MAX_RESPONSE_ERROR_CHARS = 800;
    private static final int MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
    private static final int MAX_REQUEST_BYTES = 4 * 1024 * 1024;
    private final ExecutorService executor = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "deepseek-api");
        thread.setDaemon(true);
        return thread;
    });

    void stream(String requestJson, EventSink sink) {
        submit(() -> runStream(requestJson, sink), sink);
    }

    void complete(String requestJson, EventSink sink) {
        submit(() -> runComplete(requestJson, sink), sink);
    }

    void test(String requestJson, EventSink sink) {
        submit(() -> runTest(requestJson, sink), sink);
    }

    void queryModels(String requestJson, EventSink sink) {
        submit(() -> runModels(requestJson, sink), sink);
    }

    private void submit(Runnable task, EventSink sink) {
        try {
            executor.execute(task);
        } catch (RejectedExecutionException error) {
            emitError(sink, "API 服务正在停止，请稍后重试");
        }
    }

    void shutdown() {
        executor.shutdownNow();
    }

    private void runStream(String requestJson, EventSink sink) {
        HttpURLConnection connection = null;
        try {
            JSONObject request = new JSONObject(requestJson == null ? "{}" : requestJson);
            String url = requireApiUrl(request.optString("url", ""));
            String apiKey = request.optString("apiKey", "").trim();
            JSONObject payload = request.optJSONObject("payload");
            if (payload == null) throw new IllegalArgumentException("请求参数缺少 payload");
            connection = openConnection(url, apiKey, "text/event-stream");
            writePayload(connection, payload);
            int status = connection.getResponseCode();
            if (status >= 400) {
                emitError(sink, "API " + status + "：" + readSnippet(connection.getErrorStream()));
                return;
            }
            boolean emittedContent = false;
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                    connection.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    if (!line.startsWith("data:")) continue;
                    String raw = line.substring(5).trim();
                    if ("[DONE]".equals(raw)) break;
                    if (raw.isEmpty()) continue;
                    try {
                        JSONObject chunk = new JSONObject(raw);
                        JSONObject usage = chunk.optJSONObject("usage");
                        if (usage != null) sink.onEvent("usage", new JSONObject().put("usage", usage));
                        JSONArray choices = chunk.optJSONArray("choices");
                        JSONObject first = choices == null || choices.length() == 0
                                ? null : choices.optJSONObject(0);
                        JSONObject delta = first == null ? null : first.optJSONObject("delta");
                        if (delta == null) continue;
                        String content = extractContent(delta.opt("content"));
                        if (!content.isEmpty()) {
                            emittedContent = true;
                            sink.onEvent("delta", textPayload(content));
                        }
                        String reasoning = extractContent(delta.opt("reasoning_content"));
                        if (!reasoning.isEmpty()) sink.onEvent("reasoning", textPayload(reasoning));
                    } catch (Exception ignored) {
                        // Providers occasionally send comments or non-JSON keep-alives.
                    }
                }
            }
            if (!emittedContent) {
                emitError(sink, "API 返回了空回复");
            } else {
                sink.onEvent("done", new JSONObject());
            }
        } catch (Exception error) {
            emitError(sink, friendlyError(error));
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private void runComplete(String requestJson, EventSink sink) {
        HttpURLConnection connection = null;
        try {
            JSONObject request = new JSONObject(requestJson == null ? "{}" : requestJson);
            String url = requireApiUrl(request.optString("url", ""));
            String apiKey = request.optString("apiKey", "").trim();
            JSONObject payload = request.optJSONObject("payload");
            if (payload == null) throw new IllegalArgumentException("请求参数缺少 payload");
            connection = openConnection(url, apiKey, "application/json");
            writePayload(connection, payload);
            int status = connection.getResponseCode();
            if (status >= 400) {
                emitError(sink, "API " + status + "：" + readSnippet(connection.getErrorStream()));
                return;
            }
            JSONObject response = new JSONObject(readFully(connection.getInputStream()));
            JSONArray choices = response.optJSONArray("choices");
            JSONObject first = choices == null || choices.length() == 0
                    ? null : choices.optJSONObject(0);
            JSONObject message = first == null ? null : first.optJSONObject("message");
            JSONObject complete = textPayload(message == null ? "" : extractContent(message.opt("content")));
            JSONObject usage = response.optJSONObject("usage");
            if (usage != null) complete.put("usage", usage);
            sink.onEvent("complete", complete);
        } catch (Exception error) {
            emitError(sink, friendlyError(error));
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private void runTest(String requestJson, EventSink sink) {
        try {
            JSONObject request = new JSONObject(requestJson == null ? "{}" : requestJson);
            String base = normalizeBase(request.optString("base_url", ""));
            String key = request.optString("api_key", "").trim();
            String model = request.optString("model", "deepseek-chat").trim();
            if (base.isEmpty() || key.isEmpty()) {
                sink.onEvent("test", result(false, "请先填写 API 地址和 Key"));
                return;
            }
            HttpURLConnection connection = null;
            int count = 0;
            JSONArray modelIds = new JSONArray();
            String[] modelEndpoints = {base + "/models", base + "/v1/models"};
            for (String modelEndpoint : modelEndpoints) {
                try {
                    connection = openConnection(modelEndpoint, key, "application/json", "GET");
                    int status = connection.getResponseCode();
                    if (status >= 200 && status < 300) {
                        JSONObject body = new JSONObject(readFully(connection.getInputStream()));
                        JSONArray data = body.optJSONArray("data");
                        if (data != null) {
                            for (int i = 0; i < data.length(); i++) {
                                JSONObject item = data.optJSONObject(i);
                                String id = item == null ? data.optString(i, "") : item.optString("id", "");
                                if (!id.trim().isEmpty() && !contains(modelIds, id.trim())) modelIds.put(id.trim());
                            }
                            count = modelIds.length();
                        }
                    }
                    if (count > 0) break;
                } catch (Exception ignored) {
                    // Some OpenAI-compatible gateways do not expose /models; test chat below.
                } finally {
                    if (connection != null) {
                        connection.disconnect();
                        connection = null;
                    }
                }
            }
            if (count == 0) {
                JSONObject payload = new JSONObject().put("model", model)
                        .put("messages", new JSONArray().put(new JSONObject()
                                .put("role", "user").put("content", "ping")))
                        .put("max_tokens", 1).put("stream", false);
                connection = openConnection(base + "/chat/completions", key, "application/json");
                try {
                    writePayload(connection, payload);
                    int status = connection.getResponseCode();
                    if (status >= 400) {
                        sink.onEvent("test", result(false, "API " + status + "：" + readSnippet(connection.getErrorStream())));
                        return;
                    }
                } finally {
                    connection.disconnect();
                    connection = null;
                }
            }
            sink.onEvent("test", new JSONObject().put("ok", true)
                    .put("message", count > 0 ? "连接成功 · 检测到 " + count + " 个模型" : "连接成功")
                    .put("models", modelIds));
        } catch (Exception error) {
            emitError(sink, friendlyError(error), "test");
        }
    }

    private void runModels(String requestJson, EventSink sink) {
        try {
            JSONObject request = new JSONObject(requestJson == null ? "{}" : requestJson);
            String base = normalizeBase(request.optString("base_url", ""));
            String key = request.optString("api_key", "").trim();
            if (base.isEmpty() || key.isEmpty()) {
                sink.onEvent("models", result(false, "请先填写 API 地址和 Key"));
                return;
            }
            JSONArray modelIds = new JSONArray();
            String[] candidates = {base + "/models", base + "/v1/models"};
            for (String candidate : candidates) {
                HttpURLConnection connection = null;
                try {
                    connection = openConnection(candidate, key, "application/json", "GET");
                    int status = connection.getResponseCode();
                    if (status >= 200 && status < 300) {
                        JSONObject body = new JSONObject(readFully(connection.getInputStream()));
                        JSONArray data = body.optJSONArray("data");
                        if (data != null) {
                            for (int i = 0; i < data.length(); i++) {
                                JSONObject item = data.optJSONObject(i);
                                String id = item == null ? data.optString(i, "") : item.optString("id", "");
                                if (!id.trim().isEmpty() && !contains(modelIds, id.trim())) modelIds.put(id.trim());
                            }
                        }
                    }
                    if (modelIds.length() > 0) break;
                } finally {
                    if (connection != null) connection.disconnect();
                }
            }
            if (modelIds.length() == 0) {
                sink.onEvent("models", result(false, "没有找到可用模型，请检查 API 地址和 Key"));
                return;
            }
            sink.onEvent("models", new JSONObject().put("ok", true).put("models", modelIds));
        } catch (Exception error) {
            emitError(sink, friendlyError(error), "models");
        }
    }

    private static HttpURLConnection openConnection(String url, String apiKey, String accept)
            throws IOException {
        return openConnection(url, apiKey, accept, "POST");
    }

    private static HttpURLConnection openConnection(String url, String apiKey, String accept,
                                                     String method) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(requireApiUrl(url)).openConnection();
        connection.setRequestMethod(method);
        connection.setRequestProperty("Content-Type", "application/json");
        connection.setRequestProperty("Accept", accept);
        if (!apiKey.isEmpty()) connection.setRequestProperty("Authorization", "Bearer " + apiKey);
        connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
        connection.setReadTimeout(READ_TIMEOUT_MS);
        connection.setInstanceFollowRedirects(true);
        return connection;
    }

    private static void writePayload(HttpURLConnection connection, JSONObject payload) throws IOException {
        byte[] bytes = payload.toString().getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_REQUEST_BYTES) throw new IOException("请求体超过 4 MiB 安全上限");
        connection.setDoOutput(true);
        try (OutputStream output = connection.getOutputStream()) {
            output.write(bytes);
        }
    }

    private static String requireApiUrl(String raw) {
        String value = String.valueOf(raw == null ? "" : raw).trim();
        if (value.isEmpty()) throw new IllegalArgumentException("请填写 API 地址");
        if (!value.startsWith("http://") && !value.startsWith("https://")) {
            throw new IllegalArgumentException("API 地址必须以 http:// 或 https:// 开头");
        }
        return value;
    }

    private static String normalizeBase(String raw) {
        String value = String.valueOf(raw == null ? "" : raw).trim().replaceAll("/+$", "");
        value = value.replaceFirst("(?i)/v1/chat/completions$", "")
                .replaceFirst("(?i)/chat/completions$", "")
                .replaceFirst("(?i)/v1beta$", "")
                .replaceFirst("(?i)/v1$", "");
        return value;
    }

    private static String readFully(InputStream input) throws IOException {
        if (input == null) return "";
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[4096];
        int read;
        while ((read = input.read(buffer)) != -1) {
            if (output.size() + read > MAX_RESPONSE_BYTES) {
                throw new IOException("API 响应超过 " + (MAX_RESPONSE_BYTES / (1024 * 1024)) + " MiB 安全上限");
            }
            output.write(buffer, 0, read);
        }
        return new String(output.toByteArray(), StandardCharsets.UTF_8);
    }

    private static String readSnippet(InputStream input) throws IOException {
        String value = readFully(input).replaceAll("\\s+", " ").trim();
        return value.length() <= MAX_RESPONSE_ERROR_CHARS ? value
                : value.substring(0, MAX_RESPONSE_ERROR_CHARS) + "…";
    }

    private static String extractContent(Object value) {
        if (value == null || value == JSONObject.NULL) return "";
        if (value instanceof String) return (String) value;
        if (value instanceof JSONArray) {
            StringBuilder output = new StringBuilder();
            JSONArray array = (JSONArray) value;
            for (int i = 0; i < array.length(); i++) {
                Object item = array.opt(i);
                if (item instanceof JSONObject) {
                    JSONObject object = (JSONObject) item;
                    String text = object.optString("text", object.optString("content", ""));
                    output.append(text);
                } else if (item instanceof String) {
                    output.append(item);
                }
            }
            return output.toString();
        }
        return "";
    }

    private static JSONObject textPayload(String text) throws Exception {
        return new JSONObject().put("text", text == null ? "" : text);
    }

    private static JSONObject result(boolean ok, String message) throws Exception {
        return new JSONObject().put("ok", ok).put("message", message == null ? "" : message);
    }

    private static void emitError(EventSink sink, String message) {
        emitError(sink, message, "error");
    }

    private static void emitError(EventSink sink, String message, String event) {
        try {
            sink.onEvent(event, new JSONObject().put("message", message == null ? "请求失败" : message));
        } catch (Exception ignored) {
        }
    }

    private static boolean contains(JSONArray array, String value) {
        for (int i = 0; i < array.length(); i++) if (value.equals(array.optString(i))) return true;
        return false;
    }

    private static String friendlyError(Exception error) {
        if (error instanceof UnknownHostException) return "无法解析服务器地址，请检查网络或 API 地址";
        if (error instanceof SocketTimeoutException) return "连接超时，请检查 API 地址和网络";
        String message = error.getMessage();
        return message == null || message.trim().isEmpty() ? error.getClass().getSimpleName() : message;
    }
}
