package figmamcp.bridge;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class LocalOnlyTest {

    @Test
    void acceptsOnlyLocalHostHeaders() {
        assertThat(LocalOnly.isLocalHost("127.0.0.1:3055")).isTrue();
        assertThat(LocalOnly.isLocalHost("LOCALHOST:3055")).isTrue();
        assertThat(LocalOnly.isLocalHost("evil.example:3055")).isFalse();
        assertThat(LocalOnly.isLocalHost(null)).isFalse();
    }

    @Test
    void acceptsFigmaPluginOrigins() {
        assertThat(LocalOnly.isAllowedOrigin("null")).isTrue();
        assertThat(LocalOnly.isAllowedOrigin(null)).isTrue();
        assertThat(LocalOnly.isAllowedOrigin("https://www.figma.com")).isTrue();
        assertThat(LocalOnly.isAllowedOrigin("https://evil.com")).isFalse();
        assertThat(LocalOnly.isAllowedOrigin("https://notfigma.com")).isFalse();
        assertThat(LocalOnly.isAllowedOrigin("http://www.figma.com")).isFalse();
    }
}
