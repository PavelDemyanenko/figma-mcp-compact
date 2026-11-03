package figmamcp.bridge;

import java.io.IOException;
import java.net.BindException;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Locale;

/**
 * Checks port 3055 before Spring starts (docs/architecture.md). The port is fixed: the plugin only connects to it.
 *
 * <p>{@link BindException} is handled: if another instance of this bridge holds the port
 * (typically a "zombie" after an IDE restart), it is stopped gracefully via
 * {@code POST /bridge/shutdown} and the port is reused. A foreign process is left alone with a clear error.
 */
final class PortGuard {

    static final String HOST = "127.0.0.1";
    static final int PORT = 3055;
    static final String SERVICE_ID = "figma-mcp-bridge";
    static final String TAKEOVER_HEADER = "X-Figma-Bridge-Takeover";
    private static final int MAX_WAIT_ATTEMPTS = 10;

    enum Policy { TAKEOVER, FAIL }

    static final class PortBusyException extends RuntimeException {
        PortBusyException(String message) {
            super(message);
        }
    }

    private PortGuard() {
    }

    static Policy policyFromEnv() {
        String v = System.getenv().getOrDefault("FIGMA_BRIDGE_PORT_CONFLICT", "takeover");
        return "fail".equals(v.toLowerCase(Locale.ROOT)) ? Policy.FAIL : Policy.TAKEOVER;
    }

    static void ensureFree(Policy policy) {
        if (isFree()) {
            return;
        }
        if (!isOurBridge()) {
            throw new PortBusyException("Port " + PORT + " is used by another process (not figma-mcp-bridge). "
                    + "Free it: lsof -i :" + PORT + " / netstat -ano | findstr " + PORT);
        }
        if (policy == Policy.FAIL) {
            throw new PortBusyException("Another figma-mcp-bridge already listens on " + HOST + ":" + PORT
                    + " (FIGMA_BRIDGE_PORT_CONFLICT=fail).");
        }
        System.err.println("[figma-mcp-bridge] port " + PORT + " held by a previous bridge instance, taking over");
        requestShutdown();
        for (int i = 1; i <= MAX_WAIT_ATTEMPTS; i++) {
            sleep(200L * i);
            if (isFree()) {
                return;
            }
        }
        throw new PortBusyException("Previous bridge did not release port " + PORT + " in time.");
    }

    static boolean isFree() {
        try (ServerSocket s = new ServerSocket()) {
            s.setReuseAddress(true);
            s.bind(new InetSocketAddress(HOST, PORT));
            return true;
        } catch (BindException e) {
            return false;
        } catch (IOException e) {
            return false;
        }
    }

    private static HttpClient http() {
        return HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build();
    }

    private static boolean isOurBridge() {
        try {
            HttpResponse<String> r = http().send(
                    HttpRequest.newBuilder(URI.create("http://" + HOST + ":" + PORT + "/bridge/health"))
                            .timeout(Duration.ofSeconds(2)).GET().build(),
                    HttpResponse.BodyHandlers.ofString());
            return r.statusCode() == 200 && r.body().contains("\"" + SERVICE_ID + "\"");
        } catch (IOException e) {
            return false;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    private static void requestShutdown() {
        try {
            http().send(HttpRequest.newBuilder(URI.create("http://" + HOST + ":" + PORT + "/bridge/shutdown"))
                            .timeout(Duration.ofSeconds(2))
                            .header(TAKEOVER_HEADER, "1")
                            .POST(HttpRequest.BodyPublishers.noBody()).build(),
                    HttpResponse.BodyHandlers.discarding());
        } catch (IOException e) {
            // the process may have exited before answering; keep checking the port
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
