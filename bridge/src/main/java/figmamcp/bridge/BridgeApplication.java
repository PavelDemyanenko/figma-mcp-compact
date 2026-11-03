package figmamcp.bridge;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * Figma MCP Compact bridge: an MCP server (stdio) for Cursor / Claude + a WebSocket server on 127.0.0.1:3055
 * for the Figma plugin. stdout belongs to the MCP protocol, so all logs go to stderr (logback-spring.xml).
 */
@SpringBootApplication
@ConfigurationPropertiesScan
@EnableScheduling
public class BridgeApplication {

    public static void main(String[] args) {
        try {
            PortGuard.ensureFree(PortGuard.policyFromEnv());
        } catch (PortGuard.PortBusyException e) {
            System.err.println("[figma-mcp-bridge] " + e.getMessage());
            System.exit(2);
        }
        SpringApplication.run(BridgeApplication.class, args);
    }
}
