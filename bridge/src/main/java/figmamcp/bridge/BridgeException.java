package figmamcp.bridge;

/** Tool call failure: reason is a machine-readable cause (like error.data.reason from the plugin). */
public class BridgeException extends RuntimeException {

    private final String reason;

    public BridgeException(String reason, String message) {
        super(message);
        this.reason = reason;
    }

    public String reason() {
        return reason;
    }
}
