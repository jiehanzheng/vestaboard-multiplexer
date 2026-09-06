FROM node:22-slim AS build
WORKDIR /app

RUN corepack enable
COPY package.json pnpm-lock.yaml tsconfig.json ./
COPY src ./src
COPY test ./test
RUN pnpm install --frozen-lockfile
RUN pnpm build
# Keep runtime dependencies because the compiled Codex/config modules import zod.
RUN pnpm prune --prod

FROM node:22-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g @openai/codex && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./

USER node
CMD ["node", "dist/src/index.js"]
