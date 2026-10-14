FROM node:24-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
# Next loads auth handlers while collecting routes. Use an ephemeral build-only
# signing value; real credentials are supplied exclusively at container startup.
RUN node --input-type=module -e 'import { randomBytes } from "node:crypto"; import { spawnSync } from "node:child_process"; const result = spawnSync("pnpm", ["build"], { stdio: "inherit", env: { ...process.env, BETTER_AUTH_SECRET: randomBytes(40).toString("base64url") } }); process.exit(result.status ?? 1);'

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=8080
# Worker uses the existing TypeScript runner; no additional runtime service is needed.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next/standalone ./.next/standalone
COPY --from=build --chown=node:node /app/.next/static ./.next/standalone/.next/static
COPY --from=build --chown=node:node /app/public ./.next/standalone/public
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/scripts ./scripts
COPY --from=build --chown=node:node /app/package.json /app/tsconfig.json ./
RUN mkdir -p /app/outputs/implementation-qa && chown -R node:node /app/outputs
USER node
EXPOSE 8080
ENTRYPOINT ["node", "scripts/runtime-entrypoint.mjs"]
CMD ["app-worker"]
