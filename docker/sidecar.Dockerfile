# JVM sidecar image (plan/10 section 6). Build context: ./sidecar (compose: context: sidecar, dockerfile: ../docker/sidecar.Dockerfile).
# Stage 1 needs network (Gradle wrapper, Maven Central, Google, Danube Tech, JitPack).
FROM eclipse-temurin:21-jdk-jammy@sha256:e0c60c487345d1dc9d0fc7b6f0496f3cc941e5132e09296cc17a6decc71b902b AS build
WORKDIR /build
COPY gradlew settings.gradle.kts build.gradle.kts gradle.lockfile ./
COPY gradle ./gradle
COPY src ./src
RUN chmod +x gradlew && ./gradlew --no-daemon shadowJar

FROM eclipse-temurin:21-jre-jammy@sha256:f04fb34e053148344e83317976114ec3f37e4b830ec8bdab5a2fe3cecd7d010b
WORKDIR /app
COPY --from=build /build/build/libs/sidecar-all.jar /app/sidecar-all.jar
# Truststore: the compose file sets JAVA_TOOL_OPTIONS (JDK cacerts + local CA, plan/10 section 7.4); nothing is baked in.
USER 10001
EXPOSE 7070
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/7070 && printf 'GET /health HTTP/1.0\\r\\n\\r\\n' >&3 && grep -q '\"status\":\"ok\"' <&3"]
ENTRYPOINT ["java", "-jar", "/app/sidecar-all.jar", "serve", "7070"]
