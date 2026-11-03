package figmamcp.bridge;

import java.util.concurrent.atomic.AtomicBoolean;
import org.springframework.boot.SpringApplication;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.stereotype.Component;

/** Graceful process exit (close the context -> release the port) from any thread. */
@Component
public class Shutdown {

    private final ConfigurableApplicationContext context;
    private final AtomicBoolean started = new AtomicBoolean();

    public Shutdown(ConfigurableApplicationContext context) {
        this.context = context;
    }

    public void exitAsync(int code) {
        if (!started.compareAndSet(false, true)) {
            return;
        }
        Thread t = new Thread(() -> {
            try {
                Thread.sleep(150); // let the HTTP response go out
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            System.exit(SpringApplication.exit(context, () -> code));
        }, "bridge-shutdown");
        t.setDaemon(false);
        t.start();
    }
}
