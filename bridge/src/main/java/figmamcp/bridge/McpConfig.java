package figmamcp.bridge;

import io.modelcontextprotocol.json.jackson3.JacksonMcpJsonMapper;
import io.modelcontextprotocol.server.McpServerFeatures.SyncToolSpecification;
import io.modelcontextprotocol.server.transport.StdioServerTransportProvider;
import io.modelcontextprotocol.spec.McpServerTransportProviderBase;
import java.io.InputStream;
import java.time.Clock;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import tools.jackson.databind.json.JsonMapper;

@Configuration
public class McpConfig {

    private static final Logger log = LoggerFactory.getLogger(McpConfig.class);

    /**
     * Replaces the Spring AI stdio transport (@ConditionalOnMissingBean): the same StdioServerTransportProvider,
     * but EOF on stdin ends the process. Otherwise Tomcat keeps the JVM alive and a "zombie" holds port 3055.
     */
    @Bean
    public McpServerTransportProviderBase stdioServerTransport(JsonMapper jsonMapper, Shutdown shutdown,
                                                               BridgeProperties props) {
        InputStream in = props.exitOnStdinEof()
                ? new EofAwareInputStream(System.in, () -> {
                    log.info("MCP host closed stdin — shutting down");
                    shutdown.exitAsync(0);
                })
                : System.in;
        return new StdioServerTransportProvider(new JacksonMcpJsonMapper(jsonMapper), in, System.out);
    }

    /** Clock as a bean: StylesCache (TTL) gets it via its constructor, tests pass their own. */
    @Bean
    public Clock clock() {
        return Clock.systemUTC();
    }

    @Bean
    public List<SyncToolSpecification> figmaToolSpecifications(FigmaTools tools) {
        return tools.specifications();
    }
}
