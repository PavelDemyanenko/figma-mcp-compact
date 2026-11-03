package figmamcp.bridge;

import java.io.IOException;
import java.time.Instant;
import java.util.List;

/** One plugin connection (one open Figma file) and its last known state. */
public final class PluginSession {

    @FunctionalInterface
    public interface Sender {
        void send(String text) throws IOException;
    }

    public record Hello(String fileKey, String fileVersion, String pageId, String pageName, int selectionCount,
                        String pluginVersion) {
    }

    private final String id;
    private final Sender sender;
    private final Instant connectedAt = Instant.now();
    private volatile Hello hello;
    private volatile List<String> selection = List.of();
    private volatile Instant lastActivity = Instant.now();

    public PluginSession(String id, Sender sender) {
        this.id = id;
        this.sender = sender;
    }

    public String id() {
        return id;
    }

    public void send(String text) throws IOException {
        sender.send(text);
    }

    public Hello hello() {
        return hello;
    }

    void hello(Hello h) {
        this.hello = h;
        touch();
    }

    public List<String> selection() {
        return selection;
    }

    void selection(List<String> s) {
        this.selection = List.copyOf(s);
        touch();
    }

    public Instant connectedAt() {
        return connectedAt;
    }

    public Instant lastActivity() {
        return lastActivity;
    }

    void touch() {
        lastActivity = Instant.now();
    }

    String describe() {
        Hello h = hello;
        return h == null ? id : id + " (" + h.fileKey() + ", page " + h.pageName() + ")";
    }
}
