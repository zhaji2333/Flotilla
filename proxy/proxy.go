package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

const blockReason = "【SRC-Agent 平台管控·非目标防御】请求目标不在当前授权范围内，平台已阻断本次出站访问。"

type ipResolver interface {
	LookupNetIP(context.Context, string, string) ([]netip.Addr, error)
}

// captureBody streams a body into a temporary file while computing SHA-256.
// The file is removed after the upstream exchange is fully recorded.
type captureBody struct {
	file *os.File
	hash string
	size int64
}

func newCaptureBody(body io.ReadCloser) (*captureBody, error) {
	if body == nil {
		return &captureBody{hash: sha256Hex(nil)}, nil
	}
	defer body.Close()
	file, err := os.CreateTemp("", "src-agent-proxy-body-*")
	if err != nil {
		return nil, fmt.Errorf("create body capture: %w", err)
	}
	capture := &captureBody{file: file}
	remove := true
	defer func() {
		if remove {
			file.Close()
			os.Remove(file.Name())
		}
	}()
	hash := sha256.New()
	size, err := io.Copy(io.MultiWriter(file, hash), body)
	if err != nil {
		return nil, fmt.Errorf("read body capture: %w", err)
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return nil, fmt.Errorf("rewind body capture: %w", err)
	}
	capture.hash = hex.EncodeToString(hash.Sum(nil))
	capture.size = size
	remove = false
	return capture, nil
}

func sha256Hex(body []byte) string {
	hash := sha256.Sum256(body)
	return hex.EncodeToString(hash[:])
}

func (c *captureBody) reader() (io.Reader, error) {
	if c == nil || c.file == nil {
		return bytes.NewReader(nil), nil
	}
	if _, err := c.file.Seek(0, io.SeekStart); err != nil {
		return nil, fmt.Errorf("rewind body capture: %w", err)
	}
	return c.file, nil
}

func (c *captureBody) close() {
	if c != nil && c.file != nil {
		name := c.file.Name()
		_ = c.file.Close()
		_ = os.Remove(name)
	}
}

// Proxy is a fail-closed forward proxy. Every upstream socket is opened through
// dialContext, which resolves and authorizes addresses before dialing a pinned
// IP; no target connection falls back to a transparent, uninspected tunnel.
type Proxy struct {
	scopeProvider ScopeProvider
	internet      *InternetPolicy
	openEgress    bool
	policyMode    bool
	ratePerMin    int
	rateMu        sync.Mutex
	rateWindow    time.Time
	rateCounts    map[string]int
	certs         *CertManager
	recorder      Recorder
	resolver      ipResolver
	dialer        *net.Dialer
	// Operator-configured transport-only host mappings; scope/audit identity
	// stays the real target host.
	connectOverrides map[string]string
	transport        *http.Transport
	client           *http.Client
}

type trafficMode string

const (
	modeTarget   trafficMode = "target"
	modeInternet trafficMode = "internet"
)

type proxyContextKey struct{}

// Distinct key types: two zero-size struct keys would compare equal and the
// scope value could shadow the mode value in the same context.
type modeContextKeyType struct{}
type scopeContextKeyType struct{}

var (
	modeContextKey  modeContextKeyType
	scopeContextKey scopeContextKeyType
)

// authorization is the outcome of classify plus the exact grant that allowed a
// target request. The dial-time rebinding check must use that grant, not the
// union scope: an active allowAll mission must not disable DNS pinning for a
// restricted mission. The value travels in the request context.
type authorization struct {
	mode  trafficMode
	scope *Scope
}

// authorize classifies the request and resolves the grant behind a target hit.
func (p *Proxy) authorize(r *http.Request, u *url.URL, connect bool) (authorization, error) {
	mode, err := p.classify(r, u, connect)
	if err != nil {
		return authorization{mode: mode}, err
	}
	if mode != modeTarget {
		return authorization{mode: mode}, nil
	}
	return authorization{mode: mode, scope: p.targetScopeFor(r, u, connect)}, nil
}

// targetScopeFor mirrors classify: the header mission's own grant first, then
// the concrete grant that matched the URL, then the unambiguous single allowAll
// mission. Legacy/static providers keep using the env scope.
func (p *Proxy) targetScopeFor(r *http.Request, u *url.URL, connect bool) *Scope {
	provider, aware := p.scopeProvider.(missionAwareProvider)
	if !aware {
		return p.currentScope()
	}
	if id := missionHeaderID(r); id != "" && provider.HasMission(id) && provider.MissionAllows(id, u, connect) {
		if scope := provider.MissionScope(id); scope != nil {
			return scope
		}
	}
	if id := provider.MissionForURL(u, connect); id != "" {
		if scope := provider.MissionScope(id); scope != nil {
			return scope
		}
	}
	if _, single := provider.SingleUnrestrictedMission(); single {
		return NewUnrestrictedScope()
	}
	return p.currentScope()
}

func NewProxy(scope *Scope, certs *CertManager, recorder Recorder) *Proxy {
	p := &Proxy{
		scopeProvider: staticScopeProvider{scope: scope},
		certs:         certs,
		recorder:      recorder,
		resolver:      net.DefaultResolver,
		dialer: &net.Dialer{
			Timeout:   15 * time.Second,
			KeepAlive: 30 * time.Second,
		},
	}
	p.transport = &http.Transport{
		Proxy:                 nil, // Never inherit proxy environment variables.
		DialContext:           p.dialContext,
		ForceAttemptHTTP2:     false,
		DisableCompression:    true,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 60 * time.Second,
		ExpectContinueTimeout: time.Second,
		IdleConnTimeout:       90 * time.Second,
		MaxIdleConns:          100,
		MaxIdleConnsPerHost:   10,
	}
	p.client = &http.Client{
		Transport: p.transport,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			// Return the redirect to the client. If it follows the next hop, that
			// request traverses this proxy and receives its own full scope check.
			return http.ErrUseLastResponse
		},
	}
	return p
}

// SetScopeProvider switches target-scope enforcement to a dynamic provider
// (for example the union of active mission grants loaded from PostgreSQL).
func (p *Proxy) SetScopeProvider(provider ScopeProvider) {
	if provider != nil {
		p.scopeProvider = provider
	}
}

// SetInternetPolicy configures the internet-retrieval egress allowlist.
func (p *Proxy) SetInternetPolicy(policy *InternetPolicy) { p.internet = policy }

// SetConnectOverrides configures transport-only dial mappings such as
// 127.0.0.1:65280 -> host.docker.internal:65280. It never changes the Host
// header, evidence URL, scope checks or audit URL.
func (p *Proxy) SetConnectOverrides(overrides map[string]string) {
	if p != nil {
		p.connectOverrides = overrides
	}
}

// SetOpenEgress temporarily disables the target-scope and internet-allowlist
// egress gates: every destination is forwarded and audited. This is the
// explicitly requested "open mode" for lab/authorized work; gating returns once
// a later policy layer replaces it.
func (p *Proxy) SetOpenEgress(open bool) { p.openEgress = open }

// SetPolicy enables the P2 policy layer: the normal scope/allowlist checks stay
// active, plus a per-host per-minute request ceiling. Zero means unlimited.
func (p *Proxy) SetPolicy(enabled bool, ratePerMin int) {
	p.policyMode = enabled
	if ratePerMin > 0 {
		p.ratePerMin = ratePerMin
	}
	p.rateCounts = map[string]int{}
}

// SetResponseHeaderTimeout bounds how long one upstream hop may take to send
// response headers. It applies to every hop of a redirect chain because each
// hop is a separate client.Do; callers set it once at startup.
func (p *Proxy) SetResponseHeaderTimeout(timeout time.Duration) {
	if p != nil && p.transport != nil && timeout > 0 {
		p.transport.ResponseHeaderTimeout = timeout
	}
}

// allowRate is a simple per-host, per-minute token window. It is intentionally
// coarse (a safety ceiling, not a billing quota).
func (p *Proxy) allowRate(host string) bool {
	if !p.policyMode || p.ratePerMin <= 0 {
		return true
	}
	host = strings.ToLower(strings.TrimSpace(host))
	now := time.Now().UTC()
	p.rateMu.Lock()
	defer p.rateMu.Unlock()
	if p.rateWindow.IsZero() || now.Sub(p.rateWindow) >= time.Minute {
		p.rateWindow = now
		p.rateCounts = map[string]int{}
	}
	p.rateCounts[host]++
	return p.rateCounts[host] <= p.ratePerMin
}

// OpenEgress reports whether the temporary all-destinations mode is active.
func (p *Proxy) OpenEgress() bool { return p.openEgress }

func (p *Proxy) currentScope() *Scope {
	if p == nil || p.scopeProvider == nil {
		return nil
	}
	return p.scopeProvider.Current()
}

// classify decides whether a request is authorized target traffic, authorized
// internet retrieval, or must be blocked. Target scope is checked first so a
// host that is both a target and allowlisted stays on the stricter path.
func validMissionID(id string) bool {
	if len(id) != 36 {
		return false
	}
	for i, ch := range id {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if ch != '-' {
				return false
			}
			continue
		}
		if !((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F')) {
			return false
		}
	}
	return true
}

func taskIDForRequest(r *http.Request) string {
	if r == nil {
		return ""
	}
	id := strings.TrimSpace(r.Header.Get("X-SRC-Task-Id"))
	if validMissionID(id) {
		return id
	}
	return ""
}

// missionAwareProvider is implemented by the PostgreSQL scope provider. It
// authorizes a request against one mission's own grant so an allowAll mission
// (attachment-only, audited unrestricted egress) can never widen the egress of
// an unrelated mission that happens to be active at the same time.
type missionAwareProvider interface {
	HasMission(string) bool
	MissionForURL(*url.URL, bool) string
	MissionAllows(string, *url.URL, bool) bool
	MissionScope(string) *Scope
	SingleUnrestrictedMission() (string, bool)
}

func missionHeaderID(r *http.Request) string {
	if r == nil {
		return ""
	}
	id := strings.TrimSpace(r.Header.Get("X-SRC-Mission-Id"))
	if validMissionID(id) {
		return id
	}
	return ""
}

// missionForRequest attributes audited traffic to a mission. Target traffic is
// attributed from the server-side grant match (the client header is only
// trusted after that same header already authorized the request); internet
// retrieval is attributed from the validated header.
func (p *Proxy) missionForRequest(r *http.Request, u *url.URL, mode trafficMode) string {
	headerID := missionHeaderID(r)
	if provider, ok := p.scopeProvider.(missionAwareProvider); ok {
		if mode == modeTarget {
			// The header mission is recorded only when its own grant authorized
			// this request, so bash cannot move traffic into another mission.
			if headerID != "" && provider.HasMission(headerID) && provider.MissionAllows(headerID, u, false) {
				return headerID
			}
			if id := provider.MissionForURL(u, false); id != "" {
				return id
			}
			if id, single := provider.SingleUnrestrictedMission(); single {
				return id
			}
			return ""
		}
		if headerID != "" && provider.HasMission(headerID) {
			return headerID
		}
		return ""
	}
	// Legacy/static providers (env scope, unit-test fakes).
	if mode == modeTarget {
		if provider, ok := p.scopeProvider.(interface {
			MissionForURL(*url.URL, bool) string
		}); ok {
			if id := provider.MissionForURL(u, false); id != "" {
				return id
			}
		}
	}
	if headerID != "" {
		if provider, ok := p.scopeProvider.(interface{ HasMission(string) bool }); ok && provider.HasMission(headerID) {
			return headerID
		}
	}
	return ""
}

func (p *Proxy) classify(r *http.Request, u *url.URL, connect bool) (trafficMode, error) {
	if p.openEgress {
		// Open mode still prefers target classification for scope-matching hosts,
		// but never blocks: everything else is treated as internet egress.
		if scope := p.currentScope(); scope != nil {
			var err error
			if connect {
				err = scope.CheckConnect(u.Host)
			} else {
				err = scope.CheckURL(u)
			}
			if err == nil {
				return modeTarget, nil
			}
		}
		return modeInternet, nil
	}
	provider, aware := p.scopeProvider.(missionAwareProvider)
	if aware {
		// 1) Attributed traffic: the named mission's own grant is the only
		//    authority. Another active allowAll mission must not widen it.
		if id := missionHeaderID(r); id != "" && provider.HasMission(id) {
			if provider.MissionAllows(id, u, connect) {
				return modeTarget, nil
			}
			if p.internetAllows(u) {
				return modeInternet, nil
			}
			return "", scopeDenied("target %q is outside the authorized scope", u.Host)
		}
		// 2) Unattributed traffic (bash/curl/scripts): only grants that name a
		//    concrete host/domain can authorize it. allowAll missions never do,
		//    unless they are the single active mission (unambiguous owner).
		if provider.MissionForURL(u, connect) != "" {
			return modeTarget, nil
		}
		if p.internetAllows(u) {
			return modeInternet, nil
		}
		if _, single := provider.SingleUnrestrictedMission(); single {
			return modeTarget, nil
		}
		return "", scopeDenied("target %q is outside the authorized scope", u.Host)
	}
	if scope := p.currentScope(); scope != nil {
		var err error
		if connect {
			err = scope.CheckConnect(u.Host)
		} else {
			err = scope.CheckURL(u)
		}
		if err == nil {
			return modeTarget, nil
		}
	}
	if p.internetAllows(u) {
		return modeInternet, nil
	}
	return "", scopeDenied("target %q is outside the authorized scope", u.Host)
}

// internetAllows keeps the internet allowlist check in one place so the
// per-mission and union paths cannot drift.
func (p *Proxy) internetAllows(u *url.URL) bool {
	host, err := canonicalHostname(u.Hostname())
	return err == nil && p.internet != nil && p.internet.Allows(host)
}

func (p *Proxy) rejectPolicyRate(w http.ResponseWriter, r *http.Request, host string) {
	writeJSON(w, http.StatusTooManyRequests, map[string]string{
		"blocked_by": "platform",
		"reason":     fmt.Sprintf("【SRC-Agent 平台管控·策略门限】主机 %s 超过每分钟 %d 次请求上限，已阻断本次出站访问。", host, p.ratePerMin),
	})
}

func (p *Proxy) reject(w http.ResponseWriter, r *http.Request, mode trafficMode, err error) {
	writeBlock(w)
}

func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Health probe for docker-compose; only direct (non-proxied) requests to
	// /healthz are answered so it can never be confused with target traffic.
	if r.URL.Host == "" && r.URL.Path == "/healthz" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "service": "src-agent-proxy"})
		return
	}
	if r.Method == http.MethodConnect {
		p.handleConnect(w, r)
		return
	}
	p.handleHTTP(w, r)
}

func (p *Proxy) handleHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Scheme == "" {
		r.URL.Scheme = "http"
	}
	if r.URL.Host == "" {
		r.URL.Host = r.Host
	}
	auth, classErr := p.authorize(r, r.URL, false)
	if classErr != nil {
		p.reject(w, r, auth.mode, classErr)
		return
	}
	if !p.allowRate(r.URL.Hostname()) {
		p.rejectPolicyRate(w, r, r.URL.Hostname())
		return
	}
	if upgradeRequested(r.Header) {
		writeJSON(w, http.StatusForbidden, map[string]string{
			"blocked_by": "platform",
			"reason":     "【SRC-Agent 平台管控·非目标防御】仅允许可校验、可留痕的 HTTP/HTTPS 流量，已拒绝协议升级。",
		})
		return
	}

	requestBody, err := newCaptureBody(r.Body)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "could not read request body"})
		return
	}
	defer requestBody.close()
	requestReader, err := requestBody.reader()
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "could not replay request body"})
		return
	}
	requestContext := context.WithValue(r.Context(), modeContextKey, auth.mode)
	if auth.scope != nil {
		requestContext = context.WithValue(requestContext, scopeContextKey, auth.scope)
	}
	outbound := r.Clone(requestContext)
	outbound.RequestURI = ""
	outbound.URL = cloneURL(r.URL)
	outbound.Header = r.Header.Clone()
	removeHopByHopHeaders(outbound.Header)
	// Internal mission attribution must never leak to the target. The audit
	// record reads it before this hop; only the proxy knows the mission join key.
	outbound.Header.Del("X-SRC-Mission-Id")
	outbound.Header.Del("X-SRC-Task-Id")
	outbound.Body = io.NopCloser(requestReader)
	outbound.ContentLength = requestBody.size
	outbound.TransferEncoding = nil
	outbound.Trailer = nil

	resp, err := p.client.Do(outbound)
	if err != nil {
		var scopeErr *ScopeError
		if errors.As(err, &scopeErr) {
			p.reject(w, r, auth.mode, scopeErr)
			return
		}
		log.Printf("upstream request failed method=%s host=%s error=%v", r.Method, r.URL.Host, err)
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "upstream request failed"})
		return
	}
	defer resp.Body.Close()
	responseBody, err := newCaptureBody(resp.Body)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "could not read upstream response"})
		return
	}
	defer responseBody.close()

	requestReplay, err := requestBody.reader()
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "could not replay request body"})
		return
	}
	responseReader, err := responseBody.reader()
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "could not replay upstream response"})
		return
	}

	responseHeader := resp.Header.Clone()
	removeHopByHopHeaders(responseHeader)
	record := TrafficRecord{
		Timestamp:      time.Now().UTC(),
		Kind:           string(auth.mode),
		MissionID:      p.missionForRequest(r, outbound.URL, auth.mode),
		TaskID:         taskIDForRequest(r),
		Method:         r.Method,
		URL:            outbound.URL.String(),
		StatusCode:     resp.StatusCode,
		RequestHeader:  outbound.Header.Clone(),
		ResponseHeader: responseHeader.Clone(),
		RequestBody:    BodyCapture{Reader: requestReplay, SHA256: requestBody.hash, Size: requestBody.size},
		ResponseBody:   BodyCapture{Reader: responseReader, SHA256: responseBody.hash, Size: responseBody.size},
		RequestSHA256:  requestBody.hash,
		ResponseSHA256: responseBody.hash,
	}
	// Audit is lightweight metadata (no bodies). A write failure is logged
	// rather than turned into a 502: the exchange itself was authorized and
	// evidence for findings is captured separately by the worker's report.
	if p.recorder != nil {
		if recordingErr := p.recorder.Record(r.Context(), record); recordingErr != nil {
			log.Printf("traffic audit failed method=%s host=%s error=%v", r.Method, r.URL.Host, recordingErr)
		}
	}

	responseReplay, err := responseBody.reader()
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "could not replay upstream response"})
		return
	}
	copyHeader(w.Header(), responseHeader)
	w.WriteHeader(resp.StatusCode)
	if r.Method != http.MethodHead {
		_, _ = io.Copy(w, responseReplay)
	}
}

func (p *Proxy) handleConnect(w http.ResponseWriter, r *http.Request) {
	authority := r.Host
	if authority == "" && r.URL != nil {
		authority = r.URL.Host
	}
	connectURL := &url.URL{Scheme: "https", Host: authority}
	mode, classErr := p.classify(r, connectURL, true)
	if classErr != nil {
		p.reject(w, r, mode, classErr)
		return
	}
	_ = mode
	if !p.allowRate(connectURL.Hostname()) {
		p.rejectPolicyRate(w, r, connectURL.Hostname())
		return
	}
	if p.certs == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "TLS interception is not configured"})
		return
	}
	connectHost, _, err := net.SplitHostPort(authority)
	if err != nil {
		writeBlock(w)
		return
	}

	hijacker, ok := w.(http.Hijacker)
	if !ok {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "connection interception is unavailable"})
		return
	}
	clientConn, _, err := hijacker.Hijack()
	if err != nil {
		return
	}
	defer clientConn.Close()
	_ = clientConn.SetDeadline(time.Now().Add(15 * time.Second))
	if _, err := io.WriteString(clientConn, "HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
		return
	}

	tlsConn := tls.Server(clientConn, p.certs.TLSConfig(connectHost))
	if err := tlsConn.SetDeadline(time.Now().Add(15 * time.Second)); err != nil {
		return
	}
	if err := tlsConn.Handshake(); err != nil {
		log.Printf("intercepted TLS handshake failed host=%s error=%v", connectHost, err)
		return
	}
	_ = tlsConn.SetDeadline(time.Time{})

	listener := newSingleConnListener(tlsConn)
	innerServer := &http.Server{
		ReadHeaderTimeout: 15 * time.Second,
		ReadTimeout:       5 * time.Minute,
		WriteTimeout:      5 * time.Minute,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    1 << 20,
		ConnState: func(_ net.Conn, state http.ConnState) {
			if state == http.StateClosed || state == http.StateHijacked {
				listener.connectionDone()
			}
		},
		Handler: http.HandlerFunc(func(innerW http.ResponseWriter, innerReq *http.Request) {
			if innerReq.URL.Scheme == "" {
				innerReq.URL.Scheme = "https"
			}
			if innerReq.URL.Host == "" {
				innerReq.URL.Host = innerReq.Host
			}
			p.handleHTTP(innerW, innerReq)
		}),
	}
	_ = innerServer.Serve(listener)
}

func (p *Proxy) dialContext(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, fmt.Errorf("invalid upstream address: %w", err)
	}
	canonicalHost, err := canonicalHostname(host)
	if err != nil {
		return nil, scopeDenied("invalid upstream hostname")
	}

	var ips []netip.Addr
	if addr, err := netip.ParseAddr(canonicalHost); err == nil {
		ips = []netip.Addr{addr}
	} else {
		ips, err = p.resolver.LookupNetIP(ctx, "ip", canonicalHost)
		if err != nil {
			return nil, fmt.Errorf("DNS lookup for upstream failed: %w", err)
		}
	}
	mode, _ := ctx.Value(modeContextKey).(trafficMode)
	if p.openEgress {
		// Dial-time checks are disabled in open mode; the audit recorder still
		// records method/url/status/hash for every exchange.
		mode = modeTarget
	}
	switch mode {
	case modeTarget:
		if !p.openEgress {
			scope, _ := ctx.Value(scopeContextKey).(*Scope)
			if scope == nil {
				// Legacy/static path: fall back to the configured env scope.
				scope = p.currentScope()
			}
			if scope == nil {
				return nil, scopeDenied("no active target scope")
			}
			if err := scope.CheckResolvedIPs(canonicalHost, ips); err != nil {
				return nil, err
			}
		}
	case modeInternet:
		if !p.openEgress {
			for _, addr := range ips {
				if !isPublicIP(addr) {
					return nil, scopeDenied("internet egress to %q resolved to non-public address %s", canonicalHost, addr)
				}
			}
		}
	default:
		return nil, scopeDenied("unclassified upstream request")
	}

	// Transport-only mapping for local lab targets. The scope/audit identity is
	// still the original target host; only the dial address changes.
	dialPort := port
	if mapped, ok := p.connectOverrides[net.JoinHostPort(canonicalHost, port)]; ok {
		mappedHost, mappedPort, splitErr := net.SplitHostPort(mapped)
		if splitErr != nil {
			return nil, fmt.Errorf("invalid connect override %q: %w", mapped, splitErr)
		}
		canonicalHost = mappedHost
		ips = nil
		if addr, parseErr := netip.ParseAddr(canonicalHost); parseErr == nil {
			ips = []netip.Addr{addr}
		} else {
			ips, err = p.resolver.LookupNetIP(ctx, "ip", canonicalHost)
			if err != nil {
				return nil, fmt.Errorf("DNS lookup for connect override failed: %w", err)
			}
		}
		dialPort = mappedPort
	} else if mapped, ok := p.connectOverrides[canonicalHost]; ok {
		mappedHost, mappedPort, splitErr := net.SplitHostPort(mapped)
		if splitErr != nil {
			return nil, fmt.Errorf("invalid connect override %q: %w", mapped, splitErr)
		}
		canonicalHost = mappedHost
		ips = nil
		if addr, parseErr := netip.ParseAddr(canonicalHost); parseErr == nil {
			ips = []netip.Addr{addr}
		} else {
			ips, err = p.resolver.LookupNetIP(ctx, "ip", canonicalHost)
			if err != nil {
				return nil, fmt.Errorf("DNS lookup for connect override failed: %w", err)
			}
		}
		dialPort = mappedPort
	}

	// Check every answer above before dialing any of them. Only the validated
	// IP reaches net.Dialer, closing the lookup-to-connect rebinding race.
	var lastErr error
	for _, addr := range ips {
		addr = addr.Unmap()
		conn, err := p.dialer.DialContext(ctx, network, net.JoinHostPort(addr.String(), dialPort))
		if err == nil {
			return conn, nil
		}
		lastErr = err
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("no usable upstream address")
	}
	return nil, lastErr
}

func (p *Proxy) CloseIdleConnections() {
	if p != nil && p.transport != nil {
		p.transport.CloseIdleConnections()
	}
}

func cloneURL(input *url.URL) *url.URL {
	copy := *input
	return &copy
}

func writeBlock(w http.ResponseWriter) {
	writeJSON(w, http.StatusForbidden, map[string]string{
		"blocked_by": "platform",
		"reason":     blockReason,
	})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func copyHeader(destination, source http.Header) {
	for key, values := range source {
		for _, value := range values {
			destination.Add(key, value)
		}
	}
}

func removeHopByHopHeaders(header http.Header) {
	for _, connection := range header.Values("Connection") {
		for _, name := range strings.Split(connection, ",") {
			header.Del(strings.TrimSpace(name))
		}
	}
	for _, name := range []string{
		"Connection", "Proxy-Connection", "Keep-Alive", "Proxy-Authenticate",
		"Proxy-Authorization", "Te", "Trailer", "Transfer-Encoding", "Upgrade",
	} {
		header.Del(name)
	}
}

func upgradeRequested(header http.Header) bool {
	return strings.Contains(strings.ToLower(header.Get("Upgrade")), "websocket") ||
		strings.Contains(strings.ToLower(header.Get("Connection")), "upgrade")
}

// singleConnListener lets the standard net/http server handle keep-alive,
// framing, and responses on an already-intercepted TLS connection.
type singleConnListener struct {
	conn     net.Conn
	accepted bool
	done     chan struct{}
	once     sync.Once
	mu       sync.Mutex
}

func newSingleConnListener(conn net.Conn) *singleConnListener {
	return &singleConnListener{conn: conn, done: make(chan struct{})}
}

func (l *singleConnListener) Accept() (net.Conn, error) {
	l.mu.Lock()
	if !l.accepted {
		l.accepted = true
		l.mu.Unlock()
		return l.conn, nil
	}
	l.mu.Unlock()
	<-l.done
	return nil, net.ErrClosed
}

func (l *singleConnListener) Close() error {
	l.connectionDone()
	return l.conn.Close()
}

func (l *singleConnListener) Addr() net.Addr { return l.conn.LocalAddr() }

func (l *singleConnListener) connectionDone() {
	l.once.Do(func() { close(l.done) })
}

// The intercepted connection remains a net.Conn handled by net/http.
var _ net.Conn = (*tls.Conn)(nil)
