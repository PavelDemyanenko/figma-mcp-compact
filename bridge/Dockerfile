# Figma MCP Compact bridge image (docs/architecture.md, Docker). Build the jar first: mvn package
#   docker build -t figma-mcp-bridge .
# Started by the MCP host (stdio via -i); the port is published on the host loopback only:
#   docker run -i --rm -p 127.0.0.1:3055:3055 figma-mcp-bridge

FROM eclipse-temurin:25-jre-noble AS extract
WORKDIR /extract
COPY target/figma-mcp-bridge-*.jar app.jar
# Layers: dependencies change rarely and stay cached by Docker; a code change rebuilds only the application layer
RUN java -Djarmode=tools -jar app.jar extract --layers --destination layers

FROM eclipse-temurin:25-jre-noble
RUN groupadd --system app && useradd --system --gid app --home /app app
WORKDIR /app
COPY --from=extract --chown=app:app /extract/layers/dependencies/ ./
COPY --from=extract --chown=app:app /extract/layers/spring-boot-loader/ ./
COPY --from=extract --chown=app:app /extract/layers/snapshot-dependencies/ ./
COPY --from=extract --chown=app:app /extract/layers/application/ ./
# AOT cache: the MCP host starts the bridge for every session, so cold start matters.
# The training run starts the context and exits; stdin is empty, so exit-on-EOF is disabled.
# GC/object-header flags must match ENTRYPOINT, otherwise the JVM discards the cache.
RUN java -XX:+UseSerialGC -XX:+UseCompactObjectHeaders -XX:AOTCacheOutput=app.aot \
        -Dspring.context.exit=onRefresh -Dbridge.exit-on-stdin-eof=false \
        -jar app.jar < /dev/null
USER app
# Inside the container listen on all container interfaces; outside it is published only as 127.0.0.1:3055 (docker run -p).
ENV BRIDGE_ADDRESS=0.0.0.0
EXPOSE 3055
# exec: java is PID 1, receives the MCP host stdin and SIGTERM from docker stop. JAVA_OPTS: runtime flags.
ENTRYPOINT ["sh", "-c", "exec java -XX:+UseSerialGC -XX:+UseCompactObjectHeaders -XX:AOTCache=app.aot $JAVA_OPTS -jar app.jar"]
