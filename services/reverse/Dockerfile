# SRC-Agent static reverse capability service (JADX + ASC + React Native).
# Acquisition is done by the executor/API; this service only reads artifacts
# and performs offline static analysis. It has no DB/provider credentials.
FROM python:3.11-slim-bookworm

ARG NPM_REGISTRY=https://registry.npmmirror.com
ARG PIP_INDEX_URL=https://pypi.org/simple
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    HOME=/home/reverse \
    ARTIFACTS_DIR=/artifacts

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       openjdk-17-jre-headless unzip zip file binutils ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/reverse
COPY services/reverse/vendor/asc /opt/reverse/asc
COPY services/reverse/vendor/jadx/jadx-1.5.5-all.jar /opt/reverse/jadx/jadx-all.jar

RUN PIP_INDEX_URL="${PIP_INDEX_URL}" pip install --no-cache-dir -r /opt/reverse/asc/requirements.txt \
    && PIP_INDEX_URL="${PIP_INDEX_URL}" pip install --no-cache-dir -e /opt/reverse/asc \
    && PIP_INDEX_URL="${PIP_INDEX_URL}" pip install --no-cache-dir hermes-dec hbctool

COPY services/reverse/src /opt/reverse/src
RUN groupadd -g 10003 artifacts \
    && groupadd -g 10004 reverse \
    && useradd --create-home --uid 10004 --gid reverse --groups artifacts --shell /bin/bash reverse \
    && mkdir -p /home/reverse /home/reverse/.idapro /artifacts \
    && chown -R reverse:artifacts /home/reverse /artifacts /opt/reverse
USER reverse
WORKDIR /opt/reverse
EXPOSE 9402
CMD ["python", "src/server.py"]
