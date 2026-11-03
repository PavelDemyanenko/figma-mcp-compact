package figmamcp.bridge;

import java.io.IOException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicLong;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

/**
 * Registry of plugin connections and the JSON-RPC 2.0 client talking to them.
 *
 * <p>The active session is the one with the latest user activity (hello / selection change):
 * with several files open, the agent works with the one the designer touched last.
 */
@Component
public class PluginGateway {

    private static final Logger log = LoggerFactory.getLogger(PluginGateway.class);

    private record Pending(String sessionId, CompletableFuture<JsonNode> future) {
    }

    private final JsonMapper mapper;
    private final StylesCache stylesCache;
    private final Map<String, PluginSession> sessions = new ConcurrentHashMap<>();
    private final Map<String, Pending> pending = new ConcurrentHashMap<>();
    private final AtomicLong seq = new AtomicLong();
    /**
     * Bulkhead: the Figma sandbox is single-threaded. A parallel "storm" of agent calls (PNG exports
     * especially) freezes Figma, so concurrent requests are limited and screenshots run one at a time.
     */
    static final int MAX_CONCURRENT_REQUESTS = 4;
    private final Semaphore requestPermits = new Semaphore(MAX_CONCURRENT_REQUESTS, true);
    private final Semaphore screenshotPermit = new Semaphore(1, true);
    private volatile String activeSessionId;

    public PluginGateway(JsonMapper mapper, StylesCache stylesCache) {
        this.mapper = mapper;
        this.stylesCache = stylesCache;
    }

    // ---------- connection lifecycle ----------

    public void register(PluginSession session) {
        sessions.put(session.id(), session);
        activeSessionId = session.id();
        log.info("plugin connected: {} (total {})", session.id(), sessions.size());
    }

    public void unregister(String sessionId) {
        PluginSession removed = sessions.remove(sessionId);
        pending.entrySet().removeIf(e -> {
            if (e.getValue().sessionId().equals(sessionId)) {
                e.getValue().future().completeExceptionally(
                        new BridgeException("PLUGIN_DISCONNECTED", "Figma plugin disconnected during the request"));
                return true;
            }
            return false;
        });
        if (sessionId.equals(activeSessionId)) {
            activeSessionId = sessions.values().stream()
                    .max(Comparator.comparing(PluginSession::lastActivity))
                    .map(PluginSession::id).orElse(null);
        }
        if (removed != null) {
            log.info("plugin disconnected: {} (total {})", removed.describe(), sessions.size());
        }
    }

    public Optional<PluginSession> active() {
        String id = activeSessionId;
        return id == null ? Optional.empty() : Optional.ofNullable(sessions.get(id));
    }

    public List<PluginSession> sessions() {
        return new ArrayList<>(sessions.values());
    }

    // ---------- incoming messages ----------

    public void onMessage(String sessionId, String text) {
        PluginSession session = sessions.get(sessionId);
        if (session == null) {
            return;
        }
        JsonNode msg;
        try {
            msg = mapper.readTree(text);
        } catch (JacksonException e) {
            log.warn("invalid JSON from plugin {}: {}", sessionId, e.getOriginalMessage());
            return;
        }
        if (!msg.isObject()) {
            log.warn("unexpected non-object message from plugin {}", sessionId);
            return;
        }
        if (msg.has("method") && !msg.has("id")) {
            onNotification(session, msg.path("method").asString(""), msg.path("params"));
            return;
        }
        JsonNode id = msg.get("id");
        if (id == null || id.isNull()) {
            log.warn("plugin {} rejected a request: {}", sessionId, msg.path("error"));
            return;
        }
        Pending p = pending.remove(id.asString());
        if (p == null) {
            log.debug("late or unknown response id={} (already timed out?)", id);
            return;
        }
        p.future().complete(msg);
    }

    private void onNotification(PluginSession session, String method, JsonNode params) {
        switch (method) {
            case "figma/hello" -> {
                PluginSession.Hello h = new PluginSession.Hello(
                        params.path("fileKey").asString(""),
                        params.path("fileVersion").asString(""),
                        params.path("pageId").asString(""),
                        params.path("pageName").asString(""),
                        params.path("selectionCount").asInt(0),
                        params.path("pluginVersion").asString(""));
                session.hello(h);
                stylesCache.retainVersion(h.fileKey(), h.fileVersion());
                activeSessionId = session.id();
                log.info("hello: {}", session.describe());
            }
            case "figma/selection_changed" -> {
                List<String> lines = new ArrayList<>();
                if (params.isArray()) {
                    params.forEach(n -> lines.add(n.asString("")));
                }
                session.selection(lines);
                activeSessionId = session.id();
            }
            case "figma/styles_invalidated" -> {
                PluginSession.Hello h = session.hello();
                if (h != null) {
                    stylesCache.invalidate(h.fileKey());
                    log.info("styles cache invalidated for {}", h.fileKey());
                }
            }
            default -> log.debug("ignored notification {}", method);
        }
    }

    // ---------- outgoing requests ----------

    /** The active session, or {@code PLUGIN_NOT_CONNECTED}. */
    public PluginSession requireActive() {
        return active().orElseThrow(() -> new BridgeException("PLUGIN_NOT_CONNECTED",
                "Figma plugin is not connected. Open the \"Figma MCP Compact\" plugin in Figma "
                        + "(it connects to ws://localhost:" + PortGuard.PORT + " automatically)."));
    }

    /** Calls a plugin method in the active session. Returns the result or throws {@link BridgeException}. */
    public JsonNode call(String method, Map<String, Object> params, Duration timeout) {
        return call(requireActive(), method, params, timeout);
    }

    /**
     * Call in a specific session. Needed when the result is tied to a file (styles cache): the active
     * session may change while the request is in flight, and the answer would then belong to another file.
     */
    public JsonNode call(PluginSession session, String method, Map<String, Object> params, Duration timeout) {
        // Single deadline: time spent waiting in the bulkhead queue is subtracted from the response budget.
        long deadline = System.nanoTime() + timeout.toNanos();
        boolean screenshot = FigmaTools.GET_SCREENSHOT.equals(method);
        // A screenshot takes both its own slot and a shared one: at most MAX_CONCURRENT_REQUESTS reach the plugin.
        // Fixed acquisition order (screenshot, then shared); regular calls never take the screenshot slot: no deadlock.
        List<Semaphore> permits = screenshot ? List.of(screenshotPermit, requestPermits) : List.of(requestPermits);
        List<Semaphore> held = new ArrayList<>(permits.size());
        try {
            for (Semaphore permit : permits) {
                if (!permit.tryAcquire(Math.max(0, deadline - System.nanoTime()), TimeUnit.NANOSECONDS)) {
                    throw new BridgeException("BUSY", "Figma plugin is busy with other requests; retry " + method
                            + (permit == screenshotPermit ? " (screenshots run one at a time)" : ""));
                }
                held.add(permit);
            }
            long remaining = deadline - System.nanoTime();
            if (remaining <= 0) {
                throw new BridgeException("BUSY", "Figma plugin is busy with other requests; retry " + method);
            }
            return send(session, method, params, Duration.ofNanos(remaining), timeout);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new BridgeException("INTERRUPTED", "Interrupted");
        } finally {
            for (int i = held.size() - 1; i >= 0; i--) {
                held.get(i).release();
            }
        }
    }

    /** {@code budget} is what is left of the deadline, {@code timeout} the original value (for the error text). */
    private JsonNode send(PluginSession session, String method, Map<String, Object> params, Duration budget,
                          Duration timeout) {
        String id = "b" + seq.incrementAndGet();
        ObjectNode req = mapper.createObjectNode();
        req.put("jsonrpc", "2.0");
        req.put("id", id);
        req.put("method", method);
        req.set("params", mapper.valueToTree(params));

        CompletableFuture<JsonNode> future = new CompletableFuture<>();
        pending.put(id, new Pending(session.id(), future));
        try {
            session.send(mapper.writeValueAsString(req));
        } catch (IOException | IllegalStateException e) {
            pending.remove(id);
            throw new BridgeException("SEND_FAILED", "Failed to send request to plugin: " + e.getMessage());
        }

        JsonNode response;
        try {
            response = future.get(budget.toNanos(), TimeUnit.NANOSECONDS);
        } catch (TimeoutException e) {
            pending.remove(id);
            throw new BridgeException("TIMEOUT", method + " timed out after " + timeout.toSeconds() + "s");
        } catch (ExecutionException e) {
            if (e.getCause() instanceof BridgeException be) {
                throw be;
            }
            throw new BridgeException("INTERNAL_ERROR", String.valueOf(e.getCause()));
        } catch (InterruptedException e) {
            pending.remove(id);
            Thread.currentThread().interrupt();
            throw new BridgeException("INTERRUPTED", "Interrupted");
        }

        JsonNode error = response.get("error");
        if (error != null && !error.isNull()) {
            String reason = error.path("data").path("reason").asString("PLUGIN_ERROR");
            throw new BridgeException(reason, error.path("message").asString("Plugin error")
                    + suffix(error.path("data")));
        }
        return response.path("result");
    }

    /** Useful error.data fields (e.g. suggestedScale) so the agent can correct itself. */
    private static String suffix(JsonNode data) {
        if (!data.isObject() || data.size() <= 1) {
            return "";
        }
        ObjectNode copy = ((ObjectNode) data).deepCopy();
        copy.remove("reason");
        return " " + copy;
    }
}
