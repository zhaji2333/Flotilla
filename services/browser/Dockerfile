# SRC-Agent isolated browser capability service.
# Chromium is intentionally sandboxless inside this disposable container:
# the container has no DB/provider credentials, no host mounts, drops all
# capabilities, and reaches the target only through the audited egress proxy.
FROM node:24-bookworm-slim

ARG NPM_REGISTRY=https://registry.npmmirror.com
ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    BROWSER_CHROMIUM_PATH=/usr/bin/chromium \
    npm_config_registry=${NPM_REGISTRY} \
    HOME=/home/browser

RUN corepack enable && corepack prepare pnpm@11.22.0 --activate
WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY services/browser/package.json services/browser/
RUN pnpm install --frozen-lockfile --filter @src-agent/browser-service... --trust-lockfile --registry="${NPM_REGISTRY}"

# Use Debian's Chromium package rather than Playwright CDN downloads: it is
# reproducible from the distro mirror and avoids transient CDN DNS failures.
RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium \
    && rm -rf /var/lib/apt/lists/*

COPY services/browser/src services/browser/src
COPY services/browser/tsconfig.json services/browser/vitest.config.ts services/browser/

RUN groupadd -g 10003 browser || true
RUN id -u browser >/dev/null 2>&1 || useradd --create-home --uid 10003 --gid browser --shell /bin/bash browser
RUN mkdir -p /home/browser /artifacts
RUN chown -R browser:browser /app /home/browser /artifacts
# Playwright's browser bundle is already world-readable; avoid recursive chmod
# over its symlinked layout.

USER browser
WORKDIR /app/services/browser
EXPOSE 9401
CMD ["node", "--import", "tsx", "src/server.ts"]
