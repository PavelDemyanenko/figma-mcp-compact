package figmamcp.bridge;

import java.util.Locale;
import java.util.Set;

/** "Local only" checks: protection against DNS rebinding and connections from third-party web pages. */
final class LocalOnly {

    private static final Set<String> HOSTS = Set.of("127.0.0.1:" + PortGuard.PORT, "localhost:" + PortGuard.PORT);

    private LocalOnly() {
    }

    static boolean isLocalHost(String hostHeader) {
        return hostHeader != null && HOSTS.contains(hostHeader.toLowerCase(Locale.ROOT));
    }

    /** The Figma plugin iframe has an opaque origin ("null"); Figma on the web is *.figma.com. */
    static boolean isAllowedOrigin(String origin) {
        if (origin == null || origin.isEmpty() || "null".equals(origin)) {
            return true;
        }
        String o = origin.toLowerCase(Locale.ROOT);
        return o.equals("https://figma.com") || (o.startsWith("https://") && o.endsWith(".figma.com"));
    }
}
