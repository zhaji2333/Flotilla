package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type memoryRecorder struct {
	mu      sync.Mutex
	records []recordedExchange
	err     error
}

type recordedExchange struct {
	TrafficRecord
	RequestBytes  []byte
	ResponseBytes []byte
}

func (r *memoryRecorder) Record(_ context.Context, record TrafficRecord) error {
	if r.err != nil {
		return r.err
	}
	requestBytes, err := readCapture(record.RequestBody)
	if err != nil {
		return fmt.Errorf("read captured request body: %w", err)
	}
	responseBytes, err := readCapture(record.ResponseBody)
	if err != nil {
		return fmt.Errorf("read captured response body: %w", err)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.records = append(r.records, recordedExchange{
		TrafficRecord: record,
		RequestBytes:  requestBytes,
		ResponseBytes: responseBytes,
	})
	return nil
}

func (r *memoryRecorder) snapshot() []recordedExchange {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]recordedExchange(nil), r.records...)
}

func readCapture(capture BodyCapture) ([]byte, error) {
	if capture.Reader == nil {
		return nil, nil
	}
	return io.ReadAll(capture.Reader)
}

type stubResolver struct {
	mu      sync.Mutex
	answers map[string][]netip.Addr
	calls   []string
}

func (r *stubResolver) LookupNetIP(_ context.Context, _, host string) ([]netip.Addr, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(r.calls, host)
	answers, ok := r.answers[host]
	if !ok {
		return nil, fmt.Errorf("no test DNS answer for %s", host)
	}
	return append([]netip.Addr(nil), answers...), nil
}

func (r *stubResolver) callCount(host string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	count := 0
	for _, call := range r.calls {
		if call == host {
			count++
		}
	}
	return count
}

func loopbackResolver() *stubResolver {
	return &stubResolver{answers: map[string][]netip.Addr{
		"allowed.test": {netip.MustParseAddr("127.0.0.1")},
		"outside.test": {netip.MustParseAddr("127.0.0.1")},
	}}
}

func proxyClient(t *testing.T, proxyURL *url.URL, roots *x509.CertPool) *http.Client {
	t.Helper()
	transport := &http.Transport{
		Proxy: http.ProxyURL(proxyURL),
		TLSClientConfig: &tls.Config{
			RootCAs:    roots,
			MinVersion: tls.VersionTLS12,
		},
	}
	client := &http.Client{Transport: transport, Timeout: 5 * time.Second}
	t.Cleanup(transport.CloseIdleConnections)
	return client
}

func startTestProxy(t *testing.T, scope *Scope, recorder Recorder, certs *CertManager) (*Proxy, *httptest.Server) {
	t.Helper()
	p := NewProxy(scope, certs, recorder)
	p.resolver = loopbackResolver()
	server := httptest.NewServer(p)
	t.Cleanup(func() {
		server.Close()
		p.CloseIdleConnections()
	})
	return p, server
}

func TestOutOfScopeHTTPRequestReturnsSystemBlockWithoutDialing(t *testing.T) {
	var targetHits atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		targetHits.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer target.Close()

	scope := mustScope(t, []string{"allowed.test"}, []string{"127.0.0.0/8"}, nil)
	recorder := &memoryRecorder{}
	p, proxyServer := startTestProxy(t, scope, recorder, nil)
	resolver := p.resolver.(*stubResolver)
	proxyURL, _ := url.Parse(proxyServer.URL)

	resp, err := proxyClient(t, proxyURL, nil).Get("http://outside.test/")
	if err != nil {
		t.Fatalf("proxy request: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", resp.StatusCode)
	}
	if got := resp.Header.Get("Content-Type"); got != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", got)
	}
	var body map[string]string
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode block response: %v", err)
	}
	if body["blocked_by"] != "platform" || !strings.HasPrefix(body["reason"], "【SRC-Agent 平台管控·非目标防御】") {
		t.Fatalf("unexpected block response: %#v", body)
	}
	if targetHits.Load() != 0 || resolver.callCount("outside.test") != 0 {
		t.Fatalf("blocked request reached network: target hits=%d DNS calls=%d", targetHits.Load(), resolver.callCount("outside.test"))
	}
}

func TestAllowedHTTPRequestIsRecorded(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if string(body) != "request-body" {
			t.Errorf("target received body %q", body)
		}
		w.Header().Set("X-Target", "local-fixture")
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, "target-response")
	}))
	defer target.Close()
	targetURL, _ := url.Parse(target.URL)

	scope := mustScope(t, []string{"allowed.test"}, []string{"127.0.0.0/8"}, nil)
	recorder := &memoryRecorder{}
	_, proxyServer := startTestProxy(t, scope, recorder, nil)
	proxyURL, _ := url.Parse(proxyServer.URL)
	requestURL := "http://allowed.test:" + targetURL.Port() + "/submit?q=1"

	resp, err := proxyClient(t, proxyURL, nil).Post(requestURL, "text/plain", strings.NewReader("request-body"))
	if err != nil {
		t.Fatalf("proxy request: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated || string(body) != "target-response" {
		t.Fatalf("response = %d %q", resp.StatusCode, body)
	}

	records := recorder.snapshot()
	if len(records) != 1 {
		t.Fatalf("record count = %d, want 1", len(records))
	}
	record := records[0]
	if record.Method != http.MethodPost || record.URL != requestURL || record.StatusCode != http.StatusCreated {
		t.Fatalf("unexpected metadata: %#v", record)
	}
	if string(record.RequestBytes) != "request-body" || string(record.ResponseBytes) != "target-response" {
		t.Fatalf("bodies not recorded: request=%q response=%q", record.RequestBytes, record.ResponseBytes)
	}
	if record.ResponseHeader.Get("X-Target") != "local-fixture" {
		t.Fatalf("response headers not recorded: %#v", record.ResponseHeader)
	}
}

func TestRedirectOutOfScopeIsBlockedOnNextHop(t *testing.T) {
	var initialHits atomic.Int32
	var redirectedHits atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/start":
			initialHits.Add(1)
			_, port, _ := net.SplitHostPort(r.Host)
			http.Redirect(w, r, "http://outside.test:"+port+"/landed", http.StatusFound)
		case "/landed":
			redirectedHits.Add(1)
			_, _ = io.WriteString(w, "redirect escaped")
		default:
			http.NotFound(w, r)
		}
	}))
	defer target.Close()
	targetURL, _ := url.Parse(target.URL)

	scope := mustScope(t, []string{"allowed.test"}, []string{"127.0.0.0/8"}, nil)
	_, proxyServer := startTestProxy(t, scope, &memoryRecorder{}, nil)
	proxyURL, _ := url.Parse(proxyServer.URL)

	// The test client follows redirects automatically. The upstream client in
	// the proxy must not; the followed request has to come back through scope.
	resp, err := proxyClient(t, proxyURL, nil).Get("http://allowed.test:" + targetURL.Port() + "/start")
	if err != nil {
		t.Fatalf("redirect request: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden || !strings.Contains(string(body), `"blocked_by":"platform"`) {
		t.Fatalf("redirect response = %d %s", resp.StatusCode, body)
	}
	if initialHits.Load() != 1 || redirectedHits.Load() != 0 {
		t.Fatalf("redirect reached out-of-scope target: initial=%d redirected=%d", initialHits.Load(), redirectedHits.Load())
	}
}

func TestDNSRebindingToLoopbackReturnsSystemBlock(t *testing.T) {
	var targetHits atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		targetHits.Add(1)
	}))
	defer target.Close()
	targetURL, _ := url.Parse(target.URL)

	scope := mustScope(t, []string{"allowed.test"}, nil, nil)
	_, proxyServer := startTestProxy(t, scope, &memoryRecorder{}, nil)
	proxyURL, _ := url.Parse(proxyServer.URL)

	resp, err := proxyClient(t, proxyURL, nil).Get("http://allowed.test:" + targetURL.Port() + "/")
	if err != nil {
		t.Fatalf("proxy request: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", resp.StatusCode)
	}
	if targetHits.Load() != 0 {
		t.Fatal("rebinding request reached loopback target")
	}
}

func TestAllowedDNSResultIsPinnedForDial(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "pinned")
	}))
	defer target.Close()
	targetURL, _ := url.Parse(target.URL)

	scope := mustScope(t, []string{"allowed.test"}, []string{"127.0.0.0/8"}, nil)
	p, proxyServer := startTestProxy(t, scope, &memoryRecorder{}, nil)
	resolver := p.resolver.(*stubResolver)
	proxyURL, _ := url.Parse(proxyServer.URL)

	resp, err := proxyClient(t, proxyURL, nil).Get("http://allowed.test:" + targetURL.Port() + "/")
	if err != nil {
		t.Fatalf("proxy request: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if got := resolver.callCount("allowed.test"); got != 1 {
		t.Fatalf("DNS lookups = %d, want exactly one before the pinned dial", got)
	}
}

func TestCONNECTTLSInterceptionUsesDynamicCertificate(t *testing.T) {
	certs, err := LoadOrGenerateCA(t.TempDir()+"/ca.pem", t.TempDir()+"/ca-key.pem")
	if err != nil {
		t.Fatalf("LoadOrGenerateCA: %v", err)
	}
	leaf, err := certs.CertificateFor("allowed.test")
	if err != nil {
		t.Fatalf("CertificateFor: %v", err)
	}
	target := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.TLS == nil {
			t.Error("target received plaintext instead of TLS")
		}
		_, _ = io.WriteString(w, "intercepted")
	}))
	target.TLS = &tls.Config{Certificates: []tls.Certificate{leaf}, MinVersion: tls.VersionTLS12}
	target.StartTLS()
	defer target.Close()
	targetURL, _ := url.Parse(target.URL)

	roots := x509.NewCertPool()
	roots.AddCert(certs.Certificate())
	scope := mustScope(t, []string{"allowed.test"}, []string{"127.0.0.0/8"}, nil)
	recorder := &memoryRecorder{}
	p, proxyServer := startTestProxy(t, scope, recorder, certs)
	p.transport.TLSClientConfig = &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}
	proxyURL, _ := url.Parse(proxyServer.URL)

	resp, err := proxyClient(t, proxyURL, roots).Get("https://allowed.test:" + targetURL.Port() + "/secure")
	if err != nil {
		t.Fatalf("HTTPS proxy request: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || string(body) != "intercepted" {
		t.Fatalf("response = %d %q", resp.StatusCode, body)
	}
	records := recorder.snapshot()
	if len(records) != 1 || records[0].URL != "https://allowed.test:"+targetURL.Port()+"/secure" {
		t.Fatalf("HTTPS exchange not recorded correctly: %#v", records)
	}
}

func TestOutOfScopeCONNECTReturnsJSONBlock(t *testing.T) {
	scope := mustScope(t, []string{"allowed.test"}, []string{"127.0.0.0/8"}, nil)
	_, proxyServer := startTestProxy(t, scope, &memoryRecorder{}, nil)
	proxyURL, _ := url.Parse(proxyServer.URL)

	conn, err := net.DialTimeout("tcp", proxyURL.Host, 2*time.Second)
	if err != nil {
		t.Fatalf("dial proxy: %v", err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
	_, _ = fmt.Fprintf(conn, "CONNECT outside.test:443 HTTP/1.1\r\nHost: outside.test:443\r\n\r\n")
	req := &http.Request{Method: http.MethodConnect}
	resp, err := http.ReadResponse(bufio.NewReader(conn), req)
	if err != nil {
		t.Fatalf("read CONNECT response: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusForbidden || resp.Header.Get("Content-Type") != "application/json" {
		t.Fatalf("CONNECT response = %d %s %s", resp.StatusCode, resp.Header.Get("Content-Type"), body)
	}
	if !strings.Contains(string(body), `"blocked_by":"platform"`) {
		t.Fatalf("CONNECT body = %s", body)
	}
}

func TestAuditFailureStillServesAuthorizedResponse(t *testing.T) {
	// Audit rows carry only metadata (method/URL/status/hashes). A metadata
	// write failure is logged rather than turned into a 502, because the
	// exchange itself was authorized and finding evidence is captured
	// separately by the worker's report path.
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "authorized-body")
	}))
	defer target.Close()
	targetURL, _ := url.Parse(target.URL)

	scope := mustScope(t, []string{"allowed.test"}, []string{"127.0.0.0/8"}, nil)
	recorder := &memoryRecorder{err: errors.New("storage unavailable")}
	_, proxyServer := startTestProxy(t, scope, recorder, nil)
	proxyURL, _ := url.Parse(proxyServer.URL)

	resp, err := proxyClient(t, proxyURL, nil).Get("http://allowed.test:" + targetURL.Port() + "/")
	if err != nil {
		t.Fatalf("proxy request: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !strings.Contains(string(body), "authorized-body") {
		t.Fatalf("audit failure response = %d %q", resp.StatusCode, body)
	}
}

func TestPolicyRateLimitIsPerHostPerMinute(t *testing.T) {
	p := NewProxy(nil, nil, nil)
	p.SetPolicy(true, 2)
	if !p.allowRate("target.test") || !p.allowRate("target.test") {
		t.Fatal("first two requests should be allowed")
	}
	if p.allowRate("target.test") {
		t.Fatal("third request should be blocked by policy rate limit")
	}
	if !p.allowRate("other.test") {
		t.Fatal("rate limit should be tracked per host")
	}
}

func TestPolicyModeDisabledAllowsEverything(t *testing.T) {
	p := NewProxy(nil, nil, nil)
	p.SetPolicy(false, 1)
	for i := 0; i < 5; i++ {
		if !p.allowRate("target.test") {
			t.Fatal("disabled policy must not rate-limit")
		}
	}
}

func multiHostResolver() *stubResolver {
	return &stubResolver{answers: map[string][]netip.Addr{
		"allowed.test":  {netip.MustParseAddr("127.0.0.1")},
		"allowed2.test": {netip.MustParseAddr("127.0.0.1")},
		"outside.test":  {netip.MustParseAddr("127.0.0.1")},
	}}
}

func TestMultiHopRedirectRevalidatesAndAuditsEveryHop(t *testing.T) {
	var startHits, hopHits, finalHits atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, port, _ := net.SplitHostPort(r.Host)
		switch r.URL.Path {
		case "/start":
			startHits.Add(1)
			http.Redirect(w, r, "http://allowed2.test:"+port+"/hop2", http.StatusFound)
		case "/hop2":
			hopHits.Add(1)
			http.Redirect(w, r, "http://allowed.test:"+port+"/final", http.StatusMovedPermanently)
		case "/final":
			finalHits.Add(1)
			_, _ = io.WriteString(w, "chain-complete")
		default:
			http.NotFound(w, r)
		}
	}))
	defer target.Close()
	targetURL, _ := url.Parse(target.URL)

	scope := mustScope(t, []string{"allowed.test", "allowed2.test"}, []string{"127.0.0.0/8"}, nil)
	recorder := &memoryRecorder{}
	p, proxyServer := startTestProxy(t, scope, recorder, nil)
	p.resolver = multiHostResolver()
	proxyURL, _ := url.Parse(proxyServer.URL)

	resp, err := proxyClient(t, proxyURL, nil).Get("http://allowed.test:" + targetURL.Port() + "/start")
	if err != nil {
		t.Fatalf("multi-hop redirect request: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || string(body) != "chain-complete" {
		t.Fatalf("multi-hop response = %d %q", resp.StatusCode, body)
	}
	if startHits.Load() != 1 || hopHits.Load() != 1 || finalHits.Load() != 1 {
		t.Fatalf("redirect chain hits: start=%d hop2=%d final=%d", startHits.Load(), hopHits.Load(), finalHits.Load())
	}

	// Every hop is its own audited exchange, including both redirect responses.
	records := recorder.snapshot()
	if len(records) != 3 {
		t.Fatalf("audited exchanges = %d, want 3", len(records))
	}
	wantStatus := []int{http.StatusFound, http.StatusMovedPermanently, http.StatusOK}
	for index, record := range records {
		if record.StatusCode != wantStatus[index] {
			t.Fatalf("exchange %d status = %d, want %d", index, record.StatusCode, wantStatus[index])
		}
	}
	if location := records[0].ResponseHeader.Get("Location"); !strings.Contains(location, "allowed2.test") {
		t.Fatalf("first redirect Location = %q", location)
	}
	if got := p.resolver.(*stubResolver).callCount("outside.test"); got != 0 {
		t.Fatalf("out-of-scope resolver calls = %d, want 0", got)
	}
}

func TestMultiHopRedirectBlocksAtOutOfScopeHop(t *testing.T) {
	var allowedHits, outsideHits atomic.Int32
	outside := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		outsideHits.Add(1)
		_, _ = io.WriteString(w, "should-not-be-reached")
	}))
	defer outside.Close()
	outsideURL, _ := url.Parse(outside.URL)

	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, port, _ := net.SplitHostPort(r.Host)
		switch r.URL.Path {
		case "/start":
			allowedHits.Add(1)
			http.Redirect(w, r, "http://allowed2.test:"+port+"/go", http.StatusFound)
		case "/go":
			allowedHits.Add(1)
			http.Redirect(w, r, "http://outside.test:"+outsideURL.Port()+"/landed", http.StatusFound)
		default:
			http.NotFound(w, r)
		}
	}))
	defer target.Close()
	targetURL, _ := url.Parse(target.URL)

	scope := mustScope(t, []string{"allowed.test", "allowed2.test"}, []string{"127.0.0.0/8"}, nil)
	recorder := &memoryRecorder{}
	p, proxyServer := startTestProxy(t, scope, recorder, nil)
	p.resolver = multiHostResolver()
	proxyURL, _ := url.Parse(proxyServer.URL)

	resp, err := proxyClient(t, proxyURL, nil).Get("http://allowed.test:" + targetURL.Port() + "/start")
	if err != nil {
		t.Fatalf("blocked multi-hop request: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden || !strings.Contains(string(body), `"blocked_by":"platform"`) {
		t.Fatalf("blocked hop response = %d %s", resp.StatusCode, body)
	}
	if outsideHits.Load() != 0 {
		t.Fatalf("out-of-scope redirect hop reached the network: hits=%d", outsideHits.Load())
	}
	if allowedHits.Load() != 2 {
		t.Fatalf("in-scope hops = %d, want 2", allowedHits.Load())
	}
	if records := recorder.snapshot(); len(records) != 2 {
		t.Fatalf("audited in-scope exchanges = %d, want 2", len(records))
	}
}

func TestTLSRedirectHopOutOfScopeIsBlocked(t *testing.T) {
	certs, err := LoadOrGenerateCA(t.TempDir()+"/ca.pem", t.TempDir()+"/ca-key.pem")
	if err != nil {
		t.Fatalf("LoadOrGenerateCA: %v", err)
	}
	leaf, err := certs.CertificateFor("allowed.test")
	if err != nil {
		t.Fatalf("CertificateFor: %v", err)
	}
	var outsideHits atomic.Int32
	outside := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		outsideHits.Add(1)
	}))
	defer outside.Close()
	outsideURL, _ := url.Parse(outside.URL)

	target := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/start" {
			http.Redirect(w, r, "https://outside.test:"+outsideURL.Port()+"/landed", http.StatusFound)
			return
		}
		http.NotFound(w, r)
	}))
	target.TLS = &tls.Config{Certificates: []tls.Certificate{leaf}, MinVersion: tls.VersionTLS12}
	target.StartTLS()
	defer target.Close()
	targetURL, _ := url.Parse(target.URL)

	roots := x509.NewCertPool()
	roots.AddCert(certs.Certificate())
	scope := mustScope(t, []string{"allowed.test"}, []string{"127.0.0.0/8"}, nil)
	p, proxyServer := startTestProxy(t, scope, &memoryRecorder{}, certs)
	p.transport.TLSClientConfig = &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}
	proxyURL, _ := url.Parse(proxyServer.URL)

	_, err = proxyClient(t, proxyURL, roots).Get("https://allowed.test:" + targetURL.Port() + "/start")
	if err == nil {
		t.Fatal("TLS redirect to an out-of-scope host should fail at the next CONNECT")
	}
	errorText := strings.ToLower(err.Error())
	if !strings.Contains(errorText, "forbidden") && !strings.Contains(errorText, "403") {
		t.Fatalf("TLS redirect error = %v, want a proxy 403", err)
	}
	if outsideHits.Load() != 0 {
		t.Fatalf("out-of-scope TLS redirect reached the network: hits=%d", outsideHits.Load())
	}
}

func TestUpstreamResponseHeaderTimeoutReturnsBadGateway(t *testing.T) {
	var hits atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		time.Sleep(400 * time.Millisecond)
		_, _ = io.WriteString(w, "too-late")
	}))
	defer target.Close()
	targetURL, _ := url.Parse(target.URL)

	scope := mustScope(t, []string{"allowed.test"}, []string{"127.0.0.0/8"}, nil)
	p, proxyServer := startTestProxy(t, scope, &memoryRecorder{}, nil)
	p.SetResponseHeaderTimeout(50 * time.Millisecond)
	proxyURL, _ := url.Parse(proxyServer.URL)

	startedAt := time.Now()
	resp, err := proxyClient(t, proxyURL, nil).Get("http://allowed.test:" + targetURL.Port() + "/slow")
	if err != nil {
		t.Fatalf("timeout request: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadGateway || !strings.Contains(string(body), "upstream request failed") {
		t.Fatalf("timeout response = %d %s", resp.StatusCode, body)
	}
	if elapsed := time.Since(startedAt); elapsed > 2*time.Second {
		t.Fatalf("timeout took %s, want a bounded wait", elapsed)
	}
	if hits.Load() != 1 {
		t.Fatalf("upstream hits = %d, want 1", hits.Load())
	}
}

func TestOversizedRequestHeadersAreRejected(t *testing.T) {
	scope := mustScope(t, []string{"allowed.test"}, []string{"127.0.0.0/8"}, nil)
	_, proxyServer := startTestProxy(t, scope, &memoryRecorder{}, nil)
	proxyURL, _ := url.Parse(proxyServer.URL)

	conn, err := net.DialTimeout("tcp", proxyURL.Host, 2*time.Second)
	if err != nil {
		t.Fatalf("dial proxy: %v", err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	request := "GET http://allowed.test/ HTTP/1.1\r\nHost: allowed.test\r\nX-Big: " +
		strings.Repeat("a", 2<<20) + "\r\n\r\n"
	if _, err := io.WriteString(conn, request); err != nil {
		t.Fatalf("write oversized request: %v", err)
	}
	resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatalf("read oversized response: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusRequestHeaderFieldsTooLarge {
		t.Fatalf("oversized header status = %d, want 431", resp.StatusCode)
	}
}
