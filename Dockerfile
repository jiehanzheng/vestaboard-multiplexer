FROM node:22-slim AS build
WORKDIR /app

RUN corepack enable
COPY package.json pnpm-lock.yaml tsconfig.json ./
COPY src ./src
COPY test ./test
COPY web ./web
COPY vite.config.ts tsconfig.web.json ./
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:22-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g @openai/codex && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY package.json ./

RUN mkdir -p /app/data && chown node:node /app/data

USER node
CMD ["node", "dist/src/index.js"]
