# interop-playground/bff (10 §1, §2.4, §7.2): the BFF process (UI + REST + SSE on 3100, later the
# gateway listeners) and the one-shot `playground` CLI (10 §8.2). Build context = repository root
# (.dockerignore applies). The TypeScript sources run through tsx (ADR-60: the workspaces stay
# declaration-only per ADR-52 and resolve each other's `src/*.ts`, so there is no JS emit step).
# scripts/up.sh --no-build skips this image entirely.
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:1b3abbc0bf2421c8733f58c6fd7bbb961a960f37e05ed7369eccd1fbb0edcc84

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY . .
# Not needed at run time: the JVM sidecar sources, research copies, repo tests and docs.
# --ignore-scripts: better-sqlite3 13 ships linux-x64 prebuilds in its tarball, but npm 10.9.9
# would run a default `node-gyp rebuild` (no python/g++ in the slim image); no other dependency
# needs an install script (esbuild resolves its binary through optionalDependencies).
RUN rm -rf sidecar fixtures e2e tests docs deliverables .github \
 && npm ci --no-audit --no-fund --ignore-scripts \
 && node -e "new (require('better-sqlite3'))(':memory:').prepare('select 1').get()"
# The SPA (session/T-13 output). A broken or missing UI build must not block the BFF image: the
# BFF serves whatever apps/ui/dist exists and answers a 404 envelope otherwise (T-07).
RUN (npm run build -w @interop-playground/ui && test -f apps/ui/dist/index.html) \
 || { echo "WARNING: UI build failed; the image serves no SPA" >&2; rm -rf apps/ui/dist; }

FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    BFF_LISTEN_HOST=0.0.0.0 \
    DATA_DIR=/data \
    FLOWS_DIR=/app/flows \
    FINGERPRINTS_DIR=/app/fingerprints \
    CONFIG_DIR=/config \
    UI_DIST_DIR=/app/apps/ui/dist
WORKDIR /app
COPY --from=build /app /app
RUN printf '#!/bin/sh\nexec node --import tsx /app/apps/bff/src/cli.ts "$@"\n' > /usr/local/bin/playground \
 && chmod 0755 /usr/local/bin/playground \
 && mkdir -p /data /datashare \
 && chown node:node /data /datashare
USER node
# inside the container the BFF binds 0.0.0.0:3100; compose publishes it on 127.0.0.1 only (10 §7.3)
EXPOSE 3100
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=30 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3100/api/v1/health').then(r=>process.exit(r.status===200?0:1),()=>process.exit(1))"]
CMD ["node", "--import", "tsx", "/app/apps/bff/src/server.ts"]
