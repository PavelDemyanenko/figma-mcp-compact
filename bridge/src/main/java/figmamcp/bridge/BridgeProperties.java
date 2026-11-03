package figmamcp.bridge;

import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

/**
 * @param requestTimeout     timeout of a regular RPC to the plugin
 * @param screenshotTimeout  figma_get_screenshot timeout (the plugin caps exportAsync at 10s, plus ~7 MB transfer)
 * @param pingInterval       WebSocket ping interval used to detect dead connections
 */
@ConfigurationProperties("bridge")
public record BridgeProperties(
        @DefaultValue("15s") Duration requestTimeout,
        @DefaultValue("30s") Duration screenshotTimeout,
        @DefaultValue("25s") Duration pingInterval,
        @DefaultValue("true") boolean exitOnStdinEof) {

    /** Validated at startup: a bad setting gives a clear error instead of hanging calls. */
    public BridgeProperties {
        requirePositive("bridge.request-timeout", requestTimeout);
        requirePositive("bridge.screenshot-timeout", screenshotTimeout);
        requirePositive("bridge.ping-interval", pingInterval);
    }

    private static void requirePositive(String name, Duration d) {
        if (d == null || d.isNegative() || d.isZero()) {
            throw new IllegalArgumentException(name + " must be a positive duration, got " + d);
        }
    }
}
