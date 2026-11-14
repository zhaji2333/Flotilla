# Independent SPA: static build served by nginx; /api is proxied to the
# standalone API service. The SPA logs in with a session cookie (ADR-0038);
# the optional API_LEGACY_TOKEN is only attached for non-browser automation.
FROM node:24-slim AS build
WORKDIR /app
ARG NPM_REGISTRY=https://registry.npmmirror.com
ENV COREPACK_NPM_REGISTRY=$NPM_REGISTRY
RUN corepack enable && corepack prepare pnpm@11.22.0 --activate && pnpm config set registry $NPM_REGISTRY
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/frontend/package.json packages/frontend/package.json
RUN pnpm install --frozen-lockfile --trust-lockfile --filter @src-agent/frontend...
COPY packages/frontend packages/frontend
RUN pnpm --filter @src-agent/frontend build

FROM nginx:1.27-alpine
COPY packages/frontend/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/packages/frontend/dist /usr/share/nginx/html
EXPOSE 80
