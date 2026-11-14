FROM node:24-bookworm-slim
ARG NPM_REGISTRY=https://registry.npmmirror.com
ENV NODE_ENV=production \
    npm_config_registry=${NPM_REGISTRY}
RUN corepack enable && corepack prepare pnpm@11.22.0 --activate
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/tool-gateway/package.json packages/tool-gateway/
COPY packages/control-plane/package.json packages/control-plane/
COPY packages/api/package.json packages/api/
RUN pnpm install --frozen-lockfile --trust-lockfile --filter @src-agent/api... --registry="${NPM_REGISTRY}"
COPY packages/contracts/src packages/contracts/src
COPY packages/contracts/tsconfig.json packages/contracts/
COPY packages/tool-gateway/src packages/tool-gateway/src
COPY packages/tool-gateway/tsconfig.json packages/tool-gateway/
COPY packages/control-plane/src packages/control-plane/src
COPY packages/control-plane/tsconfig.json packages/control-plane/
COPY packages/api/src packages/api/src
COPY packages/api/tsconfig.json packages/api/
RUN groupadd -g 10002 api \
    && groupadd -g 10003 artifacts \
    && useradd --create-home --uid 10002 --gid api --groups artifacts --shell /bin/bash api \
    && chown -R api:api /app
USER api
WORKDIR /app/packages/api
CMD ["node_modules/.bin/tsx", "src/server.ts"]
