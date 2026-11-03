package figmamcp.bridge;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;

/**
 * figma_get_styles cache keyed by fileKey + fileVersion + prefix (the response depends on the prefix).
 * Invalidation: the figma/styles_invalidated notification (stylechange) or a hello with a new fileVersion.
 *
 * <p>Bounded: LRU of {@link #MAX_ENTRIES} entries and a TTL of {@link #TTL}: a designer opens dozens of
 * files a day, while invalidation only arrives from files that are open.
 */
@Component
public class StylesCache {

    static final int MAX_ENTRIES = 200;
    static final Duration TTL = Duration.ofHours(1);

    private record Key(String fileKey, String fileVersion, String prefix) {
    }

    private record Cached(JsonNode value, Instant storedAt) {
    }

    private final Clock clock;
    // access-order LinkedHashMap = LRU; accessed from MCP and WebSocket threads under one monitor.
    private final Map<Key, Cached> entries = new LinkedHashMap<>(64, 0.75f, true) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<Key, Cached> eldest) {
            return size() > MAX_ENTRIES;
        }
    };

    public StylesCache(Clock clock) {
        this.clock = clock;
    }

    public synchronized Optional<JsonNode> get(String fileKey, String fileVersion, String prefix) {
        Key key = new Key(fileKey, fileVersion, prefix);
        Cached e = entries.get(key);
        if (e == null) {
            return Optional.empty();
        }
        if (e.storedAt().plus(TTL).isBefore(clock.instant())) {
            entries.remove(key);
            return Optional.empty();
        }
        return Optional.of(e.value());
    }

    public synchronized void put(String fileKey, String fileVersion, String prefix, JsonNode value) {
        entries.put(new Key(fileKey, fileVersion, prefix), new Cached(value, clock.instant()));
    }

    public synchronized void invalidate(String fileKey) {
        entries.keySet().removeIf(k -> k.fileKey().equals(fileKey));
    }

    /** New file version: entries for other versions of this file are no longer needed. */
    public synchronized void retainVersion(String fileKey, String fileVersion) {
        entries.keySet().removeIf(k -> k.fileKey().equals(fileKey) && !k.fileVersion().equals(fileVersion));
    }

    synchronized int size() {
        return entries.size();
    }
}
