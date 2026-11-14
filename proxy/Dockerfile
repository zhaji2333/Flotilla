# syntax=docker/dockerfile:1
FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/src-agent-proxy .

FROM alpine:latest
RUN apk add --no-cache ca-certificates && \
    addgroup -S proxy && adduser -S -G proxy -H -u 10001 proxy && \
    mkdir -p /certs && chown proxy:proxy /certs
COPY --from=build /out/src-agent-proxy /usr/local/bin/src-agent-proxy
ENV PROXY_PORT=8080 \
    CA_CERT_PATH=/certs/ca.pem \
    CA_KEY_PATH=/certs/ca-key.pem
EXPOSE 8080
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/src-agent-proxy"]
