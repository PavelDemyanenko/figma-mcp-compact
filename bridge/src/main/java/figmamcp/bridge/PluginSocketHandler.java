package figmamcp.bridge;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.PingMessage;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator;
import org.springframework.web.socket.handler.TextWebSocketHandler;
import org.springframework.web.socket.server.HandshakeInterceptor;

/** Plugin WebSocket endpoint: ws://localhost:3055 (ui.html; the server listens on 127.0.0.1). */
@Component
public class PluginSocketHandler extends TextWebSocketHandler implements HandshakeInterceptor {

    private static final Logger log = LoggerFactory.getLogger(PluginSocketHandler.class);
    private static final int SEND_TIME_LIMIT_MS = 10_000;
    private static final int SEND_BUFFER_LIMIT = 1024 * 1024;

    private final PluginGateway gateway;
    private final Map<String, WebSocketSession> sockets = new ConcurrentHashMap<>();

    public PluginSocketHandler(PluginGateway gateway) {
        this.gateway = gateway;
    }

    // ---------- handshake: local Host and Figma plugin origin only ----------

    @Override
    public boolean beforeHandshake(ServerHttpRequest request, ServerHttpResponse response, WebSocketHandler handler,
                                   Map<String, Object> attributes) {
        String host = request.getHeaders().getFirst("Host");
        String origin = request.getHeaders().getOrigin();
        if (!LocalOnly.isLocalHost(host) || !LocalOnly.isAllowedOrigin(origin)) {
            log.warn("rejected WebSocket handshake: host={}, origin={}", host, origin);
            response.setStatusCode(HttpStatus.FORBIDDEN);
            return false;
        }
        return true;
    }

    @Override
    public void afterHandshake(ServerHttpRequest request, ServerHttpResponse response, WebSocketHandler handler,
                               Exception exception) {
        // no-op
    }

    // ---------- sessions ----------

    @Override
    public void afterConnectionEstablished(WebSocketSession raw) {
        // Sends come from different threads (MCP calls, ping); the decorator serializes them.
        WebSocketSession ws = new ConcurrentWebSocketSessionDecorator(raw, SEND_TIME_LIMIT_MS, SEND_BUFFER_LIMIT);
        sockets.put(raw.getId(), ws);
        gateway.register(new PluginSession(raw.getId(), text -> ws.sendMessage(new TextMessage(text))));
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) {
        gateway.onMessage(session.getId(), message.getPayload());
    }

    @Override
    public void handleTransportError(WebSocketSession session, Throwable exception) {
        log.debug("transport error on {}: {}", session.getId(), exception.toString());
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        sockets.remove(session.getId());
        gateway.unregister(session.getId());
    }

    /** Ping detects dead connections (laptop sleep, a Figma tab closed without a close frame). */
    @Scheduled(fixedDelayString = "${bridge.ping-interval:25s}")
    void ping() {
        sockets.values().forEach(ws -> {
            try {
                if (ws.isOpen()) {
                    ws.sendMessage(new PingMessage(ByteBuffer.allocate(0)));
                }
            } catch (IOException | IllegalStateException e) {
                closeQuietly(ws);
            }
        });
    }

    private static void closeQuietly(WebSocketSession ws) {
        try {
            ws.close(CloseStatus.SESSION_NOT_RELIABLE);
        } catch (IOException ignored) {
            // the connection is already gone
        }
    }
}
