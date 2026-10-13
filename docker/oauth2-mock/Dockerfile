# interop-playground/oauth2-mock (10 §2.4): node:22-bookworm-slim + oauth2-mock-server 9.2.0 (S-025)
FROM node:22-bookworm-slim@sha256:1b3abbc0bf2421c8733f58c6fd7bbb961a960f37e05ed7369eccd1fbb0edcc84
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server.mjs ./
USER node
EXPOSE 8095
CMD ["node", "server.mjs"]
