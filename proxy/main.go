package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func main() {
	port := envDefault("PROXY_PORT", "8080")
	if _, err := strconv.Atoi(port); err != nil || port == "" {
		log.Fatalf("invalid PROXY_PORT %q", port)
	}
	certs, err := LoadOrGenerateCA(
		envDefault("CA_CERT_PATH", "/certs/ca.pem"),
		envDefault("CA_KEY_PATH", "/certs/ca-key.pem"),
	)
	if err != nil {
		log.Fatalf("TLS interception CA: %v", err)
	}
	shutdownCtx, stopSignals := context.WithCancel(context.Background())
	defer stopSignals()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	recorder, err := NewPostgresRecorder(ctx)
	cancel()
	if err != nil {
		log.Fatalf("traffic recorder: %v", err)
	}
	defer recorder.Close()

	var staticScope *Scope
	scopeSource := strings.ToLower(strings.TrimSpace(envDefault("SCOPE_SOURCE", "env")))
	switch scopeSource {
	case "db":
		// Scope is loaded from the grants of active missions; nothing is
		// authorized until a mission exists in PostgreSQL.
	case "env", "":
		staticScope, err = NewScope(
			csvList(os.Getenv("SCOPE_DOMAINS")),
			csvList(os.Getenv("SCOPE_IPS")),
			csvList(os.Getenv("SCOPE_URL_PREFIXES")),
		)
		if err != nil {
			log.Fatalf("scope configuration: %v", err)
		}
	default:
		log.Fatalf("invalid SCOPE_SOURCE %q (expected env or db)", scopeSource)
	}

	egressMode := strings.ToLower(strings.TrimSpace(envDefault("EGRESS_MODE", "scope")))
	openEgress := egressMode == "open"
	policyMode := egressMode == "policy"
	if egressMode != "scope" && !openEgress && !policyMode {
		log.Fatalf("invalid EGRESS_MODE %q (expected scope, policy or open)", egressMode)
	}
	if openEgress {
		log.Printf("WARNING: EGRESS_MODE=open — target scope and internet allowlist are DISABLED; every destination is forwarded and audited")
	}
	rateLimit := 0
	if raw := strings.TrimSpace(os.Getenv("POLICY_RATE_LIMIT_PER_MIN")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 0 {
			log.Fatalf("invalid POLICY_RATE_LIMIT_PER_MIN %q", raw)
		}
		rateLimit = parsed
	}
	responseHeaderTimeout := 60 * time.Second
	if raw := strings.TrimSpace(os.Getenv("PROXY_RESPONSE_HEADER_TIMEOUT_MS")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed <= 0 {
			log.Fatalf("invalid PROXY_RESPONSE_HEADER_TIMEOUT_MS %q", raw)
		}
		responseHeaderTimeout = time.Duration(parsed) * time.Millisecond
	}
	proxy := NewProxy(staticScope, certs, recorder)
	proxy.SetConnectOverrides(parseConnectOverrides(os.Getenv("PROXY_CONNECT_OVERRIDES")))
	proxy.SetOpenEgress(openEgress)
	proxy.SetPolicy(policyMode, rateLimit)
	proxy.SetResponseHeaderTimeout(responseHeaderTimeout)
	internet := NewInternetPolicy(csvList(os.Getenv("INTERNET_ALLOWLIST")))
	proxy.SetInternetPolicy(internet)
	if scopeSource == "db" {
		provider := newDBScopeProvider(recorder.db, refreshInterval(os.Getenv("SCOPE_REFRESH_SECONDS")))
		proxy.SetScopeProvider(provider)
		provider.Start(shutdownCtx)
	}
	log.Printf("target scope source=%s %s egress_mode=%s policy_rate_per_min=%d response_header_timeout=%s", scopeSource, internet.String(), egressMode, rateLimit, responseHeaderTimeout)

	server := &http.Server{
		Addr:              ":" + port,
		Handler:           proxy,
		ReadHeaderTimeout: 15 * time.Second,
		ReadTimeout:       5 * time.Minute,
		WriteTimeout:      5 * time.Minute,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    1 << 20,
	}
	shutdown := make(chan os.Signal, 1)
	signal.Notify(shutdown, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-shutdown
		log.Printf("shutting down outbound proxy on :%s", port)
		stopSignals()
		stop, stopCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer stopCancel()
		if err := server.Shutdown(stop); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("shutdown error: %v", err)
		}
	}()

	log.Printf("SRC-Agent outbound proxy listening on :%s", port)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("listen: %v", err)
	}
}

// parseConnectOverrides parses comma-separated host:port=host:port mappings.
func parseConnectOverrides(raw string) map[string]string {
	out := map[string]string{}
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		left, right, ok := strings.Cut(part, "=")
		if !ok || strings.TrimSpace(left) == "" || strings.TrimSpace(right) == "" {
			log.Printf("ignoring invalid PROXY_CONNECT_OVERRIDES entry %q", part)
			continue
		}
		out[strings.TrimSpace(left)] = strings.TrimSpace(right)
	}
	if len(out) > 0 {
		log.Printf("WARNING: %d transport connect override(s) configured; Host/audit/scope identity is unchanged", len(out))
	}
	return out
}

func refreshInterval(raw string) time.Duration {
	seconds, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || seconds <= 0 {
		return 3 * time.Second
	}
	return time.Duration(seconds) * time.Second
}

func csvList(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		value := strings.TrimSpace(part)
		if value != "" {
			out = append(out, value)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}
