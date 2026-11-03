package figmamcp.bridge;

import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Duration;
import org.junit.jupiter.api.Test;

class BridgePropertiesTest {

    @Test
    void rejectsNonPositiveTimeouts() {
        Duration ok = Duration.ofSeconds(1);
        assertThatThrownBy(() -> new BridgeProperties(Duration.ZERO, ok, ok, true))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("bridge.request-timeout");
        assertThatThrownBy(() -> new BridgeProperties(ok, Duration.ofSeconds(-1), ok, true))
                .hasMessageContaining("bridge.screenshot-timeout");
        assertThatThrownBy(() -> new BridgeProperties(ok, ok, null, true))
                .hasMessageContaining("bridge.ping-interval");
    }
}
