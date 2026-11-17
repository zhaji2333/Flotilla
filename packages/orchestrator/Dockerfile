# syntax=docker/dockerfile:1
# SRC-Agent worker image.
#
# The worker is a general task executor. The agent loop, tool protocol, context
# compaction, skills, subagents and MCP support come from DeepSeek Harness
# (`@deepseek-ai/dsh`, pinned); SRC-Agent adds the mission tools, scope guard,
# evidence capture and the audited egress proxy.
FROM node:24-bookworm-slim

# Registry mirrors are build args so a contributor behind a slow upstream can
# point the build at a local mirror without editing the Dockerfile.
ARG APT_MIRROR=deb.debian.org
ARG PIP_INDEX_URL=https://pypi.org/simple
ARG NPM_REGISTRY=https://registry.npmmirror.com

ENV DEBIAN_FRONTEND=noninteractive \
    npm_config_registry=${NPM_REGISTRY} \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    NODE_ENV=production \
    HOME=/home/worker \
    SSL_CERT_FILE=/certs/ca.pem \
    REQUESTS_CA_BUNDLE=/certs/ca.pem \
    NODE_EXTRA_CA_CERTS=/certs/ca.pem \
    CURL_CA_BUNDLE=/certs/ca.pem \
    GIT_SSL_CAINFO=/certs/ca.pem

# Base toolchain for security-testing workers. All network-capable tools are
# expected to inherit HTTP_PROXY/HTTPS_PROXY from the compose environment, so
# outbound traffic from bash scripts still transits the audited proxy.
RUN if [ "${APT_MIRROR}" != "deb.debian.org" ]; then \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/*.sources /etc/apt/sources.list 2>/dev/null || true; \
    fi \
    && apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl wget git jq bash coreutils less procps \
    python3 python3-pip python3-venv python3-dev \
    openssl dnsutils iproute2 netcat-openbsd nmap sqlite3 \
    unzip xxd file binutils \
    build-essential pkg-config \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3 /usr/local/bin/python \
    && python3 --version && pip3 --version

# Python libraries the agent commonly needs for crypto, encoding, HTTP parsing
# and binary/APK analysis. Kept small enough to build quickly.
# The runtime CA env points at the proxy mount, which does not exist at build
# time; point the build-time package manager at the system trust store.
RUN SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt \
    CURL_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt \
    pip3 install --break-system-packages --index-url "${PIP_INDEX_URL}" \
    requests httpx pycryptodome cryptography pyyaml \
    beautifulsoup4 lxml

RUN corepack enable && corepack prepare pnpm@11.22.0 --activate

WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/tool-gateway/package.json packages/tool-gateway/
COPY packages/control-plane/package.json packages/control-plane/
COPY packages/curator/package.json packages/curator/
COPY packages/harness-plugin/package.json packages/harness-plugin/
COPY packages/orchestrator/package.json packages/orchestrator/
COPY services/browser/package.json services/browser/

# --trust-lockfile: the committed lockfile is reviewed in git; pnpm 11's
# online lockfile verification otherwise re-queries the registry for every
# entry and can exceed the registry timeout inside a cold build container.
RUN NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt pnpm install --frozen-lockfile --trust-lockfile --registry="${NPM_REGISTRY}"

COPY packages/contracts/src packages/contracts/src
COPY packages/contracts/tsconfig.json packages/contracts/
COPY packages/tool-gateway/src packages/tool-gateway/src
COPY packages/tool-gateway/tsconfig.json packages/tool-gateway/
COPY packages/control-plane/src packages/control-plane/src
COPY packages/control-plane/tsconfig.json packages/control-plane/
COPY packages/curator/src packages/curator/src
COPY packages/curator/tsconfig.json packages/curator/
COPY packages/harness-plugin/src packages/harness-plugin/src
COPY packages/harness-plugin/tsconfig.json packages/harness-plugin/
COPY packages/harness-plugin/cordis.patch.yml packages/harness-plugin/
COPY packages/orchestrator/src packages/orchestrator/src
COPY packages/orchestrator/scripts packages/orchestrator/scripts
COPY packages/orchestrator/tsconfig.json packages/orchestrator/

# CkSKILLS packs: loaded on demand by the Harness skill tool through the
# skill-filesystem plugin (customSkillDirs=/app/skills, see harness/patch.ts).
COPY skills /app/skills
# CkSKILLS v2.1 data layers: the packs reference these with repo-root-relative
# paths (../../kb/..., ../../rules/..., ../../templates/...) and `rules/55-kb-usage.md`
# requires kb/ to be readable at /app/kb. kb/ is ~40MB of CVE/dictionary/payload
# data, so this grows the worker image by that amount (compressed/registry layer
# size is smaller; the packs themselves stay under the 8MB skills/ budget).
COPY kb /app/kb
COPY rules /app/rules
COPY templates /app/templates

# Harness loads plugins as plain ESM JavaScript; bundle the SRC-Agent plugin
# (its tool/gateway dependencies are TypeScript workspace packages) so the
# runtime does not need a TS loader.
RUN pnpm --filter @src-agent/harness-plugin build:bundle

# The worker runs unprivileged. The compose file additionally mounts a read-only
# root filesystem with tmpfs /tmp and drops all capabilities.
RUN useradd --create-home --uid 10001 --shell /bin/bash worker \
    && mkdir -p /home/worker /runs \
    && chown -R worker:worker /app /home/worker /runs \
    && chmod +x /app/packages/orchestrator/scripts/worker-entrypoint.sh

USER worker
WORKDIR /app/packages/orchestrator

CMD ["node_modules/.bin/tsx", "src/worker/main.ts"]
