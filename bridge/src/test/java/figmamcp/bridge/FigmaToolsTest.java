package figmamcp.bridge;

import static org.assertj.core.api.Assertions.assertThat;

import io.modelcontextprotocol.server.McpServerFeatures.SyncToolSpecification;
import io.modelcontextprotocol.spec.McpSchema.CallToolRequest;
import io.modelcontextprotocol.spec.McpSchema.CallToolResult;
import io.modelcontextprotocol.spec.McpSchema.ImageContent;
import io.modelcontextprotocol.spec.McpSchema.TextContent;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.function.Function;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** FigmaTools on top of a real PluginGateway and a fake plugin (no Spring context). */
class FigmaToolsTest {

    private final JsonMapper mapper = JsonMapper.builder().build();
    private final StylesCache cache = new StylesCache(java.time.Clock.systemUTC());
    private final PluginGateway gateway = new PluginGateway(mapper, cache);
    private final BridgeProperties props = new BridgeProperties(
            Duration.ofSeconds(2), Duration.ofSeconds(2), Duration.ofSeconds(25), true);
    private final FigmaTools tools = new FigmaTools(gateway, cache, mapper, props);
    private final ScheduledExecutorService exec = Executors.newSingleThreadScheduledExecutor();
    private final List<JsonNode> received = new CopyOnWriteArrayList<>();

    @AfterEach
    void tearDown() {
        exec.shutdownNow();
    }

    /** The plugin answers with a result computed from the request (or an error if the string starts with "{\"error\""). */
    private void plugin(String id, Function<JsonNode, String> resultJson) {
        gateway.register(new PluginSession(id, text -> {
            JsonNode req = mapper.readTree(text);
            received.add(req);
            String body = resultJson.apply(req);
            String resp = body.startsWith("{\"error\"")
                    ? "{\"jsonrpc\":\"2.0\",\"id\":\"" + req.get("id").asString() + "\"," + body.substring(1)
                    : "{\"jsonrpc\":\"2.0\",\"id\":\"" + req.get("id").asString() + "\",\"result\":" + body + "}";
            exec.schedule(() -> gateway.onMessage(id, resp), 5, TimeUnit.MILLISECONDS);
        }));
    }

    private void hello(String sessionId, String fileKey) {
        gateway.onMessage(sessionId, "{\"jsonrpc\":\"2.0\",\"method\":\"figma/hello\",\"params\":{\"fileKey\":\""
                + fileKey + "\",\"fileVersion\":\"v1\",\"pageId\":\"0:1\",\"pageName\":\"P\",\"selectionCount\":0}}");
    }

    private SyncToolSpecification spec(String name) {
        return tools.specifications().stream().filter(s -> s.tool().name().equals(name)).findFirst().orElseThrow();
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> property(String tool, String name) {
        Map<String, Object> props = (Map<String, Object>) spec(tool).tool().inputSchema().get("properties");
        return (Map<String, Object>) props.get(name);
    }

    private CallToolResult call(String name, Map<String, Object> args) {
        return spec(name).callHandler().apply(null, new CallToolRequest(name, args));
    }

    private static String text(CallToolResult r) {
        return ((TextContent) r.content().getFirst()).text();
    }

    @Test
    void toolsAreCostOrderedWithStrictSchemas() {
        assertThat(tools.specifications()).extracting(s -> s.tool().name()).containsExactly(
                "figma_get_selection", "figma_get_tree", "figma_get_text", "figma_get_styles",
                "figma_inspect_node", "figma_get_screenshot");
        tools.specifications().forEach(s -> assertThat(s.tool().inputSchema()).containsEntry("additionalProperties", false));

        assertThat(property("figma_get_tree", "maxDepth")).containsEntry("minimum", 0).containsEntry("maximum", 10);
        assertThat(property("figma_inspect_node", "level")).containsEntry("enum", List.of(0, 1, 2));
        assertThat(property("figma_get_screenshot", "scale")).containsEntry("minimum", 0.01).containsEntry("maximum", 4);
        assertThat(property("figma_get_screenshot", "nodeId")).containsEntry("maxLength", 256);
        assertThat(spec("figma_inspect_node").tool().inputSchema()).containsEntry("required", List.of("nodeId"));
        assertThat(spec("figma_get_text").tool().description()).contains("untrusted");
    }

    @Test
    void selectionEmptyAndNonEmpty() {
        plugin("s1", req -> "[]");
        assertThat(text(call("figma_get_selection", Map.of()))).isEqualTo("[]");
        gateway.unregister("s1");
        plugin("s2", req -> "[\"1:2|Header|FRAME\",\"1:3|Button|INSTANCE\"]");
        assertThat(text(call("figma_get_selection", Map.of()))).isEqualTo("1:2|Header|FRAME\n1:3|Button|INSTANCE");
    }

    @Test
    void passesOnlyKnownParams() {
        plugin("s1", req -> "\"0:1|Page|PAGE|0\"");
        CallToolResult r = call("figma_get_tree", Map.of("nodeId", "0:1", "maxDepth", 1, "evil", "x"));
        assertThat(text(r)).isEqualTo("0:1|Page|PAGE|0");
        JsonNode params = received.getFirst().get("params");
        assertThat(params.has("evil")).isFalse();
        assertThat(params.get("maxDepth").asInt()).isEqualTo(1);
    }

    @Test
    void stylesAreCachedPerPrefix() {
        plugin("s1", req -> "{\"names\":[\"a\"]}");
        hello("s1", "F");
        call("figma_get_styles", Map.of());
        call("figma_get_styles", Map.of());
        call("figma_get_styles", Map.of("prefix", "M3"));
        assertThat(received).hasSize(2);
        assertThat(received.get(1).get("params").get("prefix").asString()).isEqualTo("M3");
    }

    @Test
    void stylesCacheKeyFollowsTheSessionThatAnswered() {
        // Regression guard: the cache key and the request come from ONE session (call(session, ...)).
        // The original race window (between reading hello and picking the session in call) cannot be reproduced
        // deterministically; here the active session changes while a request to A is in flight, so the result must be cached under file A.
        plugin("B", req -> "{\"names\":[\"b\"]}");
        hello("B", "FILE_B");
        plugin("A", req -> {
            gateway.onMessage("B", "{\"jsonrpc\":\"2.0\",\"method\":\"figma/selection_changed\",\"params\":[]}");
            return "{\"names\":[\"a\"]}";
        });
        hello("A", "FILE_A");

        assertThat(text(call("figma_get_styles", Map.of()))).isEqualTo("{\"names\":[\"a\"]}");
        assertThat(cache.get("FILE_A", "v1", "")).get().hasToString("{\"names\":[\"a\"]}");
        assertThat(cache.get("FILE_B", "v1", "")).isEmpty();
    }

    @Test
    void screenshotIsMcpImageContent() {
        plugin("s1", req -> "{\"mimeType\":\"image/png\",\"width\":2,\"height\":3,\"size\":2048,\"data\":\"iVBORw0KGgo=\"}");
        CallToolResult r = call("figma_get_screenshot", Map.of("nodeId", "1:2"));
        assertThat(r.isError()).isFalse();
        ImageContent img = (ImageContent) r.content().get(0);
        assertThat(img.data()).isEqualTo("iVBORw0KGgo=");
        assertThat(img.mimeType()).isEqualTo("image/png");
        assertThat(((TextContent) r.content().get(1)).text()).isEqualTo("PNG 2x3, 2 KB");
    }

    @Test
    void pluginErrorsBecomeToolErrorsWithReason() {
        plugin("s1", req -> "{\"error\":{\"code\":-32001,\"message\":\"Node 9:9 not found\","
                + "\"data\":{\"reason\":\"NODE_NOT_FOUND\",\"nodeId\":\"9:9\"}}}");
        CallToolResult r = call("figma_inspect_node", Map.of("nodeId", "9:9"));
        assertThat(r.isError()).isTrue();
        assertThat(text(r)).startsWith("NODE_NOT_FOUND: Node 9:9 not found");
    }

    @Test
    void notConnectedIsAToolError() {
        CallToolResult r = call("figma_get_tree", Map.of());
        assertThat(r.isError()).isTrue();
        assertThat(text(r)).startsWith("PLUGIN_NOT_CONNECTED");
    }
}
