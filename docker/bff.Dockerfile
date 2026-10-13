# interop-playground/bff (10 §1, §2.4, §7.2): the BFF process (UI + REST + SSE on 3100, gateway
# listeners, one-shot `playground` CLI). Build context = repository root (.dockerignore applies).
# Requires apps/bff to have a `build` script producing dist/server.js and dist/cli.js (T-01/T-07).
# scripts/up.sh --no-build skips this image entirely.
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:1b3abbc0bf2421c8733f58c6fd7bbb961a960f37e05ed7369eccd1fbb0edcc84

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY . .
RUN npm ci --no-audit --no-fund \
 && npm run build \
 && npm prune --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    DATA_DIR=/data \
    FLOWS_DIR=/app/flows \
    CONFIG_DIR=/config
WORKDIR /app
COPY --from=build /app /app
RUN printf '#!/bin/sh\nexec node /app/apps/bff/dist/cli.js "$@"\n' > /usr/local/bin/playground \
 && chmod 0755 /usr/local/bin/playground \
 && mkdir -p /data /datashare \
 && chown node:node /data /datashare
USER node
EXPOSE 3100
CMD ["node", "/app/apps/bff/dist/server.js"]
