package figmamcp.bridge;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

class StylesCacheTest {

    private final JsonMapper mapper = JsonMapper.builder().build();

    @Test
    void keyedByFileAndVersion() {
        StylesCache c = new StylesCache(java.time.Clock.systemUTC());
        c.put("F", "v1", "", mapper.readTree("[1]"));
        c.put("F", "v1", "M3/sys", mapper.readTree("[3]"));
        c.put("G", "v1", "", mapper.readTree("[2]"));
        assertThat(c.get("F", "v1", "")).isPresent();
        assertThat(c.get("F", "v1", "M3/sys")).get().hasToString("[3]");
        assertThat(c.get("F", "v1", "M3")).isEmpty();
        assertThat(c.get("F", "v2", "")).isEmpty();

        c.retainVersion("F", "v2");
        assertThat(c.get("F", "v1", "")).isEmpty();
        assertThat(c.get("F", "v1", "M3/sys")).isEmpty();
        assertThat(c.get("G", "v1", "")).isPresent();

        c.invalidate("G");
        assertThat(c.size()).isZero();
    }

    /** A clock the test moves by hand. */
    private static final class MutableClock extends Clock {
        private Instant now = Instant.parse("2026-11-03T10:00:00Z");

        @Override
        public java.time.ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(java.time.ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return now;
        }
    }

    @Test
    void expiresAfterTtl() {
        MutableClock clock = new MutableClock();
        StylesCache c = new StylesCache(clock);
        c.put("F", "v1", "", mapper.readTree("[1]"));
        clock.now = clock.now.plus(StylesCache.TTL.minus(Duration.ofMinutes(1)));
        assertThat(c.get("F", "v1", "")).isPresent();
        clock.now = clock.now.plus(Duration.ofMinutes(2));
        assertThat(c.get("F", "v1", "")).isEmpty();
    }

    @Test
    void evictsLeastRecentlyUsedBeyondLimit() {
        StylesCache c = new StylesCache(java.time.Clock.systemUTC());
        for (int i = 0; i < StylesCache.MAX_ENTRIES; i++) {
            c.put("F" + i, "v1", "", mapper.readTree("[" + i + "]"));
        }
        assertThat(c.get("F0", "v1", "")).isPresent(); // F0 becomes recently used
        c.put("NEW", "v1", "", mapper.readTree("[0]"));
        assertThat(c.size()).isEqualTo(StylesCache.MAX_ENTRIES);
        assertThat(c.get("F0", "v1", "")).isPresent();
        assertThat(c.get("F1", "v1", "")).isEmpty();
    }
}
