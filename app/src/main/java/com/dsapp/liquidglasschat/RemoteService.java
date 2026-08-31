package com.dsapp.liquidglasschat;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.provider.Settings;
import android.text.TextUtils;
import android.util.Base64;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.ref.WeakReference;
import java.net.HttpURLConnection;
import java.net.InterfaceAddress;
import java.net.InetSocketAddress;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.net.URL;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CharsetDecoder;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * Foreground transport for DSH Remote.
 *
 * <p>The class intentionally contains small, named modules instead of sharing one executor:
 * ConnectionManager owns blocking connect/read work, HeartbeatManager owns ping/snapshot writes,
 * ControlSender owns ordered controls, EventRouter owns inbound normalization/forwarding,
 * NotificationController owns the foreground notification, and ConfigStore owns fallback settings.
 * This keeps every network operation off Android's main thread and prevents a blocking read loop
 * from starving controls.</p>
 */
public final class RemoteService extends Service {
    public static final String ACTION_MESSAGE = "com.dsapp.dshremote.REMOTE_MESSAGE";
    public static final String ACTION_CONNECT = "com.dsapp.dshremote.CONNECT";
    public static final String ACTION_DISCONNECT = "com.dsapp.dshremote.DISCONNECT";
    public static final String ACTION_CONTROL = "com.dsapp.dshremote.CONTROL";
    public static final String ACTION_CHECK_UPDATE = "com.dsapp.dshremote.CHECK_UPDATE";
    public static final String ACTION_UPDATE = "com.dsapp.dshremote.UPDATE";

    public static final String EXTRA_ENDPOINT = "endpoint";
    public static final String EXTRA_TOKEN = "token";
    public static final String EXTRA_TYPE = "controlType";
    public static final String EXTRA_DATA = "controlData";
    public static final String EXTRA_SESSION_ID = "controlSessionId";
    public static final String EXTRA_PAYLOAD = "payload";

    private static final String ACTION_WAKE = "com.dsapp.dshremote.WAKE";
    private static final String EXTRA_PRESERVE_SAVED = "preserveSavedSettings";
    private static final String TAG = "DSHRemoteV2";

    private static final String PREFS = "dsh_remote";
    private static final String KEY_ENDPOINT = "endpoint";
    private static final String KEY_TOKEN = "token";
    private static final String KEY_SNAPSHOT = "snapshot";
    private static final String KEY_SNAPSHOT_OWNER = "snapshotOwnerFingerprint";
    private static final String KEY_EXPLICITLY_OFFLINE = "explicitlyOffline";

    static final String BUILTIN_ENDPOINT = "ws://192.168.1.4:8788/ws";
    static final String BUILTIN_TOKEN = "CsRAoEQIuWeLxbPBVb_VJKufHGAcHrdB";

    private static final String CHANNEL_ID = "dsh_remote_live";
    private static final int NOTIFICATION_ID = 4201;
    private static final int UPDATE_NOTIFICATION_ID = 4202;
    private static final long MAX_UPDATE_BYTES = 256L * 1024L * 1024L;
    private static final int MAX_QUEUED_CONTROLS = 128;
    /** The deployed Bridge rejects client WebSocket frames above 1 MiB. */
    static final int MAX_CONTROL_FRAME_BYTES = 960 * 1024;
    private static final long MAX_CONTROL_QUEUE_BYTES = 4L * MAX_CONTROL_FRAME_BYTES;
    private static final long MAX_GATEWAY_PENDING_CHARS = 4L * MAX_CONTROL_FRAME_BYTES;
    private static final int MAX_TRACKED_SESSIONS = 64;
    private static final int[] BACKOFF_MS = {1_000, 2_000, 5_000, 10_000, 30_000};
    private static final int BRIDGE_DISCOVERY_PORT = 8787;
    private static final int BRIDGE_DISCOVERY_TIMEOUT_MS = 650;
    private static final int BRIDGE_TCP_PROBE_TIMEOUT_MS = 220;
    private static final int BRIDGE_TCP_PROBE_WINDOW_MS = 2_500;
    private static final long BRIDGE_DISCOVERY_INTERVAL_MS = 15_000L;
    private static final byte[] BRIDGE_DISCOVERY_REQUEST =
            "DSH_BRIDGE_DISCOVER v1".getBytes(StandardCharsets.UTF_8);
    private static final long HEARTBEAT_MS = 10_000L;
    private static final long SNAPSHOT_DEBOUNCE_MS = 350L;
    /** Blocks accidental double taps while still allowing a deliberate retry if no reply arrives. */
    private static final long APPROVAL_RETRY_LOCK_MS = 15_000L;

    private static volatile boolean transportConnected;
    private static volatile boolean appInForeground;
    /** Updated before an asynchronous session.activate snapshot can arrive. */
    private static volatile String preferredSessionId = "";
    private static volatile String pendingActivationSessionId = "";
    private static volatile long pendingActivationAt;
    /** True only after this connection generation has named a session explicitly. */
    private static volatile boolean sessionRoutingFresh;

    /**
     * Shared, bounded cache of inline images for user messages this device sent.
     * The frozen Bridge/DSH topology only carries attachment references on live
     * user.message echoes and authoritative history, so this cache is the only
     * source that can restore the real bytes for de-duplication and reloads.
     * It survives service recreation inside one process and is cleared on any
     * endpoint/token transition.
     */
    private static final ImageMessageAdapter IMAGE_MESSAGES = new ImageMessageAdapter();

    /** In-process delivery avoids Binder's transaction limit for histories containing images. */
    public interface MessageListener {
        /** Return true only after the Activity has accepted the frame into its own FIFO. */
        boolean onRemoteMessage(String payload, long endpointEpoch, long frameId);
    }

    public static void registerMessageListener(MessageListener listener) {
        MessageHub.register(listener);
    }

    public static void unregisterMessageListener(MessageListener listener) {
        MessageHub.unregister(listener);
    }

    /** Completes the one in-process frame currently owned by an Activity. */
    public static void acknowledgeMessage(long frameId, boolean delivered) {
        MessageHub.acknowledge(frameId, delivered);
    }

    /** Lets Activity discard a Service frame retained from a previous authenticated Bridge. */
    public static long currentMessageEpoch() {
        return MessageHub.currentEpoch();
    }

    /** Appends the persisted snapshot to the same FIFO as Service events; it never cuts in line. */
    public static void replaySnapshot(Context context) {
        MessageHub.post(getSnapshotJson(context.getApplicationContext()));
    }

    private ConfigStore configStore;
    private SnapshotStore snapshotStore;
    private NotificationController notifications;
    private ApprovalRegistry approvalRegistry;
    private SyncTracker syncTracker;
    private ControlResultTracker controlResults;
    private ControlSender controlSender;
    private HeartbeatManager heartbeatManager;
    private ConnectionManager connectionManager;
    private EventRouter eventRouter;
    private UpdateManager updateManager;
    private ConnectivityManager connectivityManager;
    private ConnectivityManager.NetworkCallback networkCallback;
    private PowerManager.WakeLock wakeLock;
    private volatile boolean destroyed;
    private volatile boolean acceptingControls;
    private volatile boolean foregroundStarted;
    /** Cancels a delayed explicit-stop callback when the user reconnects immediately. */
    private volatile long lifecycleGeneration;
    /** Serializes endpoint cache reset against one complete inbound-frame transaction. */
    private final Object endpointStateLock = new Object();

    @Override
    public void onCreate() {
        super.onCreate();
        configStore = new ConfigStore(this);
        snapshotStore = new SnapshotStore(
                getSharedPreferences(PREFS, MODE_PRIVATE));
        notifications = new NotificationController();
        approvalRegistry = new ApprovalRegistry();
        syncTracker = new SyncTracker();
        controlResults = new ControlResultTracker();
        controlSender = new ControlSender();
        heartbeatManager = new HeartbeatManager();
        connectionManager = new ConnectionManager();
        eventRouter = new EventRouter();
        updateManager = new UpdateManager();
        notifications.createChannel();
        MessageHub.attach(this);
        IMAGE_MESSAGES.attach(this);
        restoreSessionRoutingFromSnapshot();
        acceptingControls = !configStore.isExplicitlyOffline();
        if (acceptingControls) ServiceGateway.attach(this);
        registerNetworkCallback();
    }

    /**
     * After a process restart the persisted snapshot still proves which session
     * this authenticated endpoint was serving.  Restore that routing knowledge
     * so the gap before the first fresh snapshot does not reject legitimate
     * notification controls; a later endpoint change clears it again.
     */
    private void restoreSessionRoutingFromSnapshot() {
        if (sessionRoutingFresh) return;
        SettingsValue settings = configStore.current();
        if (snapshotStore.ownerMatches(settings.ownerFingerprint())) {
            String sessionId = snapshotStore.activeSessionId();
            if (!sessionId.isEmpty()) {
                preferredSessionId = sessionId;
                sessionRoutingFresh = true;
            }
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (ACTION_DISCONNECT.equals(action)) {
            stopExplicitly();
            return START_NOT_STICKY;
        }

        if (ACTION_CONNECT.equals(action)) {
            lifecycleGeneration++;
            configStore.setExplicitlyOffline(false);
            ServiceGateway.allowConnections();
            if (!acceptingControls) {
                acceptingControls = true;
                ServiceGateway.attach(this);
            }
        } else if (configStore.isExplicitlyOffline() || ServiceGateway.connectionsBlocked()) {
            // Notification actions and delayed ACTION_WAKE intents must not undo an explicit
            // disconnect.  A later ACTION_CONNECT is the only operation that opens the gate.
            acceptingControls = false;
            ServiceGateway.blockConnections("已主动断开；请先重新连接再发送控制");
            stopSelf();
            return START_NOT_STICKY;
        }

        // Every path that may have been launched with startForegroundService reaches this first.
        ensureForeground();

        if (ACTION_CONNECT.equals(action)) {
            connectFromIntent(intent);
        } else if (ACTION_CONTROL.equals(action)) {
            tryAcceptControl(
                    intent == null ? "" : intent.getStringExtra(EXTRA_TYPE),
                    intent == null ? "{}" : intent.getStringExtra(EXTRA_DATA),
                    intent == null ? "" : intent.getStringExtra(EXTRA_SESSION_ID));
        } else if (ACTION_CHECK_UPDATE.equals(action)) {
            connectionManager.ensureStarted(configStore.current());
            updateManager.check();
        } else if (ACTION_UPDATE.equals(action)) {
            connectionManager.ensureStarted(configStore.current());
            updateManager.download();
        } else {
            // Null intents are Android recreating this START_STICKY service. ACTION_WAKE is used
            // by the in-process gateway when a large prompt must not be placed in Intent extras.
            connectionManager.ensureStarted(configStore.current());
        }
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        unregisterNetworkCallback();
        ServiceGateway.detach(this);
        if (connectionManager != null) connectionManager.shutdown();
        if (heartbeatManager != null) heartbeatManager.shutdown();
        if (controlSender != null) controlSender.shutdown();
        if (updateManager != null) updateManager.shutdown();
        if (notifications != null) notifications.shutdown();
        releaseWakeLock();
        transportConnected = false;
        if (foregroundStarted) {
            stopForeground(STOP_FOREGROUND_REMOVE);
            foregroundStarted = false;
        }
        super.onDestroy();
    }

    /** Android 14 calls the single-argument variant; Android 15 the typed one. */
    @Override
    public void onTimeout(int startId) {
        timeoutStop();
    }

    /** Android 15 limits dataSync foreground services to six background hours per day. */
    @Override
    public void onTimeout(int startId, int fgsType) {
        timeoutStop();
    }

    /**
     * Stops synchronously: Android requires stopSelf() promptly inside
     * onTimeout, so the asynchronous transition barrier used for explicit
     * disconnects is bypassed here and onDestroy performs the cleanup.
     */
    private void timeoutStop() {
        Log.w(TAG, "Foreground dataSync time budget exhausted; stopping cleanly");
        acceptingControls = false;
        configStore.setExplicitlyOffline(true);
        ServiceGateway.blockConnections("后台运行时间配额已用完，请重新连接");
        clearPreferredSessionRouting();
        if (connectionManager != null) connectionManager.stop(true);
        if (controlSender != null) controlSender.shutdown();
        emitStatus("offline", "后台运行时间配额已用完，服务已停止");
        releaseWakeLock();
        if (foregroundStarted) {
            stopForeground(STOP_FOREGROUND_REMOVE);
            foregroundStarted = false;
        }
        stopSelf();
    }

    private void connectFromIntent(Intent intent) {
        try {
            SettingsValue settings = configStore.resolve(
                    intent == null ? "" : intent.getStringExtra(EXTRA_ENDPOINT),
                    intent == null ? "" : intent.getStringExtra(EXTRA_TOKEN),
                    intent != null && intent.getBooleanExtra(EXTRA_PRESERVE_SAVED, false));
            connectionManager.start(settings);
        } catch (Throwable error) {
            String detail = "连接配置无效：" + errorLabel(error);
            if (transportConnected) {
                emitStatus("control-error", detail);
            } else {
                emitStatus("disconnected", detail);
                notifications.onTransport("disconnected", errorLabel(error));
            }
        }
    }

    private boolean tryAcceptControl(String type, String dataJson, String sessionId) {
        if (destroyed || !acceptingControls || ServiceGateway.connectionsBlocked()) return false;
        connectionManager.ensureStarted(configStore.current());
        // Parsing/serializing attachment-heavy JSON belongs to dsh-control, never Service main.
        return controlSender.enqueueRaw(type, dataJson, sessionId);
    }

    private synchronized void ensureForeground() {
        if (foregroundStarted) return;
        foregroundStarted = true;
        startForeground(NOTIFICATION_ID, notifications.connectingNotification());
    }

    private void stopExplicitly() {
        final long stopToken = ++lifecycleGeneration;
        acceptingControls = false;
        configStore.setExplicitlyOffline(true);
        ServiceGateway.blockConnections("已主动断开，控制未发送");
        clearPreferredSessionRouting();
        final long stoppedGeneration = connectionManager == null
                ? -1L : connectionManager.stop(true);
        if (controlSender == null) {
            finishExplicitStop(stopToken, stoppedGeneration);
            return;
        }
        controlSender.beginTransition("已主动断开，待发控制已取消",
                () -> finishExplicitStop(stopToken, stoppedGeneration));
    }

    private void finishExplicitStop(long stopToken, long stoppedGeneration) {
        if (stopToken != lifecycleGeneration || !configStore.isExplicitlyOffline()
                || !ServiceGateway.connectionsBlocked()) return;
        if (connectionManager != null
                && !connectionManager.finishStoppedState(stoppedGeneration)) return;
        emitStatus("offline", "已断开");
        if (notifications != null) notifications.onTransport("offline", "已断开");
        releaseWakeLock();
        if (foregroundStarted) {
            stopForeground(STOP_FOREGROUND_REMOVE);
            foregroundStarted = false;
        }
        stopSelf();
    }

    private void acquireWakeLock() {
        if (wakeLock == null) {
            PowerManager manager = (PowerManager) getSystemService(POWER_SERVICE);
            if (manager != null) {
                wakeLock = manager.newWakeLock(
                        PowerManager.PARTIAL_WAKE_LOCK, getPackageName() + ":dsh-remote");
                wakeLock.setReferenceCounted(false);
            }
        }
        if (wakeLock != null && !wakeLock.isHeld()) wakeLock.acquire(15L * 60L * 1_000L);
    }

    private void requestReplayResync() {
        if (destroyed) return;
        heartbeatManager.requestSnapshotSoon();
        String sessionId = getActiveSessionId(this);
        if (sessionId.isEmpty()) return;
        try {
            controlSender.enqueue("session.history.request", new JSONObject()
                    .put("sessionId", sessionId)
                    .put("limit", 120)
                    .put("refresh", true), sessionId);
        } catch (Throwable error) {
            Log.w(TAG, "Replay overflow history resync failed: " + errorLabel(error));
        }
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            try {
                wakeLock.release();
            } catch (RuntimeException ignored) {
            }
        }
    }

    private void registerNetworkCallback() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return;
        Object service = getSystemService(CONNECTIVITY_SERVICE);
        if (!(service instanceof ConnectivityManager)) return;
        connectivityManager = (ConnectivityManager) service;
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                if (destroyed || configStore == null || configStore.isExplicitlyOffline()) return;
                // A new Wi-Fi route can make the old saved LAN address stale. The connection
                // manager will immediately probe the LAN and adopt the Bridge's current address.
                if (connectionManager != null) connectionManager.ensureStarted(configStore.current());
                if (heartbeatManager != null) heartbeatManager.requestSnapshotSoon();
            }

            @Override
            public void onLost(Network network) {
                if (destroyed || configStore == null || configStore.isExplicitlyOffline()) return;
                emitStatus("retrying", "网络已切换，正在自动修复 Bridge 连接");
                if (connectionManager != null) connectionManager.requestReconnect();
            }
        };
        try {
            connectivityManager.registerDefaultNetworkCallback(networkCallback);
        } catch (RuntimeException error) {
            Log.w(TAG, "Unable to register network callback: " + errorLabel(error));
            networkCallback = null;
        }
    }

    private void unregisterNetworkCallback() {
        if (connectivityManager == null || networkCallback == null) return;
        try {
            connectivityManager.unregisterNetworkCallback(networkCallback);
        } catch (RuntimeException ignored) {
        }
        networkCallback = null;
        connectivityManager = null;
    }

    // -----------------------------------------------------------------------------------------
    // Public/static bridge surface
    // -----------------------------------------------------------------------------------------

    public static void connect(Context context, String endpoint, String token) {
        startConnect(context, endpoint, token, false);
    }

    /** The first hard-coded auto-connect from the current page must not erase saved custom data. */
    static void connectFromPage(Context context, String endpoint, String token,
                                boolean preserveSavedForBuiltinAutoConnect) {
        startConnect(context, endpoint, token, preserveSavedForBuiltinAutoConnect);
    }

    private static void startConnect(Context context, String endpoint, String token,
                                     boolean preserveSaved) {
        Context app = context.getApplicationContext();
        SharedPreferences preferences = app.getSharedPreferences(PREFS, MODE_PRIVATE);
        // app.js performs a built-in auto-connect after every renderer reload.  That automatic
        // call must not undo a user's explicit disconnect; a subsequent manual connect uses
        // preserveSaved=false and deliberately opens the gate.
        if (preserveSaved && preferences.getBoolean(KEY_EXPLICITLY_OFFLINE, false)) return;
        preferences.edit().putBoolean(KEY_EXPLICITLY_OFFLINE, false).apply();
        ServiceGateway.allowConnections();
        Intent intent = new Intent(app, RemoteService.class)
                .setAction(ACTION_CONNECT)
                .putExtra(EXTRA_ENDPOINT, endpoint == null ? "" : endpoint)
                .putExtra(EXTRA_TOKEN, token == null ? "" : token)
                .putExtra(EXTRA_PRESERVE_SAVED, preserveSaved);
        ContextCompat.startForegroundService(app, intent);
    }

    public static void disconnect(Context context) {
        Context app = context.getApplicationContext();
        app.getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                .putBoolean(KEY_EXPLICITLY_OFFLINE, true).apply();
        ServiceGateway.blockConnections("已主动断开，控制未发送");
        app.startService(new Intent(app, RemoteService.class).setAction(ACTION_DISCONNECT));
    }

    public static void requestSnapshot(Context context) {
        submitControl(context, "session.snapshot.request", new JSONObject(), "");
    }

    public static boolean requestHistory(Context context, String sessionId,
                                         long beforeSeq, int limit) {
        return requestHistory(context, sessionId, beforeSeq, limit, false);
    }

    public static boolean refreshHistory(Context context, String sessionId, int limit) {
        return requestHistory(context, sessionId, -1L, limit, true);
    }

    private static boolean requestHistory(Context context, String sessionId, long beforeSeq,
                                          int limit, boolean refresh) {
        String id = trim(sessionId);
        if (id.isEmpty()) return false;
        try {
            JSONObject data = new JSONObject()
                    .put("sessionId", id)
                    .put("limit", clamp(limit, 1, 240));
            if (beforeSeq >= 0) data.put("beforeSeq", beforeSeq);
            if (refresh) data.put("refresh", true);
            return submitControl(context, "session.history.request", data, id);
        } catch (Throwable error) {
            reportControlError("历史请求构造失败：" + errorLabel(error));
            return false;
        }
    }

    public static boolean activateSession(Context context, String sessionId) {
        String id = trim(sessionId);
        boolean accepted = submitSessionRequest(context, "session.activate", id);
        if (accepted) {
            preferredSessionId = id;
            pendingActivationSessionId = id;
            pendingActivationAt = System.currentTimeMillis();
            sessionRoutingFresh = true;
        }
        return accepted;
    }

    public static boolean requestSessionContext(Context context, String sessionId) {
        return submitSessionRequest(context, "session.context.request", sessionId);
    }

    private static boolean submitSessionRequest(Context context, String type, String sessionId) {
        String id = trim(sessionId);
        if (id.isEmpty()) return false;
        try {
            return submitControl(context, type, new JSONObject().put("sessionId", id), id);
        } catch (Throwable error) {
            reportControlError(safe(type, "会话请求") + " 构造失败：" + errorLabel(error));
            return false;
        }
    }

    public static boolean createSession(Context context, String cwd,
                                        String projectId, String projectName, String workspaceId) {
        String target = trim(cwd);
        if (target.isEmpty()) return false;
        try {
            JSONObject data = new JSONObject()
                    .put("cwd", target)
                    .put("projectId", trim(projectId))
                    .put("projectName", trim(projectName))
                    .put("workspaceId", trim(workspaceId));
            return submitControl(context, "session.create", data, "");
        } catch (Throwable error) {
            reportControlError("新建会话请求构造失败：" + errorLabel(error));
            return false;
        }
    }

    public static void control(Context context, String type, JSONObject data) {
        control(context, type, data, "");
    }

    public static void control(Context context, String type, JSONObject data, String sessionId) {
        // Every false path reports its concrete cause at the admission layer. Reporting a
        // generic error here as well produced two toasts and hid the useful queue/start detail.
        submitControl(context, type, data, sessionId);
    }

    static boolean submitControl(Context context, String type,
                                 JSONObject data, String sessionId) {
        return ServiceGateway.submit(context.getApplicationContext(), type,
                data == null ? "{}" : data.toString(), sessionId);
    }

    public static void checkForUpdate(Context context) {
        ContextCompat.startForegroundService(context,
                new Intent(context, RemoteService.class).setAction(ACTION_CHECK_UPDATE));
    }

    public static void downloadUpdate(Context context) {
        ContextCompat.startForegroundService(context,
                new Intent(context, RemoteService.class).setAction(ACTION_UPDATE));
    }

    public static String getSettingsJson(Context context) {
        return new ConfigStore(context.getApplicationContext()).current().toJson().toString();
    }

    public static String getSnapshotJson(Context context) {
        SharedPreferences preferences = context.getSharedPreferences(PREFS, MODE_PRIVATE);
        JSONObject snapshot = sanitizeSnapshot(parseObject(preferences.getString(KEY_SNAPSHOT, "{}")));
        try {
            return new JSONObject()
                    .put("type", "session.snapshot")
                    .put("source", "native")
                    .put("data", snapshot)
                    .toString();
        } catch (Throwable ignored) {
            return "{\"type\":\"session.snapshot\",\"source\":\"native\",\"data\":{}}";
        }
    }

    static String getActiveSessionId(Context context) {
        JSONObject snapshot = parseObject(context.getSharedPreferences(PREFS, MODE_PRIVATE)
                .getString(KEY_SNAPSHOT, "{}"));
        JSONObject session = snapshot.optJSONObject("session");
        return session == null ? "" : trim(session.optString("id", ""));
    }

    static String getPreferredSessionId(Context context) {
        String preferred = trim(preferredSessionId);
        if (!preferred.isEmpty()) return preferred;
        return sessionRoutingFresh ? getActiveSessionId(context) : "";
    }

    private static synchronized void observeActiveSession(String activeSessionId) {
        String active = trim(activeSessionId);
        if (active.isEmpty()) return;
        String pending = trim(pendingActivationSessionId);
        boolean pendingFresh = !pending.isEmpty()
                && System.currentTimeMillis() - pendingActivationAt < 15_000L;
        if (pendingFresh && !pending.equals(active)) return;
        preferredSessionId = active;
        sessionRoutingFresh = true;
        if (pending.equals(active) || !pendingFresh) {
            pendingActivationSessionId = "";
            pendingActivationAt = 0L;
        }
    }

    private static synchronized void clearPreferredSessionRouting() {
        preferredSessionId = "";
        pendingActivationSessionId = "";
        pendingActivationAt = 0L;
        sessionRoutingFresh = false;
    }

    public static boolean isTransportConnected() {
        return transportConnected;
    }

    public static void setAppInForeground(boolean foreground) {
        appInForeground = foreground;
    }

    static void reportControlError(String message) {
        try {
            MessageHub.post(new JSONObject()
                    .put("type", "status")
                    .put("source", "native")
                    .put("data", new JSONObject()
                            .put("status", "control-error")
                            .put("message", safe(message, "控制失败")))
                    .toString());
        } catch (Throwable ignored) {
        }
    }

    /**
     * Registers the images this device just sent so the later text-only live
     * echo and authoritative history can be replaced with the real bytes.
     */
    static void rememberOutgoingImages(String sessionId, String text, JSONArray attachments) {
        IMAGE_MESSAGES.rememberOutgoing(sessionId, text, attachments);
    }

    static void reportPromptFailure(String sessionId, String message) {
        String detail = safe(message, "发送失败");
        try {
            MessageHub.post(new JSONObject()
                    .put("type", "control.result")
                    .put("source", "native")
                    .put("sessionId", trim(sessionId))
                    .put("data", new JSONObject()
                            .put("type", "prompt.send")
                            .put("sessionId", trim(sessionId))
                            .put("ok", false)
                            .put("error", detail))
                    .toString());
        } catch (Throwable ignored) {
        }
    }

    private static void reportAdmissionFailure(String type, String sessionId, String detail) {
        if ("prompt.send".equals(trim(type))) reportPromptFailure(sessionId, detail);
        else reportControlError(detail);
    }

    // -----------------------------------------------------------------------------------------
    // Connection manager: one blocking connect/read thread, generation-safe replacement
    // -----------------------------------------------------------------------------------------

    private final class ConnectionManager {
        private volatile long generation;
        private volatile boolean desired;
        private volatile String desiredUrl = "";
        private volatile WsConnection current;
        private ExecutorService executor;

        synchronized void ensureStarted(SettingsValue settings) {
            if (desired) return;
            start(settings);
        }

        synchronized void start(SettingsValue settings) {
            String nextUrl = settings.websocketUrl();
            if (desired && nextUrl.equals(desiredUrl)
                    && (executor == null || !executor.isShutdown())) {
                heartbeatManager.requestSnapshotSoon();
                return;
            }

            SharedPreferences preferences = getSharedPreferences(PREFS, MODE_PRIVATE);
            String ownerFingerprint = settings.ownerFingerprint();
            String snapshotOwner = trim(preferences.getString(KEY_SNAPSHOT_OWNER, ""));
            String storedSnapshot = trim(preferences.getString(KEY_SNAPSHOT, ""));
            boolean unknownSnapshotOwner = snapshotOwner.isEmpty()
                    && !storedSnapshot.isEmpty() && !"{}".equals(storedSnapshot);
            boolean endpointChanged = (!desiredUrl.isEmpty() && !nextUrl.equals(desiredUrl))
                    || (!snapshotOwner.isEmpty() && !ownerFingerprint.equals(snapshotOwner))
                    || unknownSnapshotOwner;
            generation++;
            long runGeneration = generation;
            desired = true;
            desiredUrl = nextUrl;
            // A freshly selected Bridge must prove its active session before any session-less
            // model control may reuse the snapshot persisted by a previous endpoint.
            clearPreferredSessionRouting();
            closeCurrent();
            transportConnected = false;
            heartbeatManager.cancelActive();
            if (executor != null) {
                executor.shutdownNow();
                executor = null;
            }

            if (endpointChanged) {
                // This barrier runs after every already-admitted control task.  New endpoint
                // state therefore cannot appear until the last old-endpoint write has either
                // completed or failed on the socket closed above.
                controlSender.beginTransition(
                        "连接地址或凭据已更换，旧 Bridge 的待发控制已取消",
                        () -> finishEndpointTransition(
                                nextUrl, ownerFingerprint, runGeneration));
                return;
            }
            preferences.edit().putString(KEY_SNAPSHOT_OWNER, ownerFingerprint).apply();
            launch(nextUrl, runGeneration);
        }

        private void finishEndpointTransition(String nextUrl, String ownerFingerprint,
                                              long runGeneration) {
            if (!isCurrent(runGeneration) || !nextUrl.equals(desiredUrl)) return;
            synchronized (endpointStateLock) {
                if (!isCurrent(runGeneration) || !nextUrl.equals(desiredUrl)) return;
                // Controls, reconciliation caches, queued UI frames, and the persisted snapshot
                // are all owned by one endpoint+token fingerprint.
                syncTracker.clear();
                controlResults.clear();
                approvalRegistry.clear();
                eventRouter.resetEndpointState();
                notifications.resetEndpointState();
                snapshotStore.resetForOwner(ownerFingerprint);
                MessageHub.resetEndpoint(getSnapshotJson(RemoteService.this));
            }
            launch(nextUrl, runGeneration);
        }

        private synchronized void launch(String nextUrl, long runGeneration) {
            if (!isCurrent(runGeneration) || !nextUrl.equals(desiredUrl)) return;
            if (executor != null) executor.shutdownNow();
            executor = Executors.newSingleThreadExecutor(namedThread("dsh-connection"));
            ensureForeground();
            acquireWakeLock();
            emitStatus("connecting", "正在连接 Bridge");
            notifications.onTransport("connecting", "正在连接 Bridge");
            long messageEpoch = MessageHub.currentEpoch();
            executor.execute(() -> runLoop(nextUrl, runGeneration, messageEpoch));
        }

        private void runLoop(String url, long runGeneration, long messageEpoch) {
            int failureIndex = 0;
            int successfulConnections = 0;
            long lastDiscoveryAt = 0L;
            boolean discoveredEndpoint = false;
            while (isCurrent(runGeneration)) {
                WsConnection socket = null;
                long connectedAt = 0L;
                String failureMessage = "连接已关闭";
                try {
                    if (failureIndex > 0) {
                        emitStatus("connecting", "正在重新连接 Bridge");
                    }
                    socket = new WsConnection(url);
                    socket.connect();
                    if (!install(socket, runGeneration)) break;

                    if (discoveredEndpoint) {
                        try {
                            SettingsValue repaired = configStore.adoptDiscoveredEndpoint(url);
                            url = repaired.websocketUrl();
                            synchronized (this) {
                                if (isCurrent(runGeneration)) desiredUrl = url;
                            }
                            Log.i(TAG, "Adopted discovered Bridge address: " + repaired.endpoint);
                        } catch (Throwable error) {
                            // A successful socket is still usable even if persisting the repair
                            // fails; the next reconnect will simply discover it again.
                            Log.w(TAG, "Unable to persist discovered Bridge address: "
                                    + errorLabel(error));
                        }
                        discoveredEndpoint = false;
                    }

                    boolean reconnect = successfulConnections > 0;
                    successfulConnections++;
                    connectedAt = System.currentTimeMillis();
                    final WsConnection connectedSocket = socket;
                    emitStatus("connected", reconnect ? "已重新连接 DSH Bridge" : "已连接 DSH Bridge");
                    notifications.onTransport("connected", "已连接 DSH Bridge");
                    heartbeatManager.onConnected(connectedSocket, runGeneration,
                            () -> controlSender.onConnected(connectedSocket, runGeneration, reconnect));

                    while (isActive(socket, runGeneration)) {
                        String text = socket.readTextMessage();
                        if (!isActive(socket, runGeneration)) break;
                        if (text != null) eventRouter.accept(text, runGeneration, messageEpoch);
                    }
                    throw new EOFException("Bridge WebSocket 已关闭");
                } catch (Throwable error) {
                    failureMessage = errorLabel(error);
                    if (isCurrent(runGeneration)) {
                        Log.w(TAG, "WebSocket connection failed: " + failureMessage);
                    }
                } finally {
                    uninstall(socket, runGeneration);
                    if (socket != null) socket.close();
                }

                if (!isCurrent(runGeneration)) break;
                if (connectedAt > 0 && System.currentTimeMillis() - connectedAt >= 30_000L) {
                    failureIndex = 0;
                }
                emitStatus("disconnected", failureMessage);
                notifications.onTransport("disconnected", failureMessage);

                long now = System.currentTimeMillis();
                if (now - lastDiscoveryAt >= BRIDGE_DISCOVERY_INTERVAL_MS || failureIndex == 0) {
                    lastDiscoveryAt = now;
                    String discovered = BridgeDiscovery.find(url);
                    if (!discovered.isEmpty() && !discovered.equals(url)) {
                        url = discovered;
                        discoveredEndpoint = true;
                        synchronized (this) {
                            if (isCurrent(runGeneration)) desiredUrl = url;
                        }
                        failureIndex = 0;
                        emitStatus("retrying", "发现 Bridge 新地址，正在自动修复连接");
                        notifications.onTransport("retrying", "发现 Bridge 新地址，正在自动修复连接");
                        continue;
                    }
                }
                int waitMs = BACKOFF_MS[Math.min(failureIndex, BACKOFF_MS.length - 1)];
                failureIndex++;
                emitStatus("retrying", (waitMs / 1000) + " 秒后重试：" + failureMessage);
                if (!sleepInterruptibly(waitMs, runGeneration)) break;
            }
        }

        private synchronized boolean install(WsConnection socket, long runGeneration) {
            if (!isCurrent(runGeneration)) {
                socket.close();
                return false;
            }
            current = socket;
            transportConnected = true;
            return true;
        }

        private synchronized void uninstall(WsConnection socket, long runGeneration) {
            if (generation != runGeneration || current != socket) return;
            current = null;
            transportConnected = false;
            heartbeatManager.onDisconnected(socket, runGeneration);
            reportUnconfirmedControls(controlResults.drainUnconfirmed());
        }

        /**
         * Controls whose write succeeded but which never received a Bridge
         * result before this connection died would otherwise vanish silently.
         */
        private void reportUnconfirmedControls(List<SentControl> unconfirmed) {
            if (unconfirmed == null || unconfirmed.isEmpty()) return;
            int other = 0;
            for (SentControl sent : unconfirmed) {
                if ("prompt.send".equals(sent.type)) {
                    reportPromptFailure(sent.sessionId,
                            "连接中断，Bridge 未返回送达确认；DSH 可能已收到消息，请勿重复发送");
                } else {
                    other++;
                }
            }
            if (other > 0) {
                emitStatus("control-error", other + " 条控制未收到 Bridge 确认");
            }
        }

        long stop(boolean explicit) {
            long stoppedGeneration;
            synchronized (this) {
                generation++;
                stoppedGeneration = generation;
                desired = false;
                desiredUrl = "";
                clearPreferredSessionRouting();
                closeCurrent();
                if (executor != null) {
                    executor.shutdownNow();
                    executor = null;
                }
                transportConnected = false;
                heartbeatManager.cancelActive();
            }
            if (!explicit) emitStatus("disconnected", "连接已停止");
            return stoppedGeneration;
        }

        boolean finishStoppedState(long stoppedGeneration) {
            if (desired || generation != stoppedGeneration) return false;
            synchronized (endpointStateLock) {
                if (desired || generation != stoppedGeneration) return false;
                // Wait for an already-parsed inbound event to finish, then place "offline"
                // behind it.  The authenticated owner did not change, so keep Hub/history/router
                // state for a later reconnect instead of dropping legitimate final events.
                controlResults.clear();
            }
            return true;
        }

        void shutdown() {
            synchronized (this) {
                generation++;
                desired = false;
                desiredUrl = "";
                clearPreferredSessionRouting();
                closeCurrent();
                if (executor != null) {
                    executor.shutdownNow();
                    executor = null;
                }
                transportConnected = false;
                heartbeatManager.cancelActive();
            }
        }

        private void closeCurrent() {
            WsConnection socket = current;
            current = null;
            if (socket != null) socket.close();
        }

        WsConnection currentConnection() {
            return transportConnected ? current : null;
        }

        boolean isCurrent(long runGeneration) {
            return desired && generation == runGeneration && !destroyed;
        }

        boolean isActive(WsConnection socket, long runGeneration) {
            return isCurrent(runGeneration) && current == socket && !socket.isClosed();
        }

        void invalidate(WsConnection socket, Throwable cause) {
            if (socket != null && current == socket) {
                Log.w(TAG, "Invalidating WebSocket: " + errorLabel(cause));
                socket.close();
            }
        }

        void requestReconnect() {
            synchronized (this) {
                if (!desired) return;
                closeCurrent();
            }
        }

        private boolean sleepInterruptibly(long durationMs, long runGeneration) {
            long remaining = durationMs;
            while (remaining > 0 && isCurrent(runGeneration)) {
                long slice = Math.min(remaining, 500L);
                try {
                    Thread.sleep(slice);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    return false;
                }
                remaining -= slice;
            }
            return isCurrent(runGeneration);
        }
    }

    /**
     * Finds the Bridge on the current LAN without trusting a stale saved IP. The UDP response
     * never contains the token; the phone carries its existing token forward to the discovered
     * WebSocket URL and still authenticates exactly as before.
     */
    private static final class BridgeDiscovery {
        private BridgeDiscovery() {
        }

        static String find(String currentWebSocketUrl) {
            try {
                URI current = URI.create(trim(currentWebSocketUrl));
                String host = trim(current.getHost());
                if (host.isEmpty() || "localhost".equalsIgnoreCase(host)
                        || "127.0.0.1".equals(host) || "::1".equals(host)) return "";
                String token = tokenFromEndpoint(currentWebSocketUrl);
                String discovered = findOverUdp(current, token);
                if (!discovered.isEmpty()) return discovered;

                // Some Windows installations allow the Bridge TCP port but block the UDP
                // discovery port. Probe only the phone's local WLAN subnets as a fallback.
                return findOverTcp(current, token);
            } catch (Throwable error) {
                Log.d(TAG, "Bridge LAN discovery unavailable: " + errorLabel(error));
            }
            return "";
        }

        private static String findOverUdp(URI current, String token) {
            try {
                try (DatagramSocket socket = new DatagramSocket()) {
                    socket.setBroadcast(true);
                    socket.setSoTimeout(BRIDGE_DISCOVERY_TIMEOUT_MS);
                    DatagramPacket request = new DatagramPacket(
                            BRIDGE_DISCOVERY_REQUEST,
                            BRIDGE_DISCOVERY_REQUEST.length,
                            InetAddress.getByName("255.255.255.255"),
                            BRIDGE_DISCOVERY_PORT);
                    socket.send(request);
                    long deadline = SystemClock.elapsedRealtime() + BRIDGE_DISCOVERY_TIMEOUT_MS;
                    byte[] buffer = new byte[4096];
                    while (SystemClock.elapsedRealtime() < deadline) {
                        DatagramPacket response = new DatagramPacket(buffer, buffer.length);
                        try {
                            socket.receive(response);
                        } catch (SocketTimeoutException timeout) {
                            break;
                        }
                        JSONObject payload;
                        try {
                            payload = new JSONObject(new String(
                                    response.getData(), response.getOffset(), response.getLength(),
                                    StandardCharsets.UTF_8));
                        } catch (Throwable ignored) {
                            continue;
                        }
                        if (!"dsh-remote-bridge".equals(payload.optString("service", ""))
                                || payload.optInt("version", -1) != 1) continue;
                        int bridgePort = payload.optInt("port", -1);
                        if (bridgePort < 1 || bridgePort > 65535) continue;
                        String path = payload.optString("path", "/ws");
                        String scheme = trim(current.getScheme()).isEmpty()
                                ? "ws" : current.getScheme();
                        String endpoint = new URI(scheme, current.getRawUserInfo(),
                                response.getAddress().getHostAddress(), bridgePort,
                                path, null, null).toString();
                        return appendToken(endpoint, token);
                    }
                }
            } catch (Throwable error) {
                Log.d(TAG, "Bridge UDP discovery unavailable: " + errorLabel(error));
            }
            return "";
        }

        private static String findOverTcp(URI current, String token) {
            LinkedHashSet<String> candidates = new LinkedHashSet<>();
            try {
                java.util.Enumeration<NetworkInterface> interfaces =
                        NetworkInterface.getNetworkInterfaces();
                while (interfaces != null && interfaces.hasMoreElements()) {
                    NetworkInterface network = interfaces.nextElement();
                    if (!network.isUp() || network.isLoopback() || network.isVirtual()) continue;
                    for (InterfaceAddress interfaceAddress : network.getInterfaceAddresses()) {
                        InetAddress address = interfaceAddress.getAddress();
                        if (!(address instanceof java.net.Inet4Address)) continue;
                        int local = ipv4ToInt(address.getAddress());
                        int prefix = interfaceAddress.getNetworkPrefixLength();
                        if (prefix < 8 || prefix > 30) continue;

                        // A /16 or larger WLAN is uncommon and probing all of it is wasteful;
                        // the Bridge and phone will normally share the same /24 segment.
                        int effectivePrefix = Math.max(prefix, 24);
                        int mask = effectivePrefix == 32
                                ? -1 : (int) (0xFFFFFFFFL << (32 - effectivePrefix));
                        int networkBase = local & mask;
                        int hostCount = 1 << (32 - effectivePrefix);
                        for (int offset = 1; offset < hostCount - 1; offset++) {
                            int candidate = networkBase + offset;
                            if (candidate == local) continue;
                            candidates.add(intToIpv4(candidate));
                        }
                    }
                }
            } catch (Throwable error) {
                Log.d(TAG, "Unable to enumerate local LAN for Bridge probe: "
                        + errorLabel(error));
                return "";
            }
            if (candidates.isEmpty()) return "";

            final String scheme = trim(current.getScheme()).isEmpty()
                    ? "ws" : current.getScheme();
            final String path = "/ws";
            final int port = current.getPort() > 0 ? current.getPort() : 8788;
            List<java.util.concurrent.Callable<String>> probes = new ArrayList<>();
            for (String candidate : candidates) {
                probes.add(() -> probeTcpCandidate(candidate, port, scheme, path, token));
            }

            ExecutorService scanner = Executors.newFixedThreadPool(
                    Math.min(24, Math.max(1, probes.size())), namedThread("dsh-bridge-scan"));
            try {
                List<Future<String>> results = scanner.invokeAll(
                        probes, BRIDGE_TCP_PROBE_WINDOW_MS, TimeUnit.MILLISECONDS);
                for (Future<String> result : results) {
                    if (result.isCancelled()) continue;
                    try {
                        String endpoint = result.get();
                        if (!endpoint.isEmpty()) return endpoint;
                    } catch (Throwable ignored) {
                        // A host that disappears during a scan is expected on mobile networks.
                    }
                }
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            } finally {
                scanner.shutdownNow();
            }
            return "";
        }

        private static String probeTcpCandidate(String host, int port, String scheme,
                                                String path, String token) {
            HttpURLConnection connection = null;
            try {
                String query = token.isEmpty() ? "" : "?token="
                        + URLEncoder.encode(token, StandardCharsets.UTF_8.name());
                URL healthUrl = new URL("http", host, port, "/health" + query);
                connection = (HttpURLConnection) healthUrl.openConnection();
                connection.setRequestMethod("GET");
                connection.setConnectTimeout(BRIDGE_TCP_PROBE_TIMEOUT_MS);
                connection.setReadTimeout(BRIDGE_TCP_PROBE_TIMEOUT_MS);
                connection.setUseCaches(false);
                if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) return "";
                String body = readAtMost(connection.getInputStream(), 2048);
                if (!body.contains("dsh-remote-bridge")) return "";
                String endpoint = new URI(scheme, null, host, port, path, null, null).toString();
                return appendToken(endpoint, token);
            } catch (Throwable ignored) {
                return "";
            } finally {
                if (connection != null) connection.disconnect();
            }
        }

        private static String readAtMost(InputStream input, int maxBytes) throws IOException {
            try (InputStream source = input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[512];
                int remaining = maxBytes;
                while (remaining > 0) {
                    int read = source.read(buffer, 0, Math.min(buffer.length, remaining));
                    if (read < 0) break;
                    output.write(buffer, 0, read);
                    remaining -= read;
                }
                return output.toString(StandardCharsets.UTF_8.name());
            }
        }

        private static int ipv4ToInt(byte[] bytes) {
            return ((bytes[0] & 0xFF) << 24)
                    | ((bytes[1] & 0xFF) << 16)
                    | ((bytes[2] & 0xFF) << 8)
                    | (bytes[3] & 0xFF);
        }

        private static String intToIpv4(int value) {
            return ((value >>> 24) & 0xFF) + "."
                    + ((value >>> 16) & 0xFF) + "."
                    + ((value >>> 8) & 0xFF) + "."
                    + (value & 0xFF);
        }
    }

    // -----------------------------------------------------------------------------------------
    // Heartbeat manager: its own scheduled thread, never the blocking reader/control executor
    // -----------------------------------------------------------------------------------------

    private final class HeartbeatManager {
        private final ScheduledExecutorService executor = Executors.newSingleThreadScheduledExecutor(
                namedThread("dsh-heartbeat"));
        private ScheduledFuture<?> periodic;
        private ScheduledFuture<?> debounce;
        private WsConnection active;
        private long activeGeneration;
        private long lastSnapshotAt;

        synchronized void onConnected(WsConnection socket, long generation,
                                      Runnable afterInitialSnapshot) {
            cancelLocked();
            active = socket;
            activeGeneration = generation;
            executor.execute(() -> {
                if (!connectionManager.isActive(socket, generation)) return;
                try {
                    acquireWakeLock();
                    sendSnapshot(socket);
                    afterInitialSnapshot.run();
                } catch (Throwable error) {
                    connectionManager.invalidate(socket, error);
                }
            });
            periodic = executor.scheduleWithFixedDelay(() -> {
                if (!connectionManager.isActive(socket, generation)) return;
                try {
                    acquireWakeLock();
                    socket.sendPing();
                    sendSnapshot(socket);
                } catch (Throwable error) {
                    connectionManager.invalidate(socket, error);
                }
            }, HEARTBEAT_MS, HEARTBEAT_MS, TimeUnit.MILLISECONDS);
        }

        synchronized void onDisconnected(WsConnection socket, long generation) {
            if (active == socket && activeGeneration == generation) cancelLocked();
        }

        synchronized void cancelActive() {
            cancelLocked();
        }

        void requestSnapshotSoon() {
            synchronized (this) {
                if (active == null || active.isClosed()) return;
                if (debounce != null && !debounce.isDone()) return;
                long elapsed = System.currentTimeMillis() - lastSnapshotAt;
                long delay = Math.max(0L, SNAPSHOT_DEBOUNCE_MS - elapsed);
                WsConnection socket = active;
                long generation = activeGeneration;
                debounce = executor.schedule(() -> {
                    if (!connectionManager.isActive(socket, generation)) return;
                    try {
                        sendSnapshot(socket);
                    } catch (Throwable error) {
                        connectionManager.invalidate(socket, error);
                    }
                }, delay, TimeUnit.MILLISECONDS);
            }
        }

        private void sendSnapshot(WsConnection socket) throws Exception {
            socket.sendText(new JSONObject()
                    .put("type", "session.snapshot.request")
                    .put("data", new JSONObject())
                    .toString());
            synchronized (this) {
                lastSnapshotAt = System.currentTimeMillis();
            }
        }

        private void cancelLocked() {
            if (periodic != null) periodic.cancel(false);
            if (debounce != null) debounce.cancel(false);
            periodic = null;
            debounce = null;
            active = null;
            activeGeneration = 0L;
        }

        void shutdown() {
            synchronized (this) {
                cancelLocked();
            }
            executor.shutdownNow();
        }
    }

    // -----------------------------------------------------------------------------------------
    // Control sender: immutable frames queued FIFO and written by a dedicated single thread
    // -----------------------------------------------------------------------------------------

    private final class ControlSender {
        private final ExecutorService executor = Executors.newSingleThreadExecutor(
                namedThread("dsh-control"));
        private final ArrayDeque<ControlItem> queue = new ArrayDeque<>();
        private long queuedBytes;
        private long pendingRawChars;
        private int pendingBuilds;
        private long admissionGeneration;
        private boolean shuttingDown;
        private boolean transitioning;
        private String transitionReason = "";

        boolean enqueue(String type, JSONObject data, String explicitSessionId) {
            return enqueueRaw(type, data == null ? "{}" : data.toString(), explicitSessionId);
        }

        boolean enqueueRaw(String type, String dataJson, String explicitSessionId) {
            final String raw = TextUtils.isEmpty(dataJson) ? "{}" : dataJson;
            final long token;
            synchronized (queue) {
                if (shuttingDown) {
                    reportAdmissionFailure(type, explicitSessionId,
                            "控制服务正在停止，消息未进入发送队列");
                    return false;
                }
                if (transitioning) {
                    reportAdmissionFailure(type, explicitSessionId,
                            safe(transitionReason, "连接正在切换，消息未进入发送队列"));
                    return false;
                }
                if (raw.length() > MAX_CONTROL_FRAME_BYTES) {
                    reportAdmissionFailure(type, explicitSessionId, safe(type, "控制消息")
                            + " 数据超过 Bridge 1 MiB 帧上限，请减少文字或图片");
                    return false;
                }
                if (queue.size() + pendingBuilds >= MAX_QUEUED_CONTROLS) {
                    reportAdmissionFailure(type, explicitSessionId, "控制队列已满（"
                            + MAX_QUEUED_CONTROLS + " 条），未丢弃旧命令；请等待连接恢复后重试");
                    return false;
                }
                if (queuedBytes + pendingRawChars + raw.length() > MAX_CONTROL_QUEUE_BYTES) {
                    reportAdmissionFailure(type, explicitSessionId,
                            "控制队列已达到 4 MiB 内存预算，请等待发送后重试");
                    return false;
                }
                pendingBuilds++;
                pendingRawChars += raw.length();
                token = admissionGeneration;
            }
            try {
                executor.execute(() -> prepareAndQueue(type, raw, explicitSessionId, token));
                return true;
            } catch (Throwable error) {
                synchronized (queue) {
                    pendingBuilds--;
                    pendingRawChars -= raw.length();
                }
                reportAdmissionFailure(type, explicitSessionId,
                        "控制线程不可用：" + errorLabel(error));
                return false;
            }
        }

        private void prepareAndQueue(String type, String rawData, String explicitSessionId,
                                     long token) {
            ControlItem item = null;
            Throwable failure = null;
            try {
                item = buildControlItem(type, new JSONObject(rawData), explicitSessionId);
            } catch (Throwable error) {
                failure = error;
            }
            boolean admitted = false;
            synchronized (queue) {
                pendingBuilds--;
                pendingRawChars -= rawData.length();
                if (failure == null && item != null && !shuttingDown
                        && token == admissionGeneration) {
                    if (queuedBytes + item.byteSize <= MAX_CONTROL_QUEUE_BYTES) {
                        queue.addLast(item);
                        queuedBytes += item.byteSize;
                        admitted = true;
                    } else {
                        failure = new IOException("控制队列已达到 4 MiB 内存预算");
                    }
                }
            }
            if (!admitted) {
                if (item != null && ("approval.allow".equals(item.type)
                        || "approval.deny".equals(item.type))) {
                    approvalRegistry.cancelResolution(item.sessionId,
                            trim(item.data.optString("requestId", "")),
                            item.approvalAttemptId);
                }
                String detail = failure == null
                        ? currentTransitionReason()
                        : "控制消息无效：" + errorLabel(failure);
                if ("prompt.send".equals(trim(type))) {
                    reportPromptFailure(explicitSessionId, detail);
                } else {
                    emitStatus("control-error", detail);
                }
                return;
            }
            syncTracker.record(item.type, item.data, item.sessionId);
            scheduleFlush();
        }

        private ControlItem buildControlItem(String type, JSONObject data,
                                             String explicitSessionId) throws Exception {
            String normalizedType = trim(type);
            if (normalizedType.isEmpty()) throw new IllegalArgumentException("缺少控制类型");
            JSONObject frozenData = parseObject(data == null ? "{}" : data.toString());
            String sessionId = trim(explicitSessionId);
            if (sessionId.isEmpty()) sessionId = trim(frozenData.optString("sessionId", ""));
            if (requiresSession(normalizedType) && sessionId.isEmpty()) {
                throw new IllegalArgumentException(normalizedType + " 缺少 sessionId，已拒绝猜测当前会话");
            }
            boolean approvalDecision = "approval.allow".equals(normalizedType)
                    || "approval.deny".equals(normalizedType);
            // Approval decisions carry a frozen requestId that DSH itself
            // re-validates against its pending set, so a process restart must
            // not dead-end a still-pending notification action; all other
            // session controls keep the fresh-session barrier.
            if (requiresSession(normalizedType) && !sessionRoutingFresh && !approvalDecision) {
                throw new IllegalStateException("新连接尚未同步会话，已拒绝把控制发送到旧 sessionId");
            }

            String approvalRequestId = "";
            if (approvalDecision) {
                approvalRequestId = trim(frozenData.optString("requestId", ""));
                if (approvalRequestId.isEmpty()) {
                    throw new IllegalArgumentException("审批命令缺少 requestId");
                }
                if (approvalRegistry.isResolved(sessionId, approvalRequestId)) {
                    throw new IllegalStateException("审批 " + approvalRequestId + " 已处理，未重复发送");
                }
            }
            if ("session.selectModel".equals(normalizedType)
                    && trim(frozenData.optString("model", "")).isEmpty()) {
                throw new IllegalArgumentException("模型切换缺少 model");
            }

            JSONObject frame = new JSONObject().put("type", normalizedType);
            if (isBareRequest(normalizedType)) {
                frame.put("data", frozenData);
            } else {
                String projectId = trim(frozenData.optString("projectId", ""));
                if (projectId.isEmpty()) projectId = snapshotStore.projectIdForSession(sessionId);
                frame.put("version", 1);
                frame.put("timestamp", System.currentTimeMillis());
                frame.put("sessionId", sessionId.isEmpty() ? JSONObject.NULL : sessionId);
                frame.put("projectId", projectId.isEmpty() ? JSONObject.NULL : projectId);
                frame.put("data", frozenData);
            }
            String serialized = frame.toString();
            int byteSize = serialized.getBytes(StandardCharsets.UTF_8).length;
            if (byteSize > MAX_CONTROL_FRAME_BYTES) {
                throw new IOException(normalizedType + " 为 " + byteSize
                        + " 字节，超过 Bridge 安全帧预算 " + MAX_CONTROL_FRAME_BYTES
                        + " 字节；请减少文字或图片");
            }
            long approvalAttemptId = 0L;
            if (!approvalRequestId.isEmpty()) {
                approvalAttemptId = approvalRegistry.beginResolution(sessionId,
                        approvalRequestId, normalizedType);
                if (approvalAttemptId == 0L) {
                    throw new IllegalStateException("审批 " + approvalRequestId
                            + " 已处理或正在处理，未重复发送");
                }
            }
            return new ControlItem(normalizedType, sessionId, frozenData, serialized, byteSize,
                    approvalAttemptId);
        }

        private boolean requiresSession(String type) {
            return "prompt.send".equals(type)
                    || "task.stop".equals(type)
                    || "task.continue".equals(type)
                    || "session.selectModel".equals(type)
                    || "approval.allow".equals(type)
                    || "approval.deny".equals(type);
        }

        private boolean isBareRequest(String type) {
            return "session.snapshot.request".equals(type)
                    || "session.history.request".equals(type)
                    || "session.activate".equals(type)
                    || "session.context.request".equals(type)
                    || "session.create".equals(type);
        }

        private void scheduleFlush() {
            WsConnection socket = connectionManager.currentConnection();
            if (socket == null) return;
            long generation = connectionManager.generation;
            executor.execute(() -> flush(socket, generation, false));
        }

        void onConnected(WsConnection socket, long generation, boolean reconnect) {
            executor.execute(() -> flush(socket, generation, reconnect));
        }

        private void flush(WsConnection socket, long generation, boolean reconnect) {
            Set<String> historiesSentFromQueue = new LinkedHashSet<>();
            while (connectionManager.isActive(socket, generation)) {
                ControlItem item;
                synchronized (queue) {
                    item = queue.peekFirst();
                }
                if (item == null) break;
                boolean approval = "approval.allow".equals(item.type)
                        || "approval.deny".equals(item.type);
                String approvalRequestId = approval
                        ? trim(item.data.optString("requestId", "")) : "";
                if (approval && !approvalRegistry.claimForSend(item.sessionId,
                        approvalRequestId, item.type, item.approvalAttemptId)) {
                    synchronized (queue) {
                        if (queue.peekFirst() == item) {
                            queue.removeFirst();
                            queuedBytes -= item.byteSize;
                        }
                    }
                    approvalRegistry.cancelResolution(item.sessionId, approvalRequestId,
                            item.approvalAttemptId);
                    emitStatus("control-error", "审批已变化或已处理，旧决定未发送");
                    continue;
                }
                SentControl pendingResult = controlResults.begin(item);
                try {
                    socket.sendText(item.serializedFrame);
                } catch (Throwable error) {
                    controlResults.cancel(pendingResult);
                    if (approval) {
                        approvalRegistry.markResolutionSendFailed(item.sessionId,
                                approvalRequestId, item.type, item.approvalAttemptId);
                    }
                    if (connectionManager.isCurrent(generation)) {
                        emitStatus("control-error", item.type
                                + " 发送失败（已保留队列等待重连）：" + errorLabel(error));
                    }
                    connectionManager.invalidate(socket, error);
                    return;
                }
                if (approval) {
                    approvalRegistry.markResolutionSent(item.sessionId, approvalRequestId, item.type,
                            item.approvalAttemptId);
                }
                synchronized (queue) {
                    if (queue.peekFirst() == item) {
                        queue.removeFirst();
                        queuedBytes -= item.byteSize;
                    }
                }
                if ("session.history.request".equals(item.type)) {
                    String id = trim(item.data.optString("sessionId", item.sessionId));
                    if (!id.isEmpty()) historiesSentFromQueue.add(id);
                }
            }

            if (!reconnect || !connectionManager.isActive(socket, generation)) return;
            for (String frame : syncTracker.reconnectHistoryFrames(historiesSentFromQueue)) {
                if (!connectionManager.isActive(socket, generation)) return;
                try {
                    socket.sendText(frame);
                } catch (Throwable error) {
                    emitStatus("control-error", "重连后历史同步失败：" + errorLabel(error));
                    connectionManager.invalidate(socket, error);
                    return;
                }
            }
        }

        void beginTransition(String reason, Runnable afterBarrier) {
            final String detail = safe(reason, "连接正在切换，待发控制已取消");
            final long transitionToken;
            synchronized (queue) {
                admissionGeneration++;
                transitionToken = admissionGeneration;
                transitioning = true;
                transitionReason = detail;
            }
            try {
                executor.execute(() -> runTransitionBarrier(
                        detail, transitionToken, afterBarrier));
            } catch (Throwable error) {
                Log.e(TAG, "Control transition executor rejected barrier", error);
                runTransitionBarrier(detail, transitionToken, afterBarrier);
            }
        }

        private void runTransitionBarrier(String reason, long transitionToken,
                                          Runnable afterBarrier) {
            discardQueued(reason);
            boolean current;
            synchronized (queue) {
                current = transitionToken == admissionGeneration;
            }
            try {
                if (current && afterBarrier != null) afterBarrier.run();
            } catch (Throwable error) {
                Log.e(TAG, "Control transition callback failed", error);
                emitStatus("control-error", "连接切换失败：" + errorLabel(error));
            } finally {
                synchronized (queue) {
                    if (transitionToken == admissionGeneration) {
                        transitioning = false;
                        transitionReason = "";
                    }
                }
            }
        }

        private String currentTransitionReason() {
            synchronized (queue) {
                if (transitioning) return safe(transitionReason, "连接正在切换，消息未进入发送队列");
                return shuttingDown ? "控制服务已停止，消息未进入发送队列"
                        : "控制准入已失效，消息未进入发送队列";
            }
        }

        private void discardQueued(String reason) {
            ArrayList<ControlItem> discarded;
            synchronized (queue) {
                discarded = new ArrayList<>(queue);
                queue.clear();
                queuedBytes = 0L;
            }
            int otherControls = 0;
            for (ControlItem item : discarded) {
                if ("approval.allow".equals(item.type) || "approval.deny".equals(item.type)) {
                    approvalRegistry.cancelResolution(item.sessionId,
                            trim(item.data.optString("requestId", "")),
                            item.approvalAttemptId);
                }
                if ("prompt.send".equals(item.type)) {
                    reportPromptFailure(item.sessionId, safe(reason, "待发消息已取消"));
                } else {
                    otherControls++;
                }
            }
            if (otherControls > 0) {
                emitStatus("control-error", safe(reason, "待发控制已取消")
                        + "（" + otherControls + " 条）");
            }
        }

        void shutdown() {
            synchronized (queue) {
                shuttingDown = true;
                transitioning = false;
                transitionReason = "";
                admissionGeneration++;
            }
            discardQueued("后台服务已停止，待发控制已取消");
            executor.shutdownNow();
        }
    }

    private static final class ControlItem {
        final String type;
        final String sessionId;
        final JSONObject data;
        final String serializedFrame;
        final int byteSize;
        final long approvalAttemptId;

        ControlItem(String type, String sessionId, JSONObject data, String serializedFrame,
                    int byteSize, long approvalAttemptId) {
            this.type = type;
            this.sessionId = sessionId;
            this.data = data;
            this.serializedFrame = serializedFrame;
            this.byteSize = byteSize;
            this.approvalAttemptId = approvalAttemptId;
        }
    }

    /** Restores session/type metadata that older Bridge control.result frames omit. */
    private static final class ControlResultTracker {
        private final ArrayDeque<SentControl> pending = new ArrayDeque<>();

        synchronized SentControl begin(ControlItem item) {
            if (item == null || !expectsResult(item.type)) return null;
            SentControl sent = new SentControl(item.type, item.sessionId,
                    trim(item.data.optString("requestId", "")), item.approvalAttemptId);
            pending.addLast(sent);
            while (pending.size() > 256) pending.removeFirst();
            return sent;
        }

        synchronized void cancel(SentControl sent) {
            if (sent != null) pending.remove(sent);
        }

        synchronized SentControl complete(String resultType, String resultSessionId,
                                          String resultRequestId) {
            String type = trim(resultType);
            String sessionId = trim(resultSessionId);
            String requestId = trim(resultRequestId);
            if (pending.isEmpty()) return null;
            if (type.isEmpty() && sessionId.isEmpty() && requestId.isEmpty()) {
                return pending.removeFirst();
            }

            // Bridge serializes each client's control queue.  Use every identifier it supplied;
            // when an older Bridge omits request/session metadata, choose the first compatible
            // sent control so same-type results retain Bridge FIFO order.
            SentControl match;
            if (!requestId.isEmpty()) {
                match = firstCompatible(type, sessionId, requestId);
            } else if (!sessionId.isEmpty()) {
                match = firstCompatible(type, sessionId, "");
            } else if (!type.isEmpty()) {
                match = firstCompatible(type, "", "");
            } else {
                match = pending.peekFirst();
            }
            if (match == null) return null;
            Iterator<SentControl> iterator = pending.iterator();
            while (iterator.hasNext()) {
                SentControl sent = iterator.next();
                if (sent != match) continue;
                iterator.remove();
                return sent;
            }
            return null;
        }

        private SentControl firstCompatible(String type, String sessionId, String requestId) {
            for (SentControl sent : pending) {
                if (!type.isEmpty() && !type.equals(sent.type)) continue;
                if (!sessionId.isEmpty() && !sessionId.equals(sent.sessionId)) continue;
                if (!requestId.isEmpty() && !requestId.equals(sent.requestId)) continue;
                return sent;
            }
            return null;
        }

        synchronized void clear() {
            pending.clear();
        }

        synchronized List<SentControl> drainUnconfirmed() {
            ArrayList<SentControl> drained = new ArrayList<>(pending);
            pending.clear();
            return drained;
        }

        private static boolean expectsResult(String type) {
            return "prompt.send".equals(type)
                    || "task.stop".equals(type)
                    || "task.continue".equals(type)
                    || "approval.allow".equals(type)
                    || "approval.deny".equals(type)
                    || "session.selectModel".equals(type);
        }
    }

    private static final class SentControl {
        final String type;
        final String sessionId;
        final String requestId;
        final long approvalAttemptId;

        SentControl(String type, String sessionId, String requestId, long approvalAttemptId) {
            this.type = type;
            this.sessionId = sessionId;
            this.requestId = requestId;
            this.approvalAttemptId = approvalAttemptId;
        }
    }

    private static final class SyncTracker {
        private final LinkedHashMap<String, Integer> historyLimits = new LinkedHashMap<>(16, .75f, true);

        synchronized void clear() {
            historyLimits.clear();
        }

        synchronized void record(String type, JSONObject data, String sessionId) {
            if (!"session.history.request".equals(type)) return;
            String id = trim(data == null ? sessionId : data.optString("sessionId", sessionId));
            if (id.isEmpty()) return;
            int limit = clamp(data == null ? 120 : data.optInt("limit", 120), 1, 240);
            historyLimits.put(id, Math.max(limit, historyLimits.containsKey(id)
                    ? historyLimits.get(id) : 0));
            while (historyLimits.size() > 16) {
                Iterator<String> keys = historyLimits.keySet().iterator();
                if (keys.hasNext()) {
                    keys.next();
                    keys.remove();
                }
            }
        }

        synchronized List<String> reconnectHistoryFrames(Set<String> excludedSessionIds) {
            ArrayList<String> frames = new ArrayList<>();
            for (Map.Entry<String, Integer> entry : historyLimits.entrySet()) {
                if (excludedSessionIds != null && excludedSessionIds.contains(entry.getKey())) continue;
                try {
                    JSONObject data = new JSONObject()
                            .put("sessionId", entry.getKey())
                            .put("limit", entry.getValue())
                            .put("refresh", true);
                    frames.add(new JSONObject()
                            .put("type", "session.history.request")
                            .put("data", data)
                            .toString());
                } catch (Throwable ignored) {
                }
            }
            return frames;
        }
    }

    // -----------------------------------------------------------------------------------------
    // Inbound event router: one frame in -> one ordered native frame out; images remain untouched
    // -----------------------------------------------------------------------------------------

    private final class EventRouter {
        private final AssistantTurnNormalizer turnNormalizer = new AssistantTurnNormalizer();

        void resetEndpointState() {
            turnNormalizer.clear();
            IMAGE_MESSAGES.clear();
        }

        void accept(String rawText, long runGeneration, long messageEpoch) {
            synchronized (endpointStateLock) {
                if (!connectionManager.isCurrent(runGeneration)
                        || messageEpoch != MessageHub.currentEpoch()) return;
                acceptLocked(rawText, messageEpoch);
            }
        }

        private void acceptLocked(String rawText, long messageEpoch) {
            final JSONObject message;
            try {
                message = new JSONObject(rawText);
            } catch (Throwable error) {
                emitError("Bridge 帧不是有效 JSON：" + errorLabel(error), messageEpoch);
                return;
            }

            try {
                message.put("source", "native"); // Always override a conflicting Bridge source.
                String type = trim(message.optString("type", "message"));
                if (type.isEmpty()) type = "message";
                message.put("type", type);

                if ("control.result".equals(type)) enrichControlResult(message);
                JSONObject data = normalizeSessionEnvelope(message, type);
                if ("session.snapshot".equals(type)) {
                    SnapshotUpdate update = snapshotStore.accept(data == null ? new JSONObject() : data);
                    message.put("data", update.snapshot);
                    String activeId = snapshotStore.activeSessionId();
                    observeActiveSession(activeId);
                    notifications.onSnapshot(update.snapshot);
                    MessageHub.post(message.toString(), messageEpoch);
                    synthesizeApprovalFromSnapshot(update.snapshot, messageEpoch);
                    return;
                } else {
                    turnNormalizer.normalize(type, message);
                    notifications.onEvent(type, message);
                }

                if ("session.history".equals(type)) IMAGE_MESSAGES.mergeIntoHistory(message);
                if ("approval.required".equals(type)) {
                    String sessionId = eventSessionId(message);
                    String requestId = data == null ? "" : trim(data.optString("requestId",
                            data.optString("id", "")));
                    if (!approvalRegistry.required(sessionId, requestId)) return;
                } else if ("approval.resolved".equals(type)) {
                    String sessionId = eventSessionId(message);
                    String requestId = data == null ? "" : trim(data.optString("requestId",
                            data.optString("id", "")));
                    if (!approvalRegistry.resolved(sessionId, requestId)) return;
                }

                // The frozen app.js ignores images on live user.message and gives its echo a
                // text|0 de-dup key. Convert only image-bearing user frames into an incremental
                // history item (same public protocol), then refresh authoritative history.
                if ("user.message".equals(type)
                        && IMAGE_MESSAGES.routeImageUserMessage(message, messageEpoch)) {
                    heartbeatManager.requestSnapshotSoon();
                    return;
                }

                MessageHub.post(message.toString(), messageEpoch);
                if (!"session.snapshot".equals(type)
                        && !"session.history".equals(type)
                        && !"terminal.output".equals(type)
                        && !"control.result".equals(type)) {
                    heartbeatManager.requestSnapshotSoon();
                }
            } catch (Throwable error) {
                emitError("Bridge 帧处理失败：" + errorLabel(error), messageEpoch);
            }
        }

        private void enrichControlResult(JSONObject message) throws Exception {
            JSONObject data = message.optJSONObject("data");
            if (data == null) {
                data = new JSONObject();
                message.put("data", data);
            }
            String envelopeSession = trim(message.optString("sessionId", ""));
            String dataSession = trim(data.optString("sessionId", ""));
            if (!envelopeSession.isEmpty() && !dataSession.isEmpty()
                    && !envelopeSession.equals(dataSession)) return;
            String resultSession = envelopeSession.isEmpty() ? dataSession : envelopeSession;
            String resultRequest = trim(data.optString("requestId",
                    message.optString("requestId", "")));
            SentControl sent = controlResults.complete(data.optString("type", ""),
                    resultSession, resultRequest);
            if (sent == null) return;
            if (trim(data.optString("type", "")).isEmpty()) data.put("type", sent.type);
            if (trim(data.optString("sessionId", "")).isEmpty()) {
                data.put("sessionId", sent.sessionId);
            }
            if (!sent.requestId.isEmpty()
                    && trim(data.optString("requestId", "")).isEmpty()) {
                data.put("requestId", sent.requestId);
            }
            if (data.optBoolean("ok", true) == false
                    && ("approval.allow".equals(sent.type)
                    || "approval.deny".equals(sent.type))) {
                approvalRegistry.cancelResolution(sent.sessionId, sent.requestId,
                        sent.approvalAttemptId);
            } else if ("approval.allow".equals(sent.type)
                    || "approval.deny".equals(sent.type)) {
                approvalRegistry.acknowledgeResolution(sent.sessionId, sent.requestId,
                        sent.approvalAttemptId);
            }
        }

        private JSONObject normalizeSessionEnvelope(JSONObject message, String type)
                throws Exception {
            JSONObject data = message.optJSONObject("data");
            if ("session.snapshot".equals(type)) return data;
            String envelopeSession = trim(message.optString("sessionId", ""));
            String dataSession = data == null ? "" : trim(data.optString("sessionId", ""));
            if (!envelopeSession.isEmpty() && !dataSession.isEmpty()
                    && !envelopeSession.equals(dataSession)) {
                throw new IOException(type + " 的顶层 sessionId 与 data.sessionId 冲突");
            }
            String sessionId = envelopeSession.isEmpty() ? dataSession : envelopeSession;
            if (sessionId.isEmpty()) return data;
            if (data == null) {
                data = new JSONObject();
                message.put("data", data);
            }
            // Frozen app.js reads data.sessionId for history/context/control results, while
            // generic events use the envelope. Keep both representations identical.
            message.put("sessionId", sessionId);
            data.put("sessionId", sessionId);
            return data;
        }

        private void synthesizeApprovalFromSnapshot(JSONObject snapshot, long messageEpoch) {
            JSONObject session = snapshot.optJSONObject("session");
            String sessionId = session == null ? "" : trim(session.optString("id", ""));
            if (sessionId.isEmpty()) return;
            JSONObject pending = snapshot.optJSONObject("pendingApproval");
            String requestId = pending == null ? "" : trim(pending.optString("requestId",
                    pending.optString("id", "")));
            try {
                if (!requestId.isEmpty()) {
                    if (!approvalRegistry.required(sessionId, requestId)) return;
                    JSONObject copied = parseObject(pending.toString())
                            .put("requestId", requestId)
                            .put("sessionId", sessionId);
                    MessageHub.post(new JSONObject()
                            .put("type", "approval.required")
                            .put("source", "native")
                            .put("sessionId", sessionId)
                            .put("timestamp", System.currentTimeMillis())
                            .put("data", copied)
                            .toString(), messageEpoch);
                } else {
                    String cleared = approvalRegistry.resolveCurrent(sessionId);
                    if (cleared.isEmpty()) return;
                    MessageHub.post(new JSONObject()
                            .put("type", "approval.resolved")
                            .put("source", "native")
                            .put("sessionId", sessionId)
                            .put("timestamp", System.currentTimeMillis())
                            .put("data", new JSONObject()
                                    .put("sessionId", sessionId)
                                    .put("requestId", cleared)
                                    .put("resolved", true))
                            .toString(), messageEpoch);
                }
            } catch (Throwable error) {
                emitError("审批快照同步失败：" + errorLabel(error), messageEpoch);
            }
        }

        private void emitError(String detail, long messageEpoch) {
            try {
                MessageHub.post(new JSONObject()
                        .put("type", "error")
                        .put("source", "native")
                        .put("data", new JSONObject().put("message", detail))
                        .toString(), messageEpoch);
            } catch (Throwable ignored) {
            }
        }
    }

    /**
     * Adapts the frozen front-end's image-user-message limitation without touching app.js.
     * All state is per session and bounded; assistant/image history frames otherwise stay intact.
     */
    private static final class ImageMessageAdapter {
        private static final int MAX_CACHE_ITEMS = 64;
        private static final long MAX_CACHE_CHARS = 8L * 1024L * 1024L;
        private static final long CACHE_TTL_MS = 30L * 60L * 1_000L;
        private final LinkedHashMap<String, CachedImageItem> cached =
                new LinkedHashMap<>(32, .75f, true);
        /** Tiny identity aliases let heavy base64 cache entries be released once confirmed. */
        private final LinkedHashMap<String, String> confirmedAliases =
                new LinkedHashMap<>(32, .75f, true);
        private final LinkedHashMap<String, HistoryMeta> metadata =
                new LinkedHashMap<>(16, .75f, true);
        private final LinkedHashMap<String, Long> lastRefreshAt =
                new LinkedHashMap<>(16, .75f, true);
        private long cachedChars;
        private static WeakReference<RemoteService> owner = new WeakReference<>(null);

        static void attach(RemoteService service) {
            owner = new WeakReference<>(service);
        }

        synchronized void clear() {
            cached.clear();
            confirmedAliases.clear();
            metadata.clear();
            lastRefreshAt.clear();
            cachedChars = 0L;
        }

        boolean routeImageUserMessage(JSONObject message, long messageEpoch) {
            JSONObject data = message.optJSONObject("data");
            if (data == null) return false;
            String sessionId = eventSessionId(message);
            if (sessionId.isEmpty()) return false;
            try {
                JSONArray images = collectInlineImages(data);
                // Never swallow the original user.message unless the frozen front-end can
                // actually render at least one inline image.
                if (images.length() == 0) {
                    return replaceEchoWithCachedImage(data, sessionId, message, messageEpoch);
                }
                long timestamp = positiveLong(message.opt("timestamp"),
                        positiveLong(data.opt("timestamp"), System.currentTimeMillis()));
                long seq = messageSequence(data);
                if (seq == 0L) seq = messageSequence(message);
                String text = extractMessageText(data);
                String explicitId = firstScalarString(data, "messageId", "id");
                String id = explicitId.isEmpty()
                        ? "native-image-user-" + Integer.toHexString((sessionId + "|" + seq + "|"
                        + timestamp + "|" + text).hashCode()) : explicitId;
                JSONObject item = new JSONObject()
                        .put("id", id)
                        .put("kind", "bubble")
                        .put("text", text)
                        .put("images", images)
                        .put("timestamp", timestamp);
                if (seq > 0L) {
                    item.put("seq", seq);
                    item.put("sourceSeq", seq);
                }
                remember(sessionId, id, item);
                MessageHub.post(incrementalHistory(sessionId, item).toString(), messageEpoch);
                requestAuthoritativeHistory(sessionId);
                return true;
            } catch (Throwable error) {
                Log.e(TAG, "Unable to adapt image user.message", error);
                return false;
            }
        }

        /**
         * The frozen topology never sends inline bytes on live user.message: both
         * the phone's own sends and desktop messages exist only as attachment
         * references.  For messages this device just sent, the send-time cache
         * registered by {@link #rememberOutgoing} is the only image source, so a
         * matching text-only echo is replaced by an incremental history item
         * carrying the cached images instead of a duplicate text bubble.
         */
        private boolean replaceEchoWithCachedImage(JSONObject data, String sessionId,
                                                   JSONObject message, long messageEpoch) {
            JSONObject item;
            synchronized (this) {
                try {
                    String text = extractMessageText(data);
                    if (text.isEmpty()) return false;
                    long timestamp = positiveLong(message.opt("timestamp"),
                            positiveLong(data.opt("timestamp"), 0L));
                    long seq = messageSequence(data);
                    if (seq == 0L) seq = messageSequence(message);
                    JSONObject probe = new JSONObject()
                            .put("kind", "bubble")
                            .put("text", text)
                            .put("timestamp", timestamp);
                    CachedImageItem match = findMatch(sessionId, probe);
                    if (match == null) return false;
                    item = parseObject(match.itemJson);
                    if (seq > 0L) {
                        item.put("seq", seq);
                        item.put("sourceSeq", seq);
                    }
                    if (timestamp > 0L) item.put("timestamp", timestamp);
                    remember(sessionId, match.id, item);
                } catch (Throwable error) {
                    Log.w(TAG, "Unable to replace image echo with cached history: " + errorLabel(error));
                    return false;
                }
            }
            try {
                MessageHub.post(incrementalHistory(sessionId, item).toString(), messageEpoch);
                requestAuthoritativeHistory(sessionId);
                return true;
            } catch (Throwable error) {
                Log.w(TAG, "Unable to post cached image history: " + errorLabel(error));
                return false;
            }
        }

        /**
         * Registers images this device just sent (name/mediaType/data attachments)
         * so the later text-only live echo and authoritative history can be
         * replaced by the real bytes.  Bounded and TTL-limited by the same cache.
         */
        synchronized void rememberOutgoing(String sessionId, String text, JSONArray attachments) {
            if (attachments == null || trim(sessionId).isEmpty()) return;
            try {
                JSONArray images = new JSONArray();
                LinkedHashSet<String> seen = new LinkedHashSet<>();
                for (int index = 0; index < attachments.length(); index++) {
                    JSONObject attachment = attachments.optJSONObject(index);
                    if (attachment == null) continue;
                    String media = firstScalarString(attachment, "mediaType", "mimeType");
                    if (media.isEmpty() || !media.toLowerCase(Locale.ROOT).startsWith("image/")) {
                        media = "image/jpeg";
                    }
                    String data = trim(attachment.optString("data", ""));
                    if (data.isEmpty()) {
                        String dataUrl = canonicalDataUrl(attachment.optString("dataUrl", ""));
                        int comma = dataUrl.indexOf(',');
                        if (comma < 0) continue;
                        String header = dataUrl.substring(0, comma);
                        data = dataUrl.substring(comma + 1);
                        int semicolon = header.indexOf(';');
                        String mime = semicolon > 5 ? header.substring(5, semicolon) : "";
                        if (!mime.isEmpty() && mime.toLowerCase(Locale.ROOT).startsWith("image/")) {
                            media = mime;
                        }
                    }
                    String dataUrl = "data:" + media + ";base64," + data;
                    if (data.isEmpty() || !isInlineImageDataUrl(dataUrl)) continue;
                    if (!seen.add(dataUrl)) continue;
                    images.put(new JSONObject().put("dataUrl", dataUrl));
                }
                if (images.length() == 0) return;
                long now = System.currentTimeMillis();
                String id = "native-image-user-" + Integer.toHexString(
                        (sessionId + "|0|" + now + "|" + text).hashCode());
                JSONObject item = new JSONObject()
                        .put("id", id)
                        .put("kind", "bubble")
                        .put("text", safe(text, ""))
                        .put("images", images)
                        .put("timestamp", now);
                remember(sessionId, id, item);
            } catch (Throwable error) {
                Log.w(TAG, "Unable to register outgoing images: " + errorLabel(error));
            }
        }

        synchronized void mergeIntoHistory(JSONObject message) {
            JSONObject data = message.optJSONObject("data");
            if (data == null) return;
            String sessionId = trim(data.optString("sessionId", eventSessionId(message)));
            if (sessionId.isEmpty()) return;
            metadata.put(sessionId, new HistoryMeta(data.optBoolean("hasMore", false),
                    data.has("nextBefore") && !data.isNull("nextBefore")
                            ? data.optLong("nextBefore") : null));
            trimMap(metadata, 24);
            JSONArray incoming = data.optJSONArray("items");
            if (incoming == null) return;
            try {
                pruneCache(System.currentTimeMillis());
                JSONArray merged = new JSONArray();
                for (int index = 0; index < incoming.length(); index++) {
                    JSONObject original = incoming.optJSONObject(index);
                    if (original == null) {
                        merged.put(incoming.opt(index));
                        continue;
                    }

                    String authoritativeKey = authoritativeKey(sessionId, original);
                    String aliasedId = authoritativeKey.isEmpty()
                            ? "" : safe(confirmedAliases.get(authoritativeKey), "");
                    JSONArray normalized = collectInlineImages(original);
                    CachedImageItem match = findMatch(sessionId, original);
                    if (match != null && !authoritativeKey.isEmpty()) {
                        // Record the stable identity on the first authoritative match, even when
                        // that Bridge item still lacks inline bytes. This prevents a later cache
                        // TTL/pressure eviction from creating a second text-only bubble ID.
                        confirmedAliases.put(authoritativeKey, match.id);
                        trimMap(confirmedAliases, 512);
                    }
                    if (match != null && normalized.length() == 0) {
                        // The deployed Bridge can echo a live user item without hydrating its
                        // attachment. Substitute only the matching bounded cache entry, in place;
                        // never append every cached item to unrelated/older history pages.
                        JSONObject cachedItem = parseObject(match.itemJson);
                        long seq = messageSequence(original);
                        long timestamp = positiveLong(original.opt("timestamp"), 0L);
                        if (seq > 0L) cachedItem.put("seq", seq);
                        if (timestamp > 0L) cachedItem.put("timestamp", timestamp);
                        merged.put(cachedItem);
                        continue;
                    }

                    if (normalized.length() > 0) original.put("images", normalized);
                    else original.remove("images");
                    if (match != null) {
                        // Authoritative history now contains renderable inline data. Preserve the
                        // synthetic identity for front-end de-dup, retain only a tiny alias, and
                        // release the heavy base64 cache immediately.
                        if (!authoritativeKey.isEmpty()) {
                            confirmedAliases.put(authoritativeKey, match.id);
                            trimMap(confirmedAliases, 512);
                        }
                        original.put("id", match.id);
                        removeCached(match);
                    } else if (!aliasedId.isEmpty()) {
                        original.put("id", aliasedId);
                    }
                    merged.put(original);
                }
                data.put("items", merged);
            } catch (Throwable error) {
                Log.w(TAG, "Unable to merge cached image history: " + errorLabel(error));
            }
        }

        private synchronized void remember(String sessionId, String id, JSONObject item) {
            String key = sessionId + "\u0000" + id;
            String frozen = item.toString();
            CachedImageItem previous = cached.remove(key);
            if (previous != null) cachedChars -= previous.charCount;
            CachedImageItem entry = new CachedImageItem(key, sessionId, id, frozen,
                    frozen.length(), System.currentTimeMillis(),
                    messageSequence(item),
                    positiveLong(item.opt("timestamp"), 0L), extractMessageText(item));
            if (entry.charCount <= MAX_CACHE_CHARS) {
                cached.put(key, entry);
                cachedChars += entry.charCount;
            }
            pruneCache(entry.createdAt);
        }

        private synchronized JSONObject incrementalHistory(String sessionId, JSONObject item)
                throws Exception {
            HistoryMeta meta = metadata.get(sessionId);
            JSONObject data = new JSONObject()
                    .put("sessionId", sessionId)
                    .put("items", new JSONArray().put(parseObject(item.toString())))
                    .put("hasMore", meta == null || meta.hasMore);
            if (meta != null && meta.nextBefore != null) data.put("nextBefore", meta.nextBefore);
            else data.put("nextBefore", JSONObject.NULL);
            return new JSONObject()
                    .put("type", "session.history")
                    .put("source", "native")
                    .put("data", data);
        }

        private void requestAuthoritativeHistory(String sessionId) {
            long now = System.currentTimeMillis();
            synchronized (this) {
                Long previous = lastRefreshAt.get(sessionId);
                if (previous != null && now - previous < 750L) return;
                lastRefreshAt.put(sessionId, now);
                trimMap(lastRefreshAt, 24);
            }
            RemoteService service = owner.get();
            if (service == null || service.controlSender == null) return;
            try {
                service.controlSender.enqueue("session.history.request", new JSONObject()
                        .put("sessionId", sessionId)
                        .put("limit", 120)
                        .put("refresh", true), sessionId);
            } catch (Throwable error) {
                Log.w(TAG, "Image history refresh failed: " + errorLabel(error));
            }
        }

        private CachedImageItem findMatch(String sessionId, JSONObject original) {
            if (!isUserHistoryItem(original)) return null;
            String originalId = trim(original.optString("id", ""));
            long originalSeq = messageSequence(original);
            String originalText = extractMessageText(original);
            CachedImageItem textCandidate = null;
            int textCandidates = 0;
            for (CachedImageItem entry : cached.values()) {
                if (!sessionId.equals(entry.sessionId)) continue;
                if (!originalId.isEmpty() && originalId.equals(entry.id)) {
                    return entry;
                }
                if (originalSeq > 0L && originalSeq == entry.seq) return entry;
                if (!originalText.isEmpty() && originalText.equals(entry.text)) {
                    long left = positiveLong(original.opt("timestamp"), 0L);
                    long right = entry.timestamp;
                    if (left > 0L && right > 0L && Math.abs(left - right) < 5_000L) {
                        textCandidate = entry;
                        textCandidates++;
                    }
                }
            }
            // Repeated identical prompts inside the fallback window are ambiguous; never attach
            // an image to a guessed message. Real Bridge sourceSeq is the primary match above.
            return textCandidates == 1 ? textCandidate : null;
        }

        private boolean isUserHistoryItem(JSONObject item) {
            String kind = trim(item.optString("kind", "")).toLowerCase(Locale.ROOT);
            String role = trim(item.optString("role", "")).toLowerCase(Locale.ROOT);
            String type = trim(item.optString("type", item.optString("eventType", "")))
                    .toLowerCase(Locale.ROOT);
            return "bubble".equals(kind) || "user".equals(role)
                    || "user.message".equals(type) || "user/message".equals(type);
        }

        private long messageSequence(JSONObject item) {
            if (item == null) return 0L;
            long source = positiveLong(item.opt("sourceSeq"), 0L);
            if (source > 0L) return source;
            JSONObject data = item.optJSONObject("data");
            if (data != null) {
                source = positiveLong(data.opt("sourceSeq"), 0L);
                if (source > 0L) return source;
            }
            source = positiveLong(item.opt("seq"), 0L);
            if (source > 0L) return source;
            return data == null ? 0L : positiveLong(data.opt("seq"), 0L);
        }

        private JSONArray collectInlineImages(JSONObject container) throws Exception {
            JSONArray result = new JSONArray();
            LinkedHashSet<String> seen = new LinkedHashSet<>();
            collectImageValue(container.opt("images"), result, seen, 0);
            collectImageValue(container.opt("content"), result, seen, 0);
            Object nestedMessage = container.opt("message");
            if (nestedMessage instanceof JSONObject || nestedMessage instanceof JSONArray) {
                collectImageValue(nestedMessage, result, seen, 0);
            }
            return result;
        }

        private void collectImageValue(Object value, JSONArray result, Set<String> seen,
                                       int depth) throws Exception {
            if (value == null || value == JSONObject.NULL || depth > 5) return;
            if (value instanceof JSONArray) {
                JSONArray array = (JSONArray) value;
                for (int index = 0; index < array.length(); index++) {
                    collectImageValue(array.opt(index), result, seen, depth + 1);
                }
                return;
            }
            if (value instanceof String) {
                String dataUrl = trim((String) value);
                dataUrl = canonicalDataUrl(dataUrl);
                if (isInlineImageDataUrl(dataUrl) && seen.add(dataUrl)) {
                    result.put(new JSONObject().put("dataUrl", dataUrl));
                }
                return;
            }
            if (!(value instanceof JSONObject)) return;
            JSONObject image = (JSONObject) value;
            String dataUrl = canonicalDataUrl(inlineDataUrl(image));
            if (isInlineImageDataUrl(dataUrl) && seen.add(dataUrl)) {
                JSONObject normalized = new JSONObject().put("dataUrl", dataUrl);
                String name = firstScalarString(image, "name", "fileName", "filename");
                String mime = firstScalarString(image, "mediaType", "mimeType", "media_type");
                if (!name.isEmpty()) normalized.put("name", name);
                if (!mime.isEmpty()) {
                    normalized.put("mediaType", mime);
                    normalized.put("mimeType", mime);
                }
                result.put(normalized);
                return;
            }
            collectImageValue(image.opt("images"), result, seen, depth + 1);
            collectImageValue(image.opt("content"), result, seen, depth + 1);
            collectImageValue(image.opt("parts"), result, seen, depth + 1);
            collectImageValue(image.opt("image"), result, seen, depth + 1);
            collectImageValue(image.opt("image_url"), result, seen, depth + 1);
            collectImageValue(image.opt("source"), result, seen, depth + 1);
        }

        private String canonicalDataUrl(String value) {
            return trim(value).replace("\r", "").replace("\n", "");
        }

        private String inlineDataUrl(JSONObject image) {
            String direct = firstScalarString(image, "dataUrl", "src", "url");
            if (isInlineImageDataUrl(direct)) return direct;
            Object imageUrl = image.opt("image_url");
            if (imageUrl instanceof String && isInlineImageDataUrl((String) imageUrl)) {
                return trim((String) imageUrl);
            }
            if (imageUrl instanceof JSONObject) {
                String nested = firstScalarString((JSONObject) imageUrl, "url", "dataUrl");
                if (isInlineImageDataUrl(nested)) return nested;
            }
            JSONObject source = image.optJSONObject("source");
            String encoded = firstScalarString(image, "data", "base64");
            String mime = firstScalarString(image, "mediaType", "mimeType", "media_type");
            if (source != null) {
                if (encoded.isEmpty()) encoded = firstScalarString(source, "data", "base64");
                if (mime.isEmpty()) {
                    mime = firstScalarString(source, "mediaType", "mimeType", "media_type");
                }
            }
            if (isInlineImageDataUrl(encoded)) return encoded;
            if (!encoded.isEmpty() && mime.toLowerCase(Locale.ROOT).startsWith("image/")) {
                String candidate = "data:" + mime + ";base64," + encoded;
                if (isInlineImageDataUrl(candidate)) return candidate;
            }
            return "";
        }

        private boolean isInlineImageDataUrl(String value) {
            String dataUrl = trim(value);
            int comma = dataUrl.indexOf(',');
            if (comma <= 0 || comma == dataUrl.length() - 1) return false;
            String header = dataUrl.substring(0, comma).toLowerCase(Locale.ROOT);
            if (!header.startsWith("data:image/") || !header.contains(";base64")) return false;
            for (int index = comma + 1; index < dataUrl.length(); index++) {
                char character = dataUrl.charAt(index);
                boolean valid = (character >= 'A' && character <= 'Z')
                        || (character >= 'a' && character <= 'z')
                        || (character >= '0' && character <= '9')
                        || character == '+' || character == '/' || character == '='
                        || character == '\r' || character == '\n';
                if (!valid) return false;
            }
            return true;
        }

        private String extractMessageText(JSONObject container) {
            String summary = firstScalarString(container, "text", "prompt");
            if (!summary.isEmpty()) return summary;
            List<String> pieces = new ArrayList<>();
            collectTextValue(container.opt("content"), pieces, 0);
            Object message = container.opt("message");
            if (pieces.isEmpty()) {
                if (message instanceof String) addText(pieces, (String) message);
                else collectTextValue(message, pieces, 0);
            }
            StringBuilder joined = new StringBuilder();
            for (String piece : pieces) {
                joined.append(piece);
            }
            return joined.toString();
        }

        private void collectTextValue(Object value, List<String> pieces, int depth) {
            if (value == null || value == JSONObject.NULL || depth > 5) return;
            if (value instanceof String) {
                if (!isInlineImageDataUrl((String) value)) addText(pieces, (String) value);
                return;
            }
            if (value instanceof JSONArray) {
                JSONArray array = (JSONArray) value;
                for (int index = 0; index < array.length(); index++) {
                    collectTextValue(array.opt(index), pieces, depth + 1);
                }
                return;
            }
            if (!(value instanceof JSONObject)) return;
            JSONObject part = (JSONObject) value;
            String summary = firstScalarString(part, "text", "prompt");
            if (!summary.isEmpty()) {
                addText(pieces, summary);
                return;
            }
            collectTextValue(part.opt("content"), pieces, depth + 1);
            collectTextValue(part.opt("parts"), pieces, depth + 1);
        }

        private void addText(List<String> pieces, String value) {
            String text = trim(value);
            if (!text.isEmpty()) pieces.add(text);
        }

        private String firstScalarString(JSONObject object, String... keys) {
            if (object == null) return "";
            for (String key : keys) {
                Object value = object.opt(key);
                if (value instanceof String) {
                    String text = trim((String) value);
                    if (!text.isEmpty()) return text;
                }
            }
            return "";
        }

        private String authoritativeKey(String sessionId, JSONObject item) {
            String id = firstScalarString(item, "id", "messageId");
            if (!id.isEmpty()) return sessionId + "|id|" + id;
            long seq = messageSequence(item);
            if (seq > 0L) return sessionId + "|seq|" + seq;
            long timestamp = positiveLong(item.opt("timestamp"), 0L);
            String text = extractMessageText(item);
            return timestamp > 0L || !text.isEmpty()
                    ? sessionId + "|fallback|" + timestamp + "|" + text.hashCode() : "";
        }

        private void pruneCache(long now) {
            Iterator<Map.Entry<String, CachedImageItem>> iterator = cached.entrySet().iterator();
            while (iterator.hasNext()) {
                CachedImageItem entry = iterator.next().getValue();
                if (now - entry.createdAt <= CACHE_TTL_MS) continue;
                cachedChars -= entry.charCount;
                iterator.remove();
            }
            iterator = cached.entrySet().iterator();
            while ((cached.size() > MAX_CACHE_ITEMS || cachedChars > MAX_CACHE_CHARS)
                    && iterator.hasNext()) {
                CachedImageItem entry = iterator.next().getValue();
                cachedChars -= entry.charCount;
                iterator.remove();
            }
            if (cachedChars < 0L) cachedChars = 0L;
        }

        private void removeCached(CachedImageItem entry) {
            CachedImageItem removed = cached.remove(entry.key);
            if (removed != null) cachedChars = Math.max(0L, cachedChars - removed.charCount);
        }

        private final class CachedImageItem {
            final String key;
            final String sessionId;
            final String id;
            final String itemJson;
            final long charCount;
            final long createdAt;
            final long seq;
            final long timestamp;
            final String text;

            CachedImageItem(String key, String sessionId, String id, String itemJson,
                            long charCount, long createdAt, long seq, long timestamp, String text) {
                this.key = key;
                this.sessionId = sessionId;
                this.id = id;
                this.itemJson = itemJson;
                this.charCount = charCount;
                this.createdAt = createdAt;
                this.seq = seq;
                this.timestamp = timestamp;
                this.text = text;
            }
        }
    }

    private static final class HistoryMeta {
        final boolean hasMore;
        final Long nextBefore;

        HistoryMeta(boolean hasMore, Long nextBefore) {
            this.hasMore = hasMore;
            this.nextBefore = nextBefore;
        }
    }

    /** Tracks current/resolved approvals per session so stale front-end buttons are harmless. */
    private static final class ApprovalRegistry {
        private final LinkedHashMap<String, String> current = new LinkedHashMap<>(16, .75f, true);
        private final LinkedHashMap<String, Boolean> resolved = new LinkedHashMap<>(32, .75f, true);
        private final LinkedHashMap<String, ApprovalAttempt> resolving =
                new LinkedHashMap<>(16, .75f, true);
        private long attemptSequence;

        synchronized boolean required(String sessionId, String requestId) {
            String session = trim(sessionId);
            String request = trim(requestId);
            if (session.isEmpty() || request.isEmpty()) return false;
            String requestKey = key(session, request);
            // A late/stale required event must not resurrect an already resolved request.
            if (resolved.containsKey(requestKey)) return false;
            String previous = current.put(session, request);
            if (previous != null && !request.equals(previous)) {
                resolving.remove(key(session, previous));
            }
            trimMap(current, MAX_TRACKED_SESSIONS);
            return !request.equals(previous);
        }

        synchronized boolean resolved(String sessionId, String requestId) {
            String session = trim(sessionId);
            String request = trim(requestId);
            if (session.isEmpty()) return false;
            if (request.isEmpty()) request = trim(current.get(session));
            if (request.isEmpty()) return false;
            String key = key(session, request);
            if (request.equals(trim(current.get(session)))) current.remove(session);
            resolving.remove(key);
            boolean fresh = !resolved.containsKey(key);
            resolved.put(key, Boolean.TRUE);
            trimMap(resolved, 128);
            return fresh;
        }

        synchronized String resolveCurrent(String sessionId) {
            String session = trim(sessionId);
            String request = trim(current.get(session));
            if (!request.isEmpty()) resolved(session, request);
            return request;
        }

        synchronized boolean isResolved(String sessionId, String requestId) {
            return resolved.containsKey(key(trim(sessionId), trim(requestId)));
        }

        synchronized long beginResolution(String sessionId, String requestId, String decision) {
            String session = trim(sessionId);
            String request = trim(requestId);
            String normalizedDecision = trim(decision);
            if (session.isEmpty() || request.isEmpty() || normalizedDecision.isEmpty()) return 0L;
            String requestKey = key(session, request);
            if (resolved.containsKey(requestKey)) return 0L;
            String currentRequest = trim(current.get(session));
            // After a process restart the registry has no knowledge of this
            // session's pending approval.  DSH re-validates requestId against
            // its own pending set, so exactly one attempt is allowed instead
            // of dead-ending the notification action.
            if (!currentRequest.isEmpty() && !request.equals(currentRequest)) return 0L;
            long now = SystemClock.elapsedRealtime();
            ApprovalAttempt attempt = resolving.get(requestKey);
            if (attempt != null) {
                // Never allow the opposite decision for one request. The same decision may be
                // retried only after it was actually written and no Bridge reply arrived.
                if (!normalizedDecision.equals(attempt.decision) || attempt.queued
                        || attempt.sending
                        || attempt.acknowledged
                        || attempt.outstanding.size() >= 4
                        || now - attempt.sentAt < APPROVAL_RETRY_LOCK_MS) return 0L;
                attempt.queued = true;
                attempt.sentAt = 0L;
                attempt.generation = ++attemptSequence;
                return attempt.generation;
            }
            ApprovalAttempt created = new ApprovalAttempt(normalizedDecision, ++attemptSequence);
            resolving.put(requestKey, created);
            trimMap(resolving, 128);
            return created.generation;
        }

        synchronized void markResolutionSent(String sessionId, String requestId, String decision,
                                              long generation) {
            ApprovalAttempt attempt = resolving.get(key(trim(sessionId), trim(requestId)));
            if (attempt == null || attempt.generation != generation
                    || !attempt.decision.equals(trim(decision))) return;
            attempt.sending = false;
            attempt.queued = false;
            attempt.sentAt = SystemClock.elapsedRealtime();
            if (!attempt.acknowledged) attempt.outstanding.add(generation);
        }

        /** Linearization point immediately before ControlSender writes an approval frame. */
        synchronized boolean claimForSend(String sessionId, String requestId, String decision,
                                          long generation) {
            String session = trim(sessionId);
            String request = trim(requestId);
            String currentRequest = trim(current.get(session));
            ApprovalAttempt attempt = resolving.get(key(session, request));
            if (attempt == null || attempt.generation != generation
                    || !attempt.decision.equals(trim(decision)) || !attempt.queued
                    || attempt.sending || attempt.acknowledged
                    || (!currentRequest.isEmpty() && !request.equals(currentRequest))
                    || resolved.containsKey(key(session, request))) return false;
            attempt.sending = true;
            return true;
        }

        synchronized void markResolutionSendFailed(String sessionId, String requestId,
                                                   String decision, long generation) {
            ApprovalAttempt attempt = resolving.get(key(trim(sessionId), trim(requestId)));
            if (attempt == null || attempt.generation != generation
                    || !attempt.decision.equals(trim(decision))) return;
            attempt.sending = false;
            attempt.queued = true;
            attempt.sentAt = 0L;
        }

        synchronized void cancelResolution(String sessionId, String requestId, long generation) {
            String requestKey = key(trim(sessionId), trim(requestId));
            ApprovalAttempt attempt = resolving.get(requestKey);
            if (attempt == null) return;
            boolean known = attempt.outstanding.remove(generation);
            if (attempt.generation == generation) {
                known = true;
                attempt.queued = false;
                attempt.sending = false;
            }
            if (known && !attempt.acknowledged && !attempt.queued && !attempt.sending
                    && attempt.outstanding.isEmpty()) resolving.remove(requestKey);
        }

        synchronized boolean acknowledgeResolution(String sessionId, String requestId,
                                                    long generation) {
            String requestKey = key(trim(sessionId), trim(requestId));
            ApprovalAttempt attempt = resolving.get(requestKey);
            if (attempt == null || (attempt.generation != generation
                    && !attempt.outstanding.contains(generation))) return false;
            attempt.queued = false;
            attempt.sending = false;
            attempt.acknowledged = true;
            attempt.outstanding.clear();
            attempt.sentAt = SystemClock.elapsedRealtime();
            return true;
        }

        synchronized boolean isCurrent(String sessionId, String requestId) {
            String session = trim(sessionId);
            String request = trim(requestId);
            return !session.isEmpty() && !request.isEmpty()
                    && request.equals(trim(current.get(session)))
                    && !resolved.containsKey(key(session, request));
        }

        synchronized void clear() {
            current.clear();
            resolved.clear();
            resolving.clear();
        }

        private static String key(String sessionId, String requestId) {
            return sessionId + "|" + requestId;
        }

        private static final class ApprovalAttempt {
            final String decision;
            long generation;
            boolean queued = true;
            boolean sending;
            boolean acknowledged;
            long sentAt;
            final LinkedHashSet<Long> outstanding = new LinkedHashSet<>();

            ApprovalAttempt(String decision, long generation) {
                this.decision = decision;
                this.generation = generation;
            }
        }
    }

    /** Supplies a per-session reply id only when Bridge omitted all stable reply identifiers. */
    private static final class AssistantTurnNormalizer {
        private final LinkedHashMap<String, TurnState> sessions = new LinkedHashMap<>(16, .75f, true);

        synchronized void clear() {
            sessions.clear();
        }

        synchronized void normalize(String type, JSONObject message) throws Exception {
            String sessionId = eventSessionId(message);
            if (sessionId.isEmpty()) return;
            TurnState state = sessions.get(sessionId);
            if (state == null) {
                state = new TurnState();
                sessions.put(sessionId, state);
                trimMap(sessions, MAX_TRACKED_SESSIONS);
            }

            if ("session.started".equals(type) || "user.message".equals(type)) {
                if (!state.turnPrepared) state.counter++;
                state.turnPrepared = true;
                state.replyId = "";
            } else if ("assistant.message".equals(type)) {
                JSONObject data = message.optJSONObject("data");
                if (data == null) {
                    data = new JSONObject();
                    message.put("data", data);
                }
                String existing = firstNonEmpty(data, "messageId", "replyId", "id");
                if (!existing.isEmpty()) {
                    if (!state.replyId.startsWith("native-")) state.replyId = existing;
                    else data.put("messageId", state.replyId);
                    state.turnPrepared = false;
                } else {
                    if (state.replyId.isEmpty()) {
                        if (!state.turnPrepared) state.counter++;
                        if (state.counter == 0L) state.counter = 1L;
                        state.replyId = "native-" + Integer.toHexString(sessionId.hashCode())
                                + "-" + state.counter;
                    }
                    data.put("messageId", state.replyId);
                    state.turnPrepared = false;
                }
            } else if ("session.completed".equals(type) || "session.failed".equals(type)) {
                state.replyId = "";
                state.turnPrepared = false;
            }
        }
    }

    private static final class TurnState {
        long counter;
        String replyId = "";
        boolean turnPrepared;
    }

    // -----------------------------------------------------------------------------------------
    // Snapshot/config stores: complete snapshots, provider:null hardening, session->project map
    // -----------------------------------------------------------------------------------------

    private static final class SnapshotStore {
        private final SharedPreferences preferences;
        private JSONObject current;
        private String serialized;
        private final LinkedHashMap<String, String> sessionProjects = new LinkedHashMap<>(16, .75f, true);

        SnapshotStore(SharedPreferences preferences) {
            this.preferences = preferences;
            current = sanitizeSnapshot(parseObject(preferences.getString(KEY_SNAPSHOT, "{}")));
            serialized = current.toString();
            rebuildIndex(current);
        }

        synchronized SnapshotUpdate accept(JSONObject incoming) {
            JSONObject merged = parseObject(current.toString());
            Iterator<String> keys = incoming.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                try {
                    merged.put(key, incoming.opt(key));
                } catch (Throwable ignored) {
                }
            }
            merged = sanitizeSnapshot(merged);
            String next = merged.toString();
            boolean changed = !next.equals(serialized);
            current = merged;
            serialized = next;
            rebuildIndex(current);
            if (changed) preferences.edit().putString(KEY_SNAPSHOT, next).apply();
            return new SnapshotUpdate(parseObject(next), changed);
        }

        synchronized JSONObject copy() {
            return parseObject(serialized);
        }

        synchronized void resetForOwner(String ownerFingerprint) {
            current = sanitizeSnapshot(new JSONObject());
            serialized = current.toString();
            sessionProjects.clear();
            preferences.edit()
                    .putString(KEY_SNAPSHOT, serialized)
                    .putString(KEY_SNAPSHOT_OWNER, safe(ownerFingerprint, ""))
                    .apply();
        }

        synchronized boolean ownerMatches(String ownerFingerprint) {
            String owner = trim(preferences.getString(KEY_SNAPSHOT_OWNER, ""));
            return !owner.isEmpty() && owner.equals(safe(ownerFingerprint, ""));
        }

        synchronized String activeSessionId() {
            JSONObject session = current.optJSONObject("session");
            return session == null ? "" : trim(session.optString("id", ""));
        }

        synchronized String projectIdForSession(String sessionId) {
            String id = trim(sessionId);
            String mapped = sessionProjects.get(id);
            if (!TextUtils.isEmpty(mapped)) return mapped;
            if (!id.isEmpty() && !id.equals(activeSessionId())) return "";
            JSONObject project = current.optJSONObject("project");
            return project == null ? "" : trim(project.optString("id", ""));
        }

        private void rebuildIndex(JSONObject snapshot) {
            JSONObject session = snapshot.optJSONObject("session");
            JSONObject project = snapshot.optJSONObject("project");
            if (session != null && project != null) {
                putIndex(session.optString("id", ""), project.optString("id", ""));
            }
            JSONArray recent = snapshot.optJSONArray("recent");
            if (recent != null) {
                for (int index = 0; index < recent.length(); index++) {
                    JSONObject item = recent.optJSONObject(index);
                    if (item != null) putIndex(item.optString("id", ""), item.optString("projectId", ""));
                }
            }
        }

        private void putIndex(String sessionId, String projectId) {
            String session = trim(sessionId);
            String project = trim(projectId);
            if (session.isEmpty() || project.isEmpty()) return;
            sessionProjects.put(session, project);
            trimMap(sessionProjects, MAX_TRACKED_SESSIONS);
        }
    }

    private static final class SnapshotUpdate {
        final JSONObject snapshot;
        final boolean changed;

        SnapshotUpdate(JSONObject snapshot, boolean changed) {
            this.snapshot = snapshot;
            this.changed = changed;
        }
    }

    private static JSONObject sanitizeSnapshot(JSONObject source) {
        JSONObject result = parseObject(source == null ? "{}" : source.toString());
        try {
            if (!result.has("provider") || result.isNull("provider")) {
                result.put("provider", new JSONObject());
            } else {
                Object provider = result.opt("provider");
                if (!(provider instanceof JSONObject) && !(provider instanceof String)) {
                    result.put("provider", new JSONObject());
                }
            }
        } catch (Throwable ignored) {
        }
        return result;
    }

    private static final class SettingsValue {
        final String endpoint;
        final String token;

        SettingsValue(String endpoint, String token) {
            this.endpoint = endpoint;
            this.token = token;
        }

        String websocketUrl() {
            return appendToken(endpoint, token);
        }

        String ownerFingerprint() {
            // A router owner is the authenticated Bridge, not its current DHCP address.
            // Keeping the token stable lets LAN auto-discovery repair an IP change without
            // wiping the session/history cache that belongs to the same Bridge.
            String identity = trim(token);
            return sha256Hex(identity.isEmpty() ? endpoint : "bridge\u0000" + identity);
        }

        JSONObject toJson() {
            try {
                return new JSONObject().put("endpoint", endpoint).put("token", token);
            } catch (Throwable ignored) {
                return new JSONObject();
            }
        }
    }

    private static final class ConfigStore {
        private final SharedPreferences preferences;

        ConfigStore(Context context) {
            preferences = context.getSharedPreferences(PREFS, MODE_PRIVATE);
        }

        synchronized SettingsValue current() {
            String endpoint = trim(preferences.getString(KEY_ENDPOINT, ""));
            String token = trim(preferences.getString(KEY_TOKEN, ""));
            if (endpoint.isEmpty()) endpoint = BUILTIN_ENDPOINT;
            try {
                String embedded = tokenFromEndpoint(endpoint);
                endpoint = normalizeEndpoint(endpoint);
                if (token.isEmpty()) token = embedded;
            } catch (Throwable error) {
                endpoint = BUILTIN_ENDPOINT;
                token = "";
            }
            if (token.isEmpty() && endpoint.equals(BUILTIN_ENDPOINT)) token = BUILTIN_TOKEN;
            return new SettingsValue(endpoint, token);
        }

        synchronized boolean isExplicitlyOffline() {
            return preferences.getBoolean(KEY_EXPLICITLY_OFFLINE, false);
        }

        synchronized void setExplicitlyOffline(boolean offline) {
            preferences.edit().putBoolean(KEY_EXPLICITLY_OFFLINE, offline).apply();
        }

        synchronized SettingsValue adoptDiscoveredEndpoint(String websocketUrl) {
            SettingsValue saved = current();
            String endpoint = normalizeEndpoint(websocketUrl);
            String token = tokenFromEndpoint(websocketUrl);
            if (token.isEmpty()) token = saved.token;
            preferences.edit().putString(KEY_ENDPOINT, endpoint)
                    .putString(KEY_TOKEN, token)
                    .apply();
            return new SettingsValue(endpoint, token);
        }

        synchronized SettingsValue resolve(String requestedEndpoint, String requestedToken,
                                           boolean preserveSavedForBuiltin) {
            SettingsValue saved = current();
            String rawEndpoint = trim(requestedEndpoint);
            String rawToken = trim(requestedToken);
            if (rawEndpoint.isEmpty()) return saved;

            String embeddedToken = tokenFromEndpoint(rawEndpoint);
            String endpoint = normalizeEndpoint(rawEndpoint);
            boolean hardCodedAutoConnect = preserveSavedForBuiltin
                    && endpoint.equals(BUILTIN_ENDPOINT)
                    && (rawToken.isEmpty() || BUILTIN_TOKEN.equals(rawToken));
            boolean hasSavedCustom = preferences.contains(KEY_ENDPOINT)
                    && (!saved.endpoint.equals(BUILTIN_ENDPOINT)
                    || !saved.token.equals(BUILTIN_TOKEN));
            if (hardCodedAutoConnect && hasSavedCustom) return saved;

            String token = rawToken.isEmpty() ? embeddedToken : rawToken;
            if (token.isEmpty() && endpoint.equals(saved.endpoint)) token = saved.token;
            if (token.isEmpty() && endpoint.equals(BUILTIN_ENDPOINT)) token = BUILTIN_TOKEN;
            preferences.edit().putString(KEY_ENDPOINT, endpoint).putString(KEY_TOKEN, token).apply();
            return new SettingsValue(endpoint, token);
        }
    }

    // -----------------------------------------------------------------------------------------
    // Notification controller: per-session state and session-frozen approval/stop actions
    // -----------------------------------------------------------------------------------------

    private final class NotificationController {
        private final Handler handler = new Handler(Looper.getMainLooper());
        private final NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        private final LinkedHashMap<String, NoticeState> sessionStates = new LinkedHashMap<>(16, .75f, true);
        private NoticeDescriptor pending;
        private boolean publishScheduled;
        private String lastFingerprint = "";
        private long lastPublishedAt;
        private String activeSessionId = "";

        void createChannel() {
            if (manager == null) return;
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID, "DSH 手机远程", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("显示 DSH 连接、运行状态和审批操作");
            channel.setSound(null, null);
            channel.enableVibration(false);
            channel.setShowBadge(false);
            manager.createNotificationChannel(channel);
        }

        void resetEndpointState() {
            handler.removeCallbacksAndMessages(null);
            synchronized (this) {
                pending = null;
                publishScheduled = false;
                lastFingerprint = "";
                lastPublishedAt = 0L;
                activeSessionId = "";
                sessionStates.clear();
            }
        }

        Notification connectingNotification() {
            NoticeDescriptor descriptor = new NoticeDescriptor(
                    "", "", "", "DSH Remote", "正在连接 Bridge", "connecting",
                    false, "", "");
            lastFingerprint = descriptor.fingerprint();
            lastPublishedAt = System.currentTimeMillis();
            return build(descriptor);
        }

        void onTransport(String status, String message) {
            if ("connected".equals(status)) {
                NoticeState state;
                synchronized (this) {
                    state = sessionStates.get(activeSessionId);
                }
                if (state != null && !state.status.isEmpty()) {
                    enqueue(state.descriptor());
                    return;
                }
            }
            String label;
            if ("connecting".equals(status)) label = "正在连接 Bridge";
            else if ("disconnected".equals(status) || "retrying".equals(status)) label = "Bridge 重连中";
            else if ("offline".equals(status)) label = "已断开";
            else label = "DSH 已连接";
            enqueue(new NoticeDescriptor("", "", "", "DSH Remote", label, status,
                    false, "", safe(message, label)));
        }

        void onSnapshot(JSONObject snapshot) {
            JSONObject session = snapshot.optJSONObject("session");
            JSONObject project = snapshot.optJSONObject("project");
            String sessionId = session == null ? "" : trim(session.optString("id", ""));
            if (sessionId.isEmpty()) {
                onTransport(transportConnected ? "connected" : "disconnected", "");
                return;
            }
            NoticeState state = stateFor(sessionId);
            state.title = session == null ? "DSH Remote" : safe(session.optString("title", ""), "DSH Remote");
            state.projectId = project == null ? "" : trim(project.optString("id", ""));
            state.projectName = project == null ? "" : safe(project.optString("name", ""), "DSH");
            activeSessionId = sessionId;

            JSONObject approval = snapshot.optJSONObject("pendingApproval");
            if (approval != null && !trim(approval.optString("requestId", "")).isEmpty()) {
                state.status = "approval";
                state.detail = firstNonEmpty(approval, "detail", "reason", "tool", "title");
                state.requestId = trim(approval.optString("requestId", ""));
            } else {
                state.requestId = "";
                applySnapshotStatus(state, snapshot);
            }
            enqueue(state.descriptor());
        }

        void onEvent(String type, JSONObject message) {
            String sessionId = eventSessionId(message);
            if (sessionId.isEmpty()) return;
            NoticeState state = stateFor(sessionId);
            JSONObject data = message.optJSONObject("data");
            String detail = eventDetail(data);
            if (!detail.isEmpty()) state.detail = detail;
            activeSessionId = sessionId;

            if ("agent.thinking".equals(type)) state.status = "thinking";
            else if ("tool.started".equals(type)) state.status = "tool";
            else if ("terminal.started".equals(type) || "terminal.output".equals(type)
                    || "file.changed".equals(type)) state.status = "building";
            else if ("approval.required".equals(type)) {
                state.status = "approval";
                state.requestId = data == null ? "" : trim(data.optString("requestId", data.optString("id", "")));
            } else if ("approval.resolved".equals(type)) {
                String resolved = data == null ? "" : trim(data.optString("requestId", ""));
                if (resolved.isEmpty() || resolved.equals(state.requestId)) state.requestId = "";
                state.status = "building";
            } else if ("session.completed".equals(type)) {
                state.status = "completed";
                state.requestId = "";
            } else if ("session.failed".equals(type)) {
                state.status = "failed";
                state.requestId = "";
            } else if ("session.started".equals(type)) {
                state.status = "building";
                state.requestId = "";
            }
            enqueue(state.descriptor());
        }

        private void applySnapshotStatus(NoticeState state, JSONObject snapshot) {
            String combined = (snapshot.optString("state", "") + " "
                    + snapshot.optString("phase", "")).toLowerCase(Locale.ROOT);
            if (combined.contains("fail") || combined.contains("error")) state.status = "failed";
            else if (combined.contains("complete") || combined.contains("success")
                    || combined.contains("idle")) state.status = "completed";
            else if (combined.contains("approv")) state.status = "approval";
            else if (combined.contains("think") || combined.contains("reason")) state.status = "thinking";
            else if (combined.contains("tool")) state.status = "tool";
            else if (combined.contains("run") || combined.contains("build")
                    || combined.contains("terminal") || combined.contains("command")) state.status = "building";
            else state.status = transportConnected ? "connected" : "disconnected";
            state.detail = firstNonEmpty(snapshot, "summary", "command", "lastMessage", "phase");
        }

        private synchronized NoticeState stateFor(String sessionId) {
            NoticeState state = sessionStates.get(sessionId);
            if (state == null) {
                state = new NoticeState(sessionId);
                String projectId = snapshotStore.projectIdForSession(sessionId);
                state.projectId = projectId;
                state.projectName = "DSH";
                state.title = "DSH Remote";
                sessionStates.put(sessionId, state);
                trimMap(sessionStates, MAX_TRACKED_SESSIONS);
            }
            return state;
        }

        private synchronized void enqueue(NoticeDescriptor descriptor) {
            pending = descriptor;
            if (descriptor.fingerprint().equals(lastFingerprint)) return;
            if (publishScheduled) return;
            long delay = Math.max(0L, 500L - (System.currentTimeMillis() - lastPublishedAt));
            publishScheduled = true;
            handler.postDelayed(this::publishPending, delay);
        }

        private void publishPending() {
            NoticeDescriptor descriptor;
            synchronized (this) {
                publishScheduled = false;
                descriptor = pending;
                pending = null;
                if (descriptor == null || descriptor.fingerprint().equals(lastFingerprint)) return;
                lastFingerprint = descriptor.fingerprint();
                lastPublishedAt = System.currentTimeMillis();
            }
            if (manager != null && foregroundStarted) manager.notify(NOTIFICATION_ID, build(descriptor));
        }

        private Notification build(NoticeDescriptor descriptor) {
            String statusLine = statusLabel(descriptor.status);
            String content = descriptor.detail.isEmpty()
                    ? statusLine : statusLine + " · " + compact(descriptor.detail, 72);
            NotificationCompat.Builder builder = new NotificationCompat.Builder(RemoteService.this, CHANNEL_ID)
                    .setSmallIcon(R.drawable.ic_notify)
                    .setContentTitle(descriptor.title.isEmpty() ? "DSH Remote" : descriptor.title)
                    .setContentText(content)
                    .setStyle(new NotificationCompat.BigTextStyle().bigText(content))
                    .setOngoing(true)
                    .setOnlyAlertOnce(true)
                    .setSilent(true)
                    .setCategory(NotificationCompat.CATEGORY_SERVICE)
                    .setPriority(NotificationCompat.PRIORITY_LOW)
                    .setContentIntent(openSessionIntent(descriptor));

            if ("approval".equals(descriptor.status) && !descriptor.requestId.isEmpty()) {
                builder.addAction(controlAction("允许", "approval.allow", descriptor.sessionId,
                        descriptor.requestId, 21));
                builder.addAction(controlAction("拒绝", "approval.deny", descriptor.sessionId,
                        descriptor.requestId, 22));
            } else if (descriptor.running && !descriptor.sessionId.isEmpty()) {
                builder.addAction(controlAction("停止", "task.stop", descriptor.sessionId, "", 23));
            }
            return builder.build();
        }

        private PendingIntent openSessionIntent(NoticeDescriptor descriptor) {
            Intent intent = new Intent(RemoteService.this, MainActivity.class)
                    .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                    .putExtra(MainActivity.EXTRA_OPEN_SESSION_ID, descriptor.sessionId)
                    .putExtra(MainActivity.EXTRA_OPEN_SESSION_TITLE, descriptor.title)
                    .putExtra(MainActivity.EXTRA_OPEN_PROJECT_ID, descriptor.projectId)
                    .putExtra(MainActivity.EXTRA_OPEN_PROJECT_NAME, descriptor.projectName)
                    .setData(Uri.parse("dshremote://session/" + Uri.encode(descriptor.sessionId)));
            int requestCode = 1000 + (descriptor.sessionId.hashCode() & 0x3fff);
            return PendingIntent.getActivity(RemoteService.this, requestCode, intent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        }

        private NotificationCompat.Action controlAction(String label, String type,
                                                        String sessionId, String requestId,
                                                        int salt) {
            JSONObject data = new JSONObject();
            try {
                if (!requestId.isEmpty()) data.put("requestId", requestId);
            } catch (Throwable ignored) {
            }
            Intent intent = new Intent(RemoteService.this, RemoteService.class)
                    .setAction(ACTION_CONTROL)
                    .putExtra(EXTRA_TYPE, type)
                    .putExtra(EXTRA_SESSION_ID, sessionId)
                    .putExtra(EXTRA_DATA, data.toString())
                    .setData(Uri.parse("dshremote://control/" + Uri.encode(type) + "/"
                            + Uri.encode(sessionId) + "/" + Uri.encode(requestId)));
            int requestCode = salt * 31 + intent.getDataString().hashCode();
            PendingIntent pendingIntent = PendingIntent.getService(RemoteService.this,
                    requestCode, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            return new NotificationCompat.Action.Builder(R.drawable.ic_notify, label, pendingIntent).build();
        }

        private String statusLabel(String status) {
            if ("thinking".equals(status)) return "✦ 思考中";
            if ("tool".equals(status)) return "⌘ 调用工具";
            if ("building".equals(status)) return "> 构建中";
            if ("approval".equals(status)) return "! 等待批准";
            if ("completed".equals(status)) return "✓ 已完成";
            if ("failed".equals(status)) return "× 失败";
            if ("connected".equals(status)) return "DSH 已连接";
            if ("offline".equals(status)) return "已断开";
            return "Bridge 重连中";
        }

        void showUpdateAction(Intent intent, String detail) {
            if (manager == null) return;
            PendingIntent action = PendingIntent.getActivity(RemoteService.this, 4202, intent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            Notification notification = new NotificationCompat.Builder(RemoteService.this, CHANNEL_ID)
                    .setSmallIcon(R.drawable.ic_notify)
                    .setContentTitle("DSH Remote 更新已下载")
                    .setContentText(detail)
                    .setStyle(new NotificationCompat.BigTextStyle().bigText(detail))
                    .setContentIntent(action)
                    .addAction(new NotificationCompat.Action.Builder(
                            R.drawable.ic_notify, "继续安装", action).build())
                    .setAutoCancel(true)
                    .setOnlyAlertOnce(true)
                    .setCategory(NotificationCompat.CATEGORY_STATUS)
                    .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                    .build();
            manager.notify(UPDATE_NOTIFICATION_ID, notification);
        }

        void shutdown() {
            handler.removeCallbacksAndMessages(null);
            synchronized (this) {
                pending = null;
                publishScheduled = false;
                sessionStates.clear();
            }
        }
    }

    private static final class NoticeState {
        final String sessionId;
        String projectId = "";
        String projectName = "DSH";
        String title = "DSH Remote";
        String status = "connected";
        String detail = "";
        String requestId = "";

        NoticeState(String sessionId) {
            this.sessionId = sessionId;
        }

        NoticeDescriptor descriptor() {
            boolean running = "thinking".equals(status) || "tool".equals(status)
                    || "building".equals(status);
            return new NoticeDescriptor(sessionId, projectId, projectName, title, status,
                    status, running, requestId, detail);
        }
    }

    private static final class NoticeDescriptor {
        final String sessionId;
        final String projectId;
        final String projectName;
        final String title;
        final String label;
        final String status;
        final boolean running;
        final String requestId;
        final String detail;

        NoticeDescriptor(String sessionId, String projectId, String projectName,
                         String title, String label, String status, boolean running,
                         String requestId, String detail) {
            this.sessionId = safe(sessionId, "");
            this.projectId = safe(projectId, "");
            this.projectName = safe(projectName, "DSH");
            this.title = safe(title, "DSH Remote");
            this.label = safe(label, "");
            this.status = safe(status, "connected");
            this.running = running;
            this.requestId = safe(requestId, "");
            this.detail = safe(detail, "");
        }

        String fingerprint() {
            return sessionId + "|" + projectId + "|" + title + "|" + status + "|"
                    + requestId + "|" + detail + "|" + running;
        }
    }

    // -----------------------------------------------------------------------------------------
    // Update manager: preserves the current front-end update API; all HTTP/file work is off-main
    // -----------------------------------------------------------------------------------------

    private final class UpdateManager {
        private final ExecutorService executor = Executors.newSingleThreadExecutor(
                namedThread("dsh-update"));
        private boolean downloading;

        void check() {
            emitStatus("update-checking", "正在检查更新");
            executor.execute(() -> {
                HttpURLConnection connection = null;
                try {
                    SettingsValue settings = configStore.current();
                    URL url = new URL(buildBridgeHttpUrl(settings, "/update/info"));
                    connection = (HttpURLConnection) url.openConnection();
                    connection.setConnectTimeout(8_000);
                    connection.setReadTimeout(8_000);
                    connection.setUseCaches(false);
                    connection.setRequestProperty("Accept", "application/json");
                    int code = connection.getResponseCode();
                    String body = readStream(code >= 200 && code < 300
                            ? connection.getInputStream() : connection.getErrorStream(), 1_048_576L);
                    if (code < 200 || code >= 300) {
                        throw new IOException("Bridge 返回 HTTP " + code
                                + (body.isEmpty() ? "" : "：" + compact(body, 160)));
                    }
                    JSONObject info = new JSONObject(body);
                    int latestCode = info.optInt("versionCode", -1);
                    String latestName = trim(info.optString("versionName", ""));
                    if (latestCode < 0 || latestName.isEmpty()) {
                        throw new IOException("Bridge 没有返回有效版本信息");
                    }
                    PackageInfo packageInfo = getPackageManager().getPackageInfo(getPackageName(), 0);
                    long currentCode = Build.VERSION.SDK_INT >= 28
                            ? packageInfo.getLongVersionCode() : packageInfo.versionCode;
                    String currentName = safe(packageInfo.versionName, "未知版本");
                    JSONObject details = new JSONObject()
                            .put("currentVersion", currentName)
                            .put("currentVersionCode", currentCode)
                            .put("latestVersion", latestName)
                            .put("latestVersionCode", latestCode);
                    if (latestCode > currentCode) {
                        emitStatus("update-available", "发现新版本 " + latestName, details);
                    } else {
                        emitStatus("update-current", "已是最新版（" + currentName + "）", details);
                    }
                } catch (Throwable error) {
                    emitStatus("update-error", errorLabel(error));
                } finally {
                    if (connection != null) connection.disconnect();
                }
            });
        }

        synchronized void download() {
            if (downloading) {
                emitStatus("update-progress", "更新正在下载，请稍候");
                return;
            }
            downloading = true;
            emitStatus("update-started", "正在下载更新");
            executor.execute(this::downloadOnWorker);
        }

        private void downloadOnWorker() {
            HttpURLConnection connection = null;
            File target = null;
            try {
                SettingsValue settings = configStore.current();
                connection = (HttpURLConnection) new URL(
                        buildBridgeHttpUrl(settings, "/download/apk")).openConnection();
                connection.setConnectTimeout(10_000);
                connection.setReadTimeout(30_000);
                connection.setUseCaches(false);
                connection.setRequestProperty("Accept", "application/vnd.android.package-archive");
                int code = connection.getResponseCode();
                if (code < 200 || code >= 300) {
                    String body = readStream(connection.getErrorStream(), 1_048_576L);
                    throw new IOException("Bridge 返回 HTTP " + code
                            + (body.isEmpty() ? "" : "：" + compact(body, 160)));
                }

                File directory = new File(getCacheDir(), "updates");
                if (!directory.isDirectory() && !directory.mkdirs()) {
                    throw new IOException("无法创建更新缓存目录");
                }
                target = new File(directory, "DSH-Remote-update-" + System.currentTimeMillis() + ".apk");
                long total = connection.getContentLengthLong();
                if (total > MAX_UPDATE_BYTES) {
                    throw new IOException("更新包超过 256 MiB 安全上限");
                }
                long downloaded = 0L;
                long lastReport = 0L;
                try (InputStream input = connection.getInputStream();
                     OutputStream output = new BufferedOutputStream(new FileOutputStream(target))) {
                    byte[] buffer = new byte[16 * 1024];
                    int read;
                    while ((read = input.read(buffer)) != -1) {
                        output.write(buffer, 0, read);
                        downloaded += read;
                        if (downloaded > MAX_UPDATE_BYTES) {
                            throw new IOException("更新包超过 256 MiB 安全上限");
                        }
                        long now = System.currentTimeMillis();
                        if (now - lastReport >= 500L) {
                            JSONObject details = new JSONObject()
                                    .put("downloadedBytes", downloaded)
                                    .put("totalBytes", total);
                            if (total > 0) details.put("progress",
                                    (int) Math.min(100L, downloaded * 100L / total));
                            emitStatus("update-progress", total > 0
                                    ? "正在从电脑下载更新（" + details.optInt("progress") + "%）"
                                    : "正在从电脑下载更新……", details);
                            lastReport = now;
                        }
                    }
                    output.flush();
                }
                if (!target.isFile() || target.length() < 10_000L) {
                    throw new IOException("下载的 APK 文件无效");
                }
                emitStatus("update-downloaded", "更新包已下载，正在打开安装确认");
                openInstaller(target);
            } catch (Throwable error) {
                if (target != null && target.isFile() && !target.delete()) {
                    Log.w(TAG, "Unable to remove partial update: " + target);
                }
                emitStatus("update-error", errorLabel(error));
            } finally {
                if (connection != null) connection.disconnect();
                synchronized (this) {
                    downloading = false;
                }
            }
        }

        private void openInstaller(File apkFile) throws Exception {
            final Intent targetIntent;
            final String actionText;
            if (!getPackageManager().canRequestPackageInstalls()) {
                targetIntent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + getPackageName()))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                actionText = "点按允许安装未知应用，返回后再点击下载更新";
            } else {
                Uri uri = FileProvider.getUriForFile(RemoteService.this,
                        getPackageName() + ".fileprovider", apkFile);
                Intent install = new Intent(Intent.ACTION_INSTALL_PACKAGE)
                        .setDataAndType(uri, "application/vnd.android.package-archive")
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP
                                | Intent.FLAG_GRANT_READ_URI_PERMISSION);
                targetIntent = install;
                actionText = "点按打开系统安装确认";
            }
            if (appInForeground) {
                try {
                    startActivity(targetIntent);
                    if (!getPackageManager().canRequestPackageInstalls()) {
                        emitStatus("update-error", actionText);
                    }
                    return;
                } catch (ActivityNotFoundException error) {
                    Log.w(TAG, "Installer activity unavailable", error);
                }
            }
            notifications.showUpdateAction(targetIntent, actionText);
            emitStatus("update-downloaded", actionText);
        }

        void shutdown() {
            executor.shutdownNow();
        }
    }

    // -----------------------------------------------------------------------------------------
    // Raw RFC 6455 WebSocket (no dependency): validated handshake, fragmentation, 32 MiB messages
    // -----------------------------------------------------------------------------------------

    private static final class WsConnection {
        private static final int CONNECT_TIMEOUT_MS = 15_000;
        private static final int IDLE_READ_TIMEOUT_MS = 5_000;
        private static final int FRAME_READ_TIMEOUT_MS = 60_000;
        private static final int WRITE_DEADLINE_MS = 15_000;
        private static final int PONG_DEADLINE_MS = 25_000;
        private static final int MAX_HEADER_BYTES = 32 * 1024;
        private static final int MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
        private static final String WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
        private static final SecureRandom RANDOM = new SecureRandom();
        /** Only this connection's read thread decodes frames, so the decoder is per socket. */
        private final CharsetDecoder strictUtf8 = StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT);

        private final URI uri;
        private final Object writeLock = new Object();
        private final ScheduledExecutorService watchdog = Executors.newSingleThreadScheduledExecutor(
                namedThread("dsh-ws-watchdog"));
        private volatile Socket socket;
        private InputStream input;
        private OutputStream output;
        private volatile boolean closed;
        private volatile long writeStartedAt;
        private volatile long pingStartedAt;
        private volatile boolean awaitingPong;
        private ByteArrayOutputStream fragments;
        private int fragmentedOpcode = -1;

        WsConnection(String endpoint) {
            uri = URI.create(endpoint);
        }

        void connect() throws Exception {
            String scheme = trim(uri.getScheme()).toLowerCase(Locale.ROOT);
            boolean secure = "wss".equals(scheme);
            if (!secure && !"ws".equals(scheme)) {
                throw new IOException("不支持的 WebSocket 协议：" + scheme);
            }
            String host = uri.getHost();
            if (TextUtils.isEmpty(host)) throw new IOException("WebSocket 地址缺少主机");
            int port = uri.getPort() > 0 ? uri.getPort() : (secure ? 443 : 80);

            if (secure) {
                SSLSocket ssl = (SSLSocket) SSLSocketFactory.getDefault().createSocket();
                SSLParameters parameters = ssl.getSSLParameters();
                parameters.setEndpointIdentificationAlgorithm("HTTPS");
                ssl.setSSLParameters(parameters);
                socket = ssl;
            } else {
                socket = new Socket();
            }
            socket.connect(new InetSocketAddress(host, port), CONNECT_TIMEOUT_MS);
            socket.setTcpNoDelay(true);
            socket.setKeepAlive(true);
            socket.setSoTimeout(CONNECT_TIMEOUT_MS);
            if (socket instanceof SSLSocket) ((SSLSocket) socket).startHandshake();
            input = socket.getInputStream();
            output = socket.getOutputStream();

            byte[] nonce = new byte[16];
            RANDOM.nextBytes(nonce);
            String key = Base64.encodeToString(nonce, Base64.NO_WRAP);
            String path = TextUtils.isEmpty(uri.getRawPath()) ? "/" : uri.getRawPath();
            if (!TextUtils.isEmpty(uri.getRawQuery())) path += "?" + uri.getRawQuery();
            String hostHeader = host.indexOf(':') >= 0 ? "[" + host + "]" : host;
            if (uri.getPort() > 0) hostHeader += ":" + uri.getPort();
            String request = "GET " + path + " HTTP/1.1\r\n"
                    + "Host: " + hostHeader + "\r\n"
                    + "Upgrade: websocket\r\n"
                    + "Connection: Upgrade\r\n"
                    + "Sec-WebSocket-Key: " + key + "\r\n"
                    + "Sec-WebSocket-Version: 13\r\n\r\n";
            output.write(request.getBytes(StandardCharsets.US_ASCII));
            output.flush();

            String headers = readHeaders();
            String[] lines = headers.split("\\r?\\n");
            if (lines.length == 0 || (!lines[0].startsWith("HTTP/1.1 101")
                    && !lines[0].startsWith("HTTP/1.0 101"))) {
                throw new IOException("Bridge WebSocket 握手失败："
                        + (lines.length == 0 ? "空响应" : compact(lines[0], 160)));
            }
            String expectedAccept = Base64.encodeToString(MessageDigest.getInstance("SHA-1")
                    .digest((key + WEBSOCKET_GUID).getBytes(StandardCharsets.US_ASCII)), Base64.NO_WRAP);
            String actualAccept = headerValue(lines, "Sec-WebSocket-Accept");
            if (!expectedAccept.equals(actualAccept)) {
                throw new IOException("Bridge WebSocket 握手校验失败");
            }
            if (!"websocket".equalsIgnoreCase(headerValue(lines, "Upgrade"))
                    || !headerContainsToken(headerValue(lines, "Connection"), "upgrade")) {
                throw new IOException("Bridge WebSocket Upgrade/Connection 响应头无效");
            }
            socket.setSoTimeout(IDLE_READ_TIMEOUT_MS);
            watchdog.scheduleWithFixedDelay(this::watchdogTick, 1L, 1L, TimeUnit.SECONDS);
        }

        String readTextMessage() throws IOException {
            while (!closed) {
                checkDeadlines();
                Frame frame = readFrame(fragments == null);
                if (frame == null) {
                    checkDeadlines();
                    return null; // idle poll
                }
                if (frame.opcode == 0x8) {
                    String reason = frame.payload.length > 2
                            ? new String(frame.payload, 2, frame.payload.length - 2, StandardCharsets.UTF_8)
                            : "Bridge 主动关闭连接";
                    try {
                        sendControlFrame(0x8, frame.payload);
                    } catch (Throwable ignored) {
                    }
                    closed = true;
                    throw new EOFException(reason);
                }
                if (frame.opcode == 0x9) {
                    sendControlFrame(0xA, frame.payload);
                    continue;
                }
                if (frame.opcode == 0xA) {
                    awaitingPong = false;
                    pingStartedAt = 0L;
                    continue;
                }

                if (frame.opcode == 0x1 || frame.opcode == 0x2) {
                    if (fragments != null) throw new IOException("收到重叠的 WebSocket 分片消息");
                    if (frame.fin) {
                        return frame.opcode == 0x1 ? decodeText(frame.payload) : null;
                    }
                    fragments = new ByteArrayOutputStream(Math.min(frame.payload.length * 2,
                            MAX_MESSAGE_BYTES));
                    fragmentedOpcode = frame.opcode;
                    appendFragment(frame.payload);
                    continue;
                }
                if (frame.opcode == 0x0) {
                    if (fragments == null) throw new IOException("收到孤立的 WebSocket continuation 帧");
                    appendFragment(frame.payload);
                    if (frame.fin) {
                        byte[] payload = fragments.toByteArray();
                        int opcode = fragmentedOpcode;
                        fragments = null;
                        fragmentedOpcode = -1;
                        return opcode == 0x1 ? decodeText(payload) : null;
                    }
                    continue;
                }
                throw new IOException("不支持的 WebSocket opcode：" + frame.opcode);
            }
            throw new EOFException("WebSocket 已关闭");
        }

        private String decodeText(byte[] payload) throws IOException {
            try {
                return strictUtf8.decode(ByteBuffer.wrap(payload)).toString();
            } catch (CharacterCodingException error) {
                throw new IOException("WebSocket 文本帧 UTF-8 无效", error);
            }
        }

        void sendText(String text) throws IOException {
            byte[] payload = safe(text, "").getBytes(StandardCharsets.UTF_8);
            if (payload.length > MAX_MESSAGE_BYTES) {
                throw new IOException("待发送消息超过 32 MiB 上限");
            }
            sendDataFrame(0x1, payload);
        }

        void sendPing() throws IOException {
            checkDeadlines();
            if (awaitingPong) return;
            awaitingPong = true;
            pingStartedAt = SystemClock.elapsedRealtime();
            try {
                sendControlFrame(0x9, new byte[0]);
            } catch (IOException error) {
                awaitingPong = false;
                pingStartedAt = 0L;
                throw error;
            }
        }

        private void appendFragment(byte[] payload) throws IOException {
            if (fragments.size() + (long) payload.length > MAX_MESSAGE_BYTES) {
                throw new IOException("WebSocket 消息超过 32 MiB 上限");
            }
            fragments.write(payload, 0, payload.length);
        }

        private Frame readFrame(boolean allowIdle) throws IOException {
            if (socket == null || input == null) throw new EOFException("WebSocket 未连接");
            socket.setSoTimeout(allowIdle ? IDLE_READ_TIMEOUT_MS : FRAME_READ_TIMEOUT_MS);
            int first;
            try {
                first = input.read();
            } catch (SocketTimeoutException timeout) {
                if (allowIdle) return null;
                throw timeout;
            }
            if (first < 0) throw new EOFException("Bridge 已关闭连接");
            // Once a frame has begun, allow a slow large payload to finish instead of applying
            // the five-second idle poll timeout to every subsequent byte.
            socket.setSoTimeout(FRAME_READ_TIMEOUT_MS);
            int second = readRequired(input);
            boolean fin = (first & 0x80) != 0;
            if ((first & 0x70) != 0) throw new IOException("WebSocket RSV 位非零");
            int opcode = first & 0x0f;
            boolean masked = (second & 0x80) != 0;
            if (masked) throw new IOException("服务端 WebSocket 帧不应被 mask");
            long length = second & 0x7f;
            if (length == 126) {
                length = ((long) readRequired(input) << 8) | readRequired(input);
            } else if (length == 127) {
                length = 0L;
                for (int index = 0; index < 8; index++) {
                    int value = readRequired(input);
                    if (index == 0 && (value & 0x80) != 0) {
                        throw new IOException("WebSocket 长度为负");
                    }
                    length = (length << 8) | value;
                }
            }
            boolean control = opcode >= 0x8;
            if (control && (!fin || length > 125L)) {
                throw new IOException("WebSocket 控制帧格式无效");
            }
            if (length > MAX_MESSAGE_BYTES) {
                throw new IOException("WebSocket 帧超过 32 MiB 上限：" + length);
            }
            byte[] payload = new byte[(int) length];
            readFully(input, payload);
            socket.setSoTimeout(IDLE_READ_TIMEOUT_MS);
            return new Frame(fin, opcode, payload);
        }

        private void sendDataFrame(int opcode, byte[] payload) throws IOException {
            synchronized (writeLock) {
                if (closed || output == null) throw new EOFException("WebSocket 未连接");
                writeMaskedFrame(opcode, payload);
            }
        }

        private void sendControlFrame(int opcode, byte[] payload) throws IOException {
            if (payload.length > 125) throw new IOException("WebSocket 控制帧过大");
            synchronized (writeLock) {
                if (closed || output == null) throw new EOFException("WebSocket 未连接");
                writeMaskedFrame(opcode, payload);
            }
        }

        private void writeMaskedFrame(int opcode, byte[] payload) throws IOException {
            writeStartedAt = SystemClock.elapsedRealtime();
            try {
                output.write(0x80 | (opcode & 0x0f));
                int length = payload.length;
                if (length <= 125) {
                    output.write(0x80 | length);
                } else if (length <= 0xffff) {
                    output.write(0x80 | 126);
                    output.write((length >>> 8) & 0xff);
                    output.write(length & 0xff);
                } else {
                    output.write(0x80 | 127);
                    long value = length;
                    for (int shift = 56; shift >= 0; shift -= 8) {
                        output.write((int) ((value >>> shift) & 0xff));
                    }
                }
                byte[] mask = new byte[4];
                RANDOM.nextBytes(mask);
                output.write(mask);
                byte[] buffer = new byte[Math.min(16 * 1024, Math.max(1, length))];
                int offset = 0;
                while (offset < length) {
                    int count = Math.min(buffer.length, length - offset);
                    for (int index = 0; index < count; index++) {
                        buffer[index] = (byte) (payload[offset + index] ^ mask[(offset + index) & 3]);
                    }
                    output.write(buffer, 0, count);
                    offset += count;
                }
                output.flush();
            } finally {
                writeStartedAt = 0L;
            }
        }

        private String readHeaders() throws IOException {
            ByteArrayOutputStream headers = new ByteArrayOutputStream();
            int state = 0;
            while (headers.size() < MAX_HEADER_BYTES) {
                int value = input.read();
                if (value < 0) throw new EOFException("WebSocket 握手响应提前结束");
                headers.write(value);
                if ((state == 0 || state == 2) && value == '\r') state++;
                else if ((state == 1 || state == 3) && value == '\n') state++;
                else state = value == '\r' ? 1 : 0;
                if (state == 4) return headers.toString(StandardCharsets.US_ASCII.name());
            }
            throw new IOException("WebSocket 握手响应头超过 32 KiB");
        }

        private static String headerValue(String[] lines, String name) {
            String prefix = name.toLowerCase(Locale.ROOT) + ":";
            for (int index = 1; index < lines.length; index++) {
                String line = lines[index];
                if (line.toLowerCase(Locale.ROOT).startsWith(prefix)) {
                    return line.substring(line.indexOf(':') + 1).trim();
                }
            }
            return "";
        }

        private static boolean headerContainsToken(String value, String expected) {
            for (String token : safe(value, "").split(",")) {
                if (expected.equalsIgnoreCase(token.trim())) return true;
            }
            return false;
        }

        private void checkDeadlines() throws IOException {
            long now = SystemClock.elapsedRealtime();
            long writeAt = writeStartedAt;
            if (writeAt > 0L && now - writeAt > WRITE_DEADLINE_MS) {
                close();
                throw new SocketTimeoutException("WebSocket 写入超过 " + WRITE_DEADLINE_MS + "ms");
            }
            long pingAt = pingStartedAt;
            if (awaitingPong && pingAt > 0L && now - pingAt > PONG_DEADLINE_MS) {
                close();
                throw new SocketTimeoutException("Bridge ping 超过 " + PONG_DEADLINE_MS
                        + "ms 未收到 pong");
            }
        }

        /** Socket.close() is deliberately outside writeLock so a blocked write can be broken. */
        private void watchdogTick() {
            if (closed) return;
            try {
                checkDeadlines();
            } catch (IOException timeout) {
                Log.w(TAG, "WebSocket watchdog closed a stalled socket: " + errorLabel(timeout));
                close();
            }
        }

        boolean isClosed() {
            return closed;
        }

        void close() {
            closed = true;
            awaitingPong = false;
            pingStartedAt = 0L;
            watchdog.shutdownNow();
            Socket value = socket;
            socket = null;
            if (value != null) {
                try {
                    value.close();
                } catch (IOException ignored) {
                }
            }
        }
    }

    private static final class Frame {
        final boolean fin;
        final int opcode;
        final byte[] payload;

        Frame(boolean fin, int opcode, byte[] payload) {
            this.fin = fin;
            this.opcode = opcode;
            this.payload = payload;
        }
    }

    // -----------------------------------------------------------------------------------------
    // Same-process gateways: no image/base64 payload is ever copied through Intent/Binder extras
    // -----------------------------------------------------------------------------------------

    private static final class GatewayControl {
        final String type;
        final String dataJson;
        final String sessionId;

        GatewayControl(String type, String dataJson, String sessionId) {
            this.type = safe(type, "");
            this.dataJson = safe(dataJson, "{}");
            this.sessionId = safe(sessionId, "");
        }
    }

    private static final class ServiceGateway {
        private static final ArrayDeque<GatewayControl> PENDING = new ArrayDeque<>();
        private static WeakReference<RemoteService> active = new WeakReference<>(null);
        private static long pendingChars;
        private static boolean attaching;
        private static boolean explicitlyBlocked;

        static synchronized void allowConnections() {
            explicitlyBlocked = false;
        }

        static synchronized boolean connectionsBlocked() {
            return explicitlyBlocked;
        }

        static void blockConnections(String reason) {
            ArrayList<GatewayControl> discarded;
            synchronized (ServiceGateway.class) {
                explicitlyBlocked = true;
                RemoteService service = active.get();
                if (service != null) service.acceptingControls = false;
                active = new WeakReference<>(null);
                discarded = new ArrayList<>(PENDING);
                PENDING.clear();
                pendingChars = 0L;
            }
            for (GatewayControl control : discarded) {
                reportAdmissionFailure(control.type, control.sessionId,
                        safe(reason, "已主动断开，控制未发送"));
            }
        }

        static void attach(RemoteService service) {
            synchronized (ServiceGateway.class) {
                if (explicitlyBlocked || !service.acceptingControls || service.destroyed) return;
                attaching = true;
                active = new WeakReference<>(null);
            }
            for (;;) {
                GatewayControl control;
                synchronized (ServiceGateway.class) {
                    if (explicitlyBlocked || !service.acceptingControls || service.destroyed) {
                        attaching = false;
                        return;
                    }
                    control = PENDING.pollFirst();
                    if (control == null) {
                        if (service.acceptingControls && !service.destroyed) {
                            active = new WeakReference<>(service);
                        }
                        attaching = false;
                        return;
                    }
                    pendingChars -= control.dataJson.length();
                }
                // New submissions remain in PENDING while attaching=true, so they can never
                // overtake controls that were queued before Service.onCreate completed.
                if (!service.tryAcceptControl(control.type, control.dataJson, control.sessionId)
                        && (!service.acceptingControls || service.destroyed)) {
                    boolean blocked;
                    synchronized (ServiceGateway.class) {
                        blocked = explicitlyBlocked;
                        if (!blocked) {
                            PENDING.addFirst(control);
                            pendingChars += control.dataJson.length();
                        }
                        attaching = false;
                    }
                    if (blocked) {
                        reportAdmissionFailure(control.type, control.sessionId,
                                "已主动断开，控制未发送");
                    }
                    return;
                }
            }
        }

        static synchronized void detach(RemoteService service) {
            service.acceptingControls = false;
            service.destroyed = true;
            if (active.get() == service) active = new WeakReference<>(null);
        }

        static boolean submit(Context context, String type, String dataJson, String sessionId) {
            GatewayControl control = new GatewayControl(type, dataJson, sessionId);
            boolean startService = false;
            synchronized (ServiceGateway.class) {
                if (explicitlyBlocked) {
                    reportAdmissionFailure(control.type, control.sessionId,
                            "已主动断开；请先重新连接再发送控制");
                    return false;
                }
                RemoteService service = active.get();
                // Holding this lock linearizes admission against detach(); tryAcceptControl only
                // enqueues work and never performs a network write here.
                if (service != null && service.acceptingControls && !service.destroyed) {
                    return service.tryAcceptControl(control.type, control.dataJson,
                            control.sessionId);
                }
                if (control.dataJson.length() > MAX_CONTROL_FRAME_BYTES
                        || PENDING.size() >= MAX_QUEUED_CONTROLS
                        || pendingChars + control.dataJson.length() > MAX_GATEWAY_PENDING_CHARS) {
                    reportAdmissionFailure(control.type, control.sessionId,
                            "离线控制缓存已满或消息超过 Bridge 1 MiB 上限");
                    return false;
                }
                PENDING.addLast(control);
                pendingChars += control.dataJson.length();
                startService = !attaching;
            }
            if (!startService) return true;
            try {
                ContextCompat.startForegroundService(context,
                        new Intent(context, RemoteService.class).setAction(ACTION_WAKE));
                return true;
            } catch (Throwable error) {
                synchronized (ServiceGateway.class) {
                    if (PENDING.remove(control)) pendingChars -= control.dataJson.length();
                }
                reportAdmissionFailure(control.type, control.sessionId,
                        "服务启动失败：" + errorLabel(error));
                return false;
            }
        }
    }

    private static final class MessageHub {
        private static final int MAX_REPLAY_MESSAGES = 512;
        private static final long MAX_REPLAY_CHARS = 32L * 1024L * 1024L;
        private static final String RESYNC_WARNING = "{\"type\":\"status\",\"source\":\"native\"," 
                + "\"data\":{\"status\":\"resync-required\"," 
                + "\"message\":\"后台事件缓存达到上限，正在重新同步快照和当前历史\"}}";
        private static final Handler MAIN = new Handler(Looper.getMainLooper());
        private static final ArrayDeque<HubFrame> QUEUE = new ArrayDeque<>();
        private static WeakReference<MessageListener> listener = new WeakReference<>(null);
        private static WeakReference<RemoteService> owner = new WeakReference<>(null);
        private static long endpointEpoch = 1L;
        private static long nextFrameId = 1L;
        private static long queuedChars;
        private static boolean replayTruncated;
        private static boolean resyncWarningQueued;
        private static boolean drainScheduled;
        private static HubFrame awaitingFrame;
        private static MessageListener awaitingListener;

        private static final class HubFrame {
            final String payload;
            final long epoch;
            final long id;

            HubFrame(String payload, long epoch, long id) {
                this.payload = payload;
                this.epoch = epoch;
                this.id = id;
            }
        }

        static synchronized void attach(RemoteService service) {
            owner = new WeakReference<>(service);
        }

        static void register(MessageListener value) {
            synchronized (MessageHub.class) {
                listener = new WeakReference<>(value);
                enqueueResyncWarningLocked();
                scheduleDrainLocked();
            }
        }

        static synchronized void unregister(MessageListener value) {
            if (listener.get() == value) listener = new WeakReference<>(null);
        }

        static void post(String payload) {
            long epoch;
            synchronized (MessageHub.class) {
                epoch = endpointEpoch;
            }
            post(payload, epoch);
        }

        static void post(String payload, long epoch) {
            if (payload == null) return;
            boolean requestResync = false;
            synchronized (MessageHub.class) {
                if (epoch != endpointEpoch) return;
                QUEUE.addLast(new HubFrame(payload, epoch, allocateFrameIdLocked()));
                queuedChars += payload.length();
                // Keep a single large history frame even if it alone exceeds the normal replay
                // budget; otherwise evict oldest frames and let Activity trigger authoritative
                // snapshot/history resync on registration.
                while ((QUEUE.size() > MAX_REPLAY_MESSAGES
                        || (queuedChars > MAX_REPLAY_CHARS && QUEUE.size() > 1))) {
                    HubFrame removed;
                    if (awaitingFrame != null && awaitingFrame == QUEUE.peekFirst()) {
                        Iterator<HubFrame> iterator = QUEUE.iterator();
                        iterator.next();
                        if (!iterator.hasNext()) break;
                        removed = iterator.next();
                        iterator.remove();
                    } else {
                        removed = QUEUE.removeFirst();
                    }
                    queuedChars -= removed.payload.length();
                    if (RESYNC_WARNING.equals(removed.payload)) resyncWarningQueued = false;
                    if (!replayTruncated) requestResync = true;
                    replayTruncated = true;
                }
                enqueueResyncWarningLocked();
                scheduleDrainLocked();
            }
            if (requestResync) MAIN.post(MessageHub::requestAuthoritativeResync);
        }

        private static void enqueueResyncWarningLocked() {
            if (!replayTruncated || resyncWarningQueued) return;
            HubFrame warning = new HubFrame(
                    RESYNC_WARNING, endpointEpoch, allocateFrameIdLocked());
            if (awaitingFrame == null) QUEUE.addFirst(warning);
            else QUEUE.addLast(warning);
            queuedChars += RESYNC_WARNING.length();
            resyncWarningQueued = true;
        }

        private static void requestAuthoritativeResync() {
            RemoteService service;
            synchronized (MessageHub.class) {
                service = owner.get();
            }
            if (service != null) service.requestReplayResync();
        }

        private static void scheduleDrainLocked() {
            if (drainScheduled || awaitingFrame != null || QUEUE.isEmpty()
                    || listener.get() == null) return;
            drainScheduled = true;
            MAIN.post(MessageHub::drain);
        }

        private static void drain() {
            HubFrame frame;
            MessageListener target;
            synchronized (MessageHub.class) {
                drainScheduled = false;
                if (awaitingFrame != null) return;
                frame = QUEUE.peekFirst();
                target = listener.get();
                if (frame == null || target == null || frame.epoch != endpointEpoch) return;
                // Mark ownership before the callback: snapshot de-duplication can acknowledge
                // synchronously from inside onRemoteMessage().
                awaitingFrame = frame;
                awaitingListener = target;
                boolean accepted;
                try {
                    accepted = target.onRemoteMessage(frame.payload, frame.epoch, frame.id);
                } catch (Throwable error) {
                    Log.e(TAG, "Message listener failed", error);
                    accepted = false;
                }
                if (!accepted) acknowledgeLocked(frame.id, false);
            }
        }

        static void acknowledge(long frameId, boolean delivered) {
            if (frameId <= 0L) return;
            synchronized (MessageHub.class) {
                acknowledgeLocked(frameId, delivered);
            }
        }

        private static void acknowledgeLocked(long frameId, boolean delivered) {
            if (awaitingFrame == null || awaitingFrame.id != frameId) return;
            MessageListener frameOwner = awaitingListener;
            if (delivered && awaitingFrame == QUEUE.peekFirst()) {
                HubFrame removed = QUEUE.removeFirst();
                queuedChars -= removed.payload.length();
                if (RESYNC_WARNING.equals(removed.payload)) {
                    replayTruncated = false;
                    resyncWarningQueued = false;
                }
            }
            awaitingFrame = null;
            awaitingListener = null;
            if (!delivered) {
                if (listener.get() == frameOwner) listener = new WeakReference<>(null);
                return;
            }
            scheduleDrainLocked();
        }

        private static long allocateFrameIdLocked() {
            long id = nextFrameId++;
            if (id <= 0L || nextFrameId <= 0L) {
                nextFrameId = 2L;
                id = 1L;
            }
            return id;
        }

        static synchronized long currentEpoch() {
            return endpointEpoch;
        }

        static synchronized long resetEndpoint(String firstPayload) {
            endpointEpoch++;
            if (endpointEpoch <= 0L) endpointEpoch = 1L;
            QUEUE.clear();
            queuedChars = 0L;
            replayTruncated = false;
            resyncWarningQueued = false;
            drainScheduled = false;
            awaitingFrame = null;
            awaitingListener = null;
            if (firstPayload != null) {
                QUEUE.addLast(new HubFrame(
                        firstPayload, endpointEpoch, allocateFrameIdLocked()));
                queuedChars = firstPayload.length();
                scheduleDrainLocked();
            }
            return endpointEpoch;
        }
    }

    // -----------------------------------------------------------------------------------------
    // Shared helpers
    // -----------------------------------------------------------------------------------------

    private void emitStatus(String status, String message) {
        emitStatus(status, message, null);
    }

    private void emitStatus(String status, String message, JSONObject extra) {
        try {
            JSONObject data = new JSONObject()
                    .put("status", status)
                    .put("message", safe(message, ""));
            if (extra != null) {
                Iterator<String> keys = extra.keys();
                while (keys.hasNext()) {
                    String key = keys.next();
                    data.put(key, extra.opt(key));
                }
            }
            MessageHub.post(new JSONObject()
                    .put("type", "status")
                    .put("source", "native")
                    .put("data", data)
                    .toString());
        } catch (Throwable error) {
            Log.e(TAG, "Unable to create status message", error);
        }
    }

    private static String normalizeEndpoint(String rawEndpoint) {
        String value = trim(rawEndpoint);
        if (value.isEmpty()) value = BUILTIN_ENDPOINT;
        if (value.startsWith("http://")) value = "ws://" + value.substring(7);
        else if (value.startsWith("https://")) value = "wss://" + value.substring(8);
        else if (!value.contains("://")) value = "ws://" + value;
        try {
            URI source = URI.create(value);
            String scheme = trim(source.getScheme()).toLowerCase(Locale.ROOT);
            if (!"ws".equals(scheme) && !"wss".equals(scheme)) {
                throw new IllegalArgumentException("仅支持 ws:// 或 wss://");
            }
            if (TextUtils.isEmpty(source.getHost())) throw new IllegalArgumentException("地址缺少主机");
            String path = source.getRawPath();
            path = TextUtils.isEmpty(path) ? "" : path.replaceAll("/+$", "");
            if (path.isEmpty()) {
                path = "/ws";
            } else if (!path.endsWith("/ws")) {
                path += "/ws";
            }
            String query = withoutQueryParameter(source.getRawQuery(), "token");
            return new URI(scheme, source.getRawUserInfo(), source.getHost(), source.getPort(),
                    path, TextUtils.isEmpty(query) ? null : query, null).toString();
        } catch (IllegalArgumentException error) {
            throw error;
        } catch (Throwable error) {
            throw new IllegalArgumentException("无法解析 Bridge 地址：" + errorLabel(error), error);
        }
    }

    private static String appendToken(String endpoint, String token) {
        String normalized = normalizeEndpoint(endpoint);
        if (trim(token).isEmpty()) return normalized;
        try {
            URI source = URI.create(normalized);
            String query = source.getRawQuery();
            String tokenPart = "token=" + urlEncode(token);
            query = TextUtils.isEmpty(query) ? tokenPart : query + "&" + tokenPart;
            return new URI(source.getScheme(), source.getRawUserInfo(), source.getHost(),
                    source.getPort(), source.getRawPath(), query, null).toString();
        } catch (Throwable error) {
            throw new IllegalArgumentException("无法附加鉴权 token：" + errorLabel(error), error);
        }
    }

    private static String tokenFromEndpoint(String endpoint) {
        try {
            URI uri = URI.create(trim(endpoint));
            String query = uri.getRawQuery();
            if (TextUtils.isEmpty(query)) return "";
            for (String part : query.split("&")) {
                int separator = part.indexOf('=');
                String name = separator < 0 ? part : part.substring(0, separator);
                if (!"token".equals(urlDecode(name))) continue;
                return separator < 0 ? "" : urlDecode(part.substring(separator + 1));
            }
        } catch (Throwable ignored) {
        }
        return "";
    }

    private static String withoutQueryParameter(String query, String excludedName) {
        if (TextUtils.isEmpty(query)) return "";
        ArrayList<String> kept = new ArrayList<>();
        for (String part : query.split("&")) {
            if (part.isEmpty()) continue;
            int separator = part.indexOf('=');
            String name = separator < 0 ? part : part.substring(0, separator);
            if (!excludedName.equals(urlDecode(name))) kept.add(part);
        }
        return TextUtils.join("&", kept);
    }

    private static String buildBridgeHttpUrl(SettingsValue settings, String path) throws Exception {
        URI source = URI.create(settings.endpoint);
        String scheme = "wss".equalsIgnoreCase(source.getScheme()) ? "https" : "http";
        String query = trim(settings.token).isEmpty() ? null : "token=" + urlEncode(settings.token);
        return new URI(scheme, source.getRawUserInfo(), source.getHost(), source.getPort(),
                path, query, null).toString();
    }

    private static String eventSessionId(JSONObject message) {
        String value = trim(message.optString("sessionId", ""));
        JSONObject data = message.optJSONObject("data");
        if (value.isEmpty() && data != null) value = trim(data.optString("sessionId", ""));
        if (value.isEmpty() && data != null) {
            JSONObject session = data.optJSONObject("session");
            if (session != null) value = trim(session.optString("id", ""));
        }
        if (value.isEmpty()) {
            JSONObject session = message.optJSONObject("session");
            if (session != null) value = trim(session.optString("id", ""));
        }
        return value;
    }

    private static String eventDetail(JSONObject data) {
        return firstNonEmpty(data, "detail", "summary", "thought", "reasoning", "analysis",
                "command", "text", "content", "reply", "response", "message", "path", "tool");
    }

    private static String firstNonEmpty(JSONObject value, String... keys) {
        if (value == null) return "";
        for (String key : keys) {
            Object raw = value.opt(key);
            if (raw == null || raw == JSONObject.NULL) continue;
            String text = trim(String.valueOf(raw));
            if (!text.isEmpty()) return text;
        }
        return "";
    }

    private static String readStream(InputStream input, long maxBytes) throws IOException {
        if (input == null) return "";
        try (InputStream stream = input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];
            long total = 0L;
            int read;
            while ((read = stream.read(buffer)) != -1) {
                total += read;
                if (total > maxBytes) throw new IOException("HTTP 响应超过允许大小");
                output.write(buffer, 0, read);
            }
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }

    private static int readRequired(InputStream input) throws IOException {
        int value = input.read();
        if (value < 0) throw new EOFException("WebSocket 帧提前结束");
        return value;
    }

    private static void readFully(InputStream input, byte[] target) throws IOException {
        int offset = 0;
        while (offset < target.length) {
            int read = input.read(target, offset, target.length - offset);
            if (read < 0) throw new EOFException("WebSocket 帧载荷提前结束");
            offset += read;
        }
    }

    private static JSONObject parseObject(String value) {
        try {
            return new JSONObject(TextUtils.isEmpty(value) ? "{}" : value);
        } catch (Throwable ignored) {
            return new JSONObject();
        }
    }

    private static long positiveLong(Object value, long fallback) {
        if (value instanceof Number) {
            long number = ((Number) value).longValue();
            return number > 0L ? number : fallback;
        }
        try {
            long number = Long.parseLong(trim(value == null ? "" : String.valueOf(value)));
            return number > 0L ? number : fallback;
        } catch (Throwable ignored) {
            return fallback;
        }
    }

    private static String errorLabel(Throwable error) {
        if (error == null) return "未知错误";
        String name = error.getClass().getSimpleName();
        if (TextUtils.isEmpty(name)) name = error.getClass().getName();
        String detail = trim(error.getMessage());
        if (detail.isEmpty() && error.getCause() != null && error.getCause() != error) {
            detail = errorLabel(error.getCause());
        }
        return detail.isEmpty() ? name : name + ": " + detail;
    }

    private static ThreadFactory namedThread(String baseName) {
        AtomicInteger counter = new AtomicInteger();
        return runnable -> {
            Thread thread = new Thread(runnable,
                    baseName + "-" + counter.incrementAndGet());
            thread.setDaemon(false);
            return thread;
        };
    }

    private static String compact(String value, int maxCodePoints) {
        String text = safe(value, "").replaceAll("\\s+", " ").trim();
        if (text.codePointCount(0, text.length()) <= maxCodePoints) return text;
        int end = text.offsetByCodePoints(0, Math.max(1, maxCodePoints - 1));
        return text.substring(0, end).trim() + "…";
    }

    private static String sha256Hex(String value) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(safe(value, "").getBytes(StandardCharsets.UTF_8));
            char[] alphabet = "0123456789abcdef".toCharArray();
            char[] result = new char[digest.length * 2];
            for (int i = 0; i < digest.length; i++) {
                int octet = digest[i] & 0xff;
                result[i * 2] = alphabet[octet >>> 4];
                result[i * 2 + 1] = alphabet[octet & 0x0f];
            }
            return new String(result);
        } catch (Throwable error) {
            throw new IllegalStateException("设备不支持 SHA-256", error);
        }
    }

    private static String safe(String value, String fallback) {
        return value == null || value.isEmpty() ? fallback : value;
    }

    private static String trim(String value) {
        return value == null ? "" : value.trim();
    }

    private static int clamp(int value, int minimum, int maximum) {
        return Math.max(minimum, Math.min(maximum, value));
    }

    private static String urlEncode(String value) {
        try {
            return URLEncoder.encode(safe(value, ""), StandardCharsets.UTF_8.name());
        } catch (Throwable ignored) {
            return safe(value, "");
        }
    }

    private static String urlDecode(String value) {
        try {
            return URLDecoder.decode(safe(value, ""), StandardCharsets.UTF_8.name());
        } catch (Throwable ignored) {
            return safe(value, "");
        }
    }

    private static <K, V> void trimMap(LinkedHashMap<K, V> map, int maximum) {
        while (map.size() > maximum) {
            Iterator<K> iterator = map.keySet().iterator();
            if (!iterator.hasNext()) return;
            iterator.next();
            iterator.remove();
        }
    }
}
