FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm install --global pnpm@11.25.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY workers/image-service/package.json ./workers/image-service/package.json
COPY workers/notification-worker/package.json ./workers/notification-worker/package.json
COPY workers/message-worker/package.json ./workers/message-worker/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/scripts/spreadsheet-runtime-smoke.mjs ./scripts/spreadsheet-runtime-smoke.mjs
USER node
EXPOSE 3000
CMD ["node","server.js"]
