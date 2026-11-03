package figmamcp.bridge;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

class PluginGatewayTest {

    private final JsonMapper mapper = JsonMapper.builder().build();
    private final StylesCache cache = new StylesCache(java.time.Clock.systemUTC());
    private final PluginGateway gateway = new PluginGateway(mapper, cache);
    private final ScheduledExecutorService exec = Executors.newSingleThreadScheduledExecutor();
    private final List<String> sent = new CopyOnWriteArrayList<>();

    @AfterEach
    void tearDown() {
        exec.shutdownNow();
    }

    /** Fake plugin: answers each request via reply(id). */
    private PluginSession plugin(String id, java.util.function.Function<JsonNode, String> reply) {
        return new PluginSession(id, text -> {
            sent.add(text);
            JsonNode req = mapper.readTree(text);
            String resp = reply.apply(req);
            if (resp != null) {
                exec.schedule(() -> gateway.onMessage(id, resp), 5, TimeUnit.MILLISECONDS);
            }
        });
    }

    @Test
    void correlatesResponseById() {
        gateway.register(plugin("s1", req -> "{\"jsonrpc\":\"2.0\",\"id\":\"" + req.get("id").asString()
                + "\",\"result\":\"1:2|Frame|FRAME|0\"}"));
        JsonNode r = gateway.call("figma_get_tree", Map.of("maxDepth", 1), Duration.ofSeconds(2));
        assertThat(r.asString()).isEqualTo("1:2|Frame|FRAME|0");
        assertThat(sent.getFirst()).contains("\"method\":\"figma_get_tree\"").contains("\"maxDepth\":1");
    }

    @Test
    void mapsPluginErrorToReason() {
        gateway.register(plugin("s1", req -> "{\"jsonrpc\":\"2.0\",\"id\":\"" + req.get("id").asString()
                + "\",\"error\":{\"code\":-32002,\"message\":\"too big\","
                + "\"data\":{\"reason\":\"SCREENSHOT_TOO_LARGE\",\"suggestedScale\":0.5}}}"));
        assertThatThrownBy(() -> gateway.call("figma_get_screenshot", Map.of("nodeId", "1:2"), Duration.ofSeconds(2)))
                .isInstanceOf(BridgeException.class)
                .hasMessageContaining("suggestedScale")
                .extracting(e -> ((BridgeException) e).reason()).isEqualTo("SCREENSHOT_TOO_LARGE");
    }

    @Test
    void timesOutWhenPluginIsSilent() {
        gateway.register(plugin("s1", req -> null));
        assertThatThrownBy(() -> gateway.call("figma_get_tree", Map.of(), Duration.ofMillis(100)))
                .extracting(e -> ((BridgeException) e).reason()).isEqualTo("TIMEOUT");
    }

    @Test
    void failsFastWithoutPlugin() {
        assertThatThrownBy(() -> gateway.call("figma_get_tree", Map.of(), Duration.ofSeconds(1)))
                .extracting(e -> ((BridgeException) e).reason()).isEqualTo("PLUGIN_NOT_CONNECTED");
    }

    @Test
    void failsPendingRequestsOnDisconnect() {
        gateway.register(plugin("s1", req -> {
            exec.schedule(() -> gateway.unregister("s1"), 10, TimeUnit.MILLISECONDS);
            return null;
        }));
        assertThatThrownBy(() -> gateway.call("figma_get_tree", Map.of(), Duration.ofSeconds(2)))
                .extracting(e -> ((BridgeException) e).reason()).isEqualTo("PLUGIN_DISCONNECTED");
    }

    @Test
    void activeSessionFollowsLatestUserActivity() {
        gateway.register(plugin("a", req -> null));
        gateway.register(plugin("b", req -> null));
        gateway.onMessage("a", "{\"jsonrpc\":\"2.0\",\"method\":\"figma/selection_changed\",\"params\":[\"1:1|X|FRAME\"]}");
        assertThat(gateway.active()).get().extracting(PluginSession::id).isEqualTo("a");
        assertThat(gateway.active().orElseThrow().selection()).containsExactly("1:1|X|FRAME");
        gateway.unregister("a");
        assertThat(gateway.active()).get().extracting(PluginSession::id).isEqualTo("b");
    }

    @Test
    void stylesInvalidationClearsCacheForFile() {
        gateway.register(plugin("s1", req -> null));
        gateway.onMessage("s1", "{\"jsonrpc\":\"2.0\",\"method\":\"figma/hello\",\"params\":{\"fileKey\":\"F\","
                + "\"fileVersion\":\"v1\",\"pageId\":\"0:1\",\"pageName\":\"Page\",\"selectionCount\":0}}");
        cache.put("F", "v1", "", mapper.readTree("{\"names\":[\"a\"]}"));
        gateway.onMessage("s1", "{\"jsonrpc\":\"2.0\",\"method\":\"figma/styles_invalidated\",\"params\":{\"timestamp\":1}}");
        assertThat(cache.get("F", "v1", "")).isEmpty();
    }

    @Test
    void ignoresGarbage() {
        gateway.register(plugin("s1", req -> null));
        gateway.onMessage("s1", "not json");
        gateway.onMessage("s1", "[1,2]");
        gateway.onMessage("s1", "{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32600,\"message\":\"x\"}}");
        gateway.onMessage("unknown", "{}");
        assertThat(gateway.active()).isPresent();
    }

    @Test
    void screenshotsRunOneAtATime() throws Exception {
        // The plugin hangs on the first screenshot; a parallel second one must get BUSY instead of reaching Figma.
        var firstSent = new java.util.concurrent.CountDownLatch(1);
        gateway.register(plugin("s1", req -> {
            firstSent.countDown();
            return null;
        }));
        var first = java.util.concurrent.CompletableFuture.runAsync(() -> {
            try {
                gateway.call("figma_get_screenshot", Map.of("nodeId", "1:1"), Duration.ofMillis(500));
            } catch (BridgeException ignored) {
                // the first one ends with a timeout, as expected
            }
        });
        assertThat(firstSent.await(2, TimeUnit.SECONDS)).isTrue();
        assertThatThrownBy(() -> gateway.call("figma_get_screenshot", Map.of("nodeId", "1:2"), Duration.ofMillis(100)))
                .extracting(e -> ((BridgeException) e).reason()).isEqualTo("BUSY");
        first.get();
        assertThat(sent).hasSize(1);
    }

    @Test
    void queueWaitCountsAgainstTheSameTimeout() {
        // The first screenshot holds the slot for 300 ms (silent plugin); the second, with a 500 ms budget, waits ~300 ms
        // in the queue and only gets the remainder (~200 ms) for the reply: ~500 ms in total, not 300 + 500.
        gateway.register(plugin("s1", req -> null));
        var first = java.util.concurrent.CompletableFuture.runAsync(() -> {
            try {
                gateway.call("figma_get_screenshot", Map.of("nodeId", "1:1"), Duration.ofMillis(300));
            } catch (BridgeException ignored) {
                // timeout, as expected
            }
        });
        long t0 = System.nanoTime();
        assertThatThrownBy(() -> gateway.call("figma_get_screenshot", Map.of("nodeId", "1:2"), Duration.ofMillis(500)))
                .isInstanceOf(BridgeException.class);
        long elapsedMs = (System.nanoTime() - t0) / 1_000_000;
        first.join();
        assertThat(elapsedMs).isLessThan(700);
    }
}
