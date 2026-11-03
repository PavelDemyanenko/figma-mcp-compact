package figmamcp.bridge;

import jakarta.servlet.http.HttpServletRequest;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** Service endpoints: health (diagnostics) and shutdown (hand the port over to a newer instance, docs/architecture.md). */
@RestController
@RequestMapping("/bridge")
public class BridgeControlController {

    private static final Logger log = LoggerFactory.getLogger(BridgeControlController.class);

    private final PluginGateway gateway;
    private final Shutdown shutdown;

    public BridgeControlController(PluginGateway gateway, Shutdown shutdown) {
        this.gateway = gateway;
        this.shutdown = shutdown;
    }

    @GetMapping("/health")
    public ResponseEntity<Map<String, Object>> health(HttpServletRequest request) {
        if (!LocalOnly.isLocalHost(request.getHeader("Host"))) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("service", PortGuard.SERVICE_ID);
        body.put("pid", ProcessHandle.current().pid());
        List<Map<String, Object>> plugins = gateway.sessions().stream().map(s -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("session", s.id());
            if (s.hello() != null) {
                m.put("fileKey", s.hello().fileKey());
                m.put("page", s.hello().pageName());
            }
            m.put("active", gateway.active().map(a -> a.id().equals(s.id())).orElse(false));
            return m;
        }).toList();
        body.put("plugins", plugins);
        return ResponseEntity.ok(body);
    }

    /**
     * A non-standard header makes the request "non-simple": a browser must send a CORS preflight, which is
     * never allowed, so a third-party web page cannot shut the bridge down.
     */
    @PostMapping("/shutdown")
    public ResponseEntity<Void> shutdown(HttpServletRequest request) {
        if (!LocalOnly.isLocalHost(request.getHeader("Host"))
                || !"1".equals(request.getHeader(PortGuard.TAKEOVER_HEADER))) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        log.warn("shutdown requested by a newer bridge instance (port takeover)");
        shutdown.exitAsync(0);
        return ResponseEntity.accepted().build();
    }
}
