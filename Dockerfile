# syntax=docker/dockerfile:1

FROM node:22.23.4-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm build \
 && pnpm --filter server --prod deploy --legacy /out/server

FROM node:22.23.4-slim AS runtime
ENV NODE_ENV=production \
    HACM_HOST=0.0.0.0 \
    HACM_PORT=3000 \
    HACM_DATA_DIR=/data \
    HACM_STATE_DIR=/state \
    HACM_WEB_DIR=/app/web
WORKDIR /app
COPY --from=build --chown=node:node /out/server /app/server
COPY --from=build --chown=node:node /repo/packages/web/dist /app/web
RUN mkdir -p /data /state && chown node:node /data /state
USER node
VOLUME ["/data", "/state"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.HACM_PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "/app/server/bin/server.mjs"]
