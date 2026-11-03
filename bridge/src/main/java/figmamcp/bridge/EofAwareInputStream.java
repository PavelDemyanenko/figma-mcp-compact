package figmamcp.bridge;

import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.concurrent.atomic.AtomicBoolean;

/** stdin that reports EOF: the MCP host closed stdio -> the bridge exits and releases port 3055. */
final class EofAwareInputStream extends FilterInputStream {

    private final Runnable onEof;
    private final AtomicBoolean fired = new AtomicBoolean();

    EofAwareInputStream(InputStream in, Runnable onEof) {
        super(in);
        this.onEof = onEof;
    }

    @Override
    public int read() throws IOException {
        return check(super.read());
    }

    @Override
    public int read(byte[] b, int off, int len) throws IOException {
        return check(super.read(b, off, len));
    }

    private int check(int r) {
        if (r == -1 && fired.compareAndSet(false, true)) {
            onEof.run();
        }
        return r;
    }
}
