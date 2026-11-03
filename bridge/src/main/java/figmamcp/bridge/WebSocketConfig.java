package figmamcp.bridge;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;
import org.springframework.web.socket.server.standard.ServletServerContainerFactoryBean;

@Configuration
@EnableWebSocket
public class WebSocketConfig implements WebSocketConfigurer {

    /** Base64 of a screenshot up to 5 MB is ~6.7 MB plus the JSON envelope. */
    private static final int MAX_TEXT_MESSAGE = 8 * 1024 * 1024;

    private final PluginSocketHandler handler;

    public WebSocketConfig(PluginSocketHandler handler) {
        this.handler = handler;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(handler, "/", "/ws")
                .addInterceptors(handler)
                // Origin is checked in PluginSocketHandler.beforeHandshake (the plugin iframe origin is "null").
                .setAllowedOriginPatterns("*");
    }

    @Bean
    public ServletServerContainerFactoryBean createWebSocketContainer() {
        ServletServerContainerFactoryBean c = new ServletServerContainerFactoryBean();
        c.setMaxTextMessageBufferSize(MAX_TEXT_MESSAGE);
        c.setMaxBinaryMessageBufferSize(64 * 1024);
        return c;
    }
}
