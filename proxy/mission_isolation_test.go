package main

import (
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"testing"
)

func mustURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse %q: %v", raw, err)
	}
	return u
}

// isolationProvider mirrors dbScopeProvider's per-mission authorization without
// a database, so the scope-mode classification rules can be unit tested.
type isolationProvider struct {
	missions []isolationMission
}

type isolationMission struct {
	id       string
	scope    *Scope
	allowAll bool
}

// Current mirrors dbScopeProvider: the union becomes unrestricted as soon as
// one active mission carries allowAll.
func (p *isolationProvider) Current() *Scope {
	for _, m := range p.missions {
		if m.allowAll {
			return NewUnrestrictedScope()
		}
	}
	return nil
}

func (p *isolationProvider) HasMission(id string) bool {
	for _, m := range p.missions {
		if m.id == id {
			return true
		}
	}
	return false
}

func (p *isolationProvider) MissionForURL(u *url.URL, _ bool) string {
	for _, m := range p.missions {
		if m.allowAll {
			continue
		}
		if m.scope.CheckURL(u) == nil {
			return m.id
		}
	}
	return ""
}

func (p *isolationProvider) MissionAllows(id string, u *url.URL, _ bool) bool {
	for _, m := range p.missions {
		if m.id == id {
			return m.scope.CheckURL(u) == nil
		}
	}
	return false
}

func (p *isolationProvider) MissionScope(id string) *Scope {
	for _, m := range p.missions {
		if m.id == id {
			return m.scope
		}
	}
	return nil
}

func (p *isolationProvider) SingleUnrestrictedMission() (string, bool) {
	if len(p.missions) != 1 || !p.missions[0].allowAll {
		return "", false
	}
	return p.missions[0].id, true
}

func (p *isolationProvider) MissionID() string {
	if len(p.missions) == 0 {
		return ""
	}
	return p.missions[0].id
}

const (
	targetMissionID    = "11111111-1111-4111-8111-111111111111"
	attachMissionID    = "33333333-3333-4333-8333-333333333333"
	unrelatedMissionID = "44444444-4444-4444-8444-444444444444"
)

func isolationProxy(t *testing.T) (*Proxy, *isolationProvider) {
	t.Helper()
	targetScope := mustScope(t, []string{"target.test"}, []string{"127.0.0.0/8"}, nil)
	provider := &isolationProvider{missions: []isolationMission{
		{id: targetMissionID, scope: targetScope},
		{id: attachMissionID, scope: NewUnrestrictedScope(), allowAll: true},
	}}
	proxy := NewProxy(targetScope, nil, nil)
	proxy.SetScopeProvider(provider)
	proxy.resolver = loopbackResolver()
	return proxy, provider
}

func classifyWithHeader(proxy *Proxy, rawURL, missionID string) (trafficMode, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		panic(err)
	}
	req := httptest.NewRequest("GET", u.String(), nil)
	if missionID != "" {
		req.Header.Set("X-SRC-Mission-Id", missionID)
	}
	return proxy.classify(req, u, false)
}

// Regression: an active allowAll (attachment-only) mission used to turn the
// union scope into "allow everything" for every mission. Headerless traffic
// must not be authorized by an allowAll grant while another mission is active.
func TestAllowAllMissionDoesNotWidenHeaderlessTraffic(t *testing.T) {
	proxy, _ := isolationProxy(t)
	if mode, err := classifyWithHeader(proxy, "http://unrelated.test/secret", ""); err == nil {
		t.Fatalf("headerless out-of-scope traffic must be denied while allowAll mission is active, got mode=%q", mode)
	}
	// The target mission still works without a header (bash inside that mission).
	if mode, err := classifyWithHeader(proxy, "http://target.test/api", ""); err != nil || mode != modeTarget {
		t.Fatalf("target traffic mode=%q err=%v", mode, err)
	}
}

// A request attributed to a restricted mission must stay inside that mission's
// own grant even though another active mission carries allowAll.
func TestAttributedMissionIsLimitedToItsOwnGrant(t *testing.T) {
	proxy, _ := isolationProxy(t)
	if mode, err := classifyWithHeader(proxy, "http://unrelated.test/secret", targetMissionID); err == nil {
		t.Fatalf("target mission must not reach out-of-scope host, got mode=%q", mode)
	}
	if mode, err := classifyWithHeader(proxy, "http://target.test/api", targetMissionID); err != nil || mode != modeTarget {
		t.Fatalf("in-scope attributed traffic mode=%q err=%v", mode, err)
	}
}

// The allowAll grant authorizes only traffic attributed to its own mission.
func TestAttributedAllowAllMissionReachesAnyHost(t *testing.T) {
	proxy, _ := isolationProxy(t)
	if mode, err := classifyWithHeader(proxy, "http://unrelated.test/anything", attachMissionID); err != nil || mode != modeTarget {
		t.Fatalf("allowAll mission traffic mode=%q err=%v", mode, err)
	}
}

// With exactly one active allowAll mission there is no ambiguity about the
// owner, so bash/curl traffic inside that mission keeps working.
func TestSingleAllowAllMissionAuthorizesUnattributedTraffic(t *testing.T) {
	scope := NewUnrestrictedScope()
	provider := &isolationProvider{missions: []isolationMission{{id: attachMissionID, scope: scope, allowAll: true}}}
	proxy := NewProxy(scope, nil, nil)
	proxy.SetScopeProvider(provider)
	proxy.resolver = loopbackResolver()
	if mode, err := classifyWithHeader(proxy, "http://unrelated.test/anything", ""); err != nil || mode != modeTarget {
		t.Fatalf("single allowAll mission mode=%q err=%v", mode, err)
	}
	if got := proxy.missionForRequest(httptest.NewRequest("GET", "http://unrelated.test/x", nil), mustURL(t, "http://unrelated.test/x"), modeTarget); got != attachMissionID {
		t.Fatalf("audit attribution = %q, want %q", got, attachMissionID)
	}
	if _, single := provider.SingleUnrestrictedMission(); !single {
		t.Fatal("single allowAll mission must report as unambiguous owner")
	}
}

func TestMissionForURLIgnoresAllowAllGrants(t *testing.T) {
	_, provider := isolationProxy(t)
	if id := provider.MissionForURL(mustURL(t, "http://unrelated.test/x"), false); id != "" {
		t.Fatalf("allowAll mission must not be matched by URL, got %q", id)
	}
	if id := provider.MissionForURL(mustURL(t, "http://target.test/x"), false); id != targetMissionID {
		t.Fatalf("target mission match = %q", id)
	}
}

// End-to-end: the proxy answers 403 for out-of-scope traffic from a restricted
// mission while an allowAll mission is active, and never dials the upstream.
func TestProxyBlocksCrossMissionAllowAllBypass(t *testing.T) {
	proxy, _ := isolationProxy(t)
	var hits int
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits++
		_, _ = w.Write([]byte("secret"))
	}))
	defer upstream.Close()
	proxy.resolver = &stubResolver{answers: map[string][]netip.Addr{
		"target.test":    {netip.MustParseAddr("127.0.0.1")},
		"outside.test":   {netip.MustParseAddr("127.0.0.1")},
		"unrelated.test": {netip.MustParseAddr("127.0.0.1")},
	}}

	server := httptest.NewServer(proxy)
	defer server.Close()
	proxyURL, _ := url.Parse(server.URL)
	client := proxyClient(t, proxyURL, nil)

	req, _ := http.NewRequest("GET", "http://unrelated.test/secret", nil)
	req.Header.Set("X-SRC-Mission-Id", targetMissionID)
	response, err := client.Do(req)
	if err != nil {
		t.Fatalf("proxy request: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", response.StatusCode)
	}
	if hits != 0 {
		t.Fatalf("upstream must not be dialed, hits=%d", hits)
	}
}

// The real provider snapshot must keep allowAll out of URL matching and expose
// per-mission authorization regardless of what the union scope says.
func TestDBScopeProviderSnapshotIsolatesAllowAll(t *testing.T) {
	targetScope := mustScope(t, []string{"target.test"}, []string{"127.0.0.0/8"}, nil)
	provider := &dbScopeProvider{}
	snapshot := []missionScope{
		{missionID: targetMissionID, scope: targetScope},
		{missionID: attachMissionID, scope: NewUnrestrictedScope(), allowAll: true},
	}
	provider.missions.Store(&snapshot)

	if id := provider.MissionForURL(mustURL(t, "http://unrelated.test/x"), false); id != "" {
		t.Fatalf("allowAll grant must not authorize headerless traffic, got mission %q", id)
	}
	if !provider.MissionAllows(attachMissionID, mustURL(t, "http://unrelated.test/x"), false) {
		t.Fatal("allowAll grant must authorize its own attributed traffic")
	}
	if provider.MissionAllows(targetMissionID, mustURL(t, "http://unrelated.test/x"), false) {
		t.Fatal("restricted mission must not inherit allowAll")
	}
	if _, single := provider.SingleUnrestrictedMission(); single {
		t.Fatal("two active missions must not be treated as an unambiguous owner")
	}

	only := []missionScope{{missionID: attachMissionID, scope: NewUnrestrictedScope(), allowAll: true}}
	provider.missions.Store(&only)
	if id, single := provider.SingleUnrestrictedMission(); !single || id != attachMissionID {
		t.Fatalf("single allowAll mission = %q/%v", id, single)
	}
}

// Dial-time DNS pinning must use the mission's own grant. Regression: the
// union scope became unrestricted while an allowAll mission was active, so a
// restricted mission could rebind its allowed hostname to an internal address.
func TestDialTimePinningUsesMissionGrantNotUnion(t *testing.T) {
	restricted := mustScope(t, []string{"allowed.test"}, []string{"10.0.0.0/8"}, nil)
	provider := &isolationProvider{missions: []isolationMission{
		{id: targetMissionID, scope: restricted},
		{id: attachMissionID, scope: NewUnrestrictedScope(), allowAll: true},
	}}
	proxy := NewProxy(restricted, nil, nil)
	proxy.SetScopeProvider(provider)
	// allowed.test is authorized by name but resolves to loopback, which is not
	// in the mission's IP grant.
	proxy.resolver = &stubResolver{answers: map[string][]netip.Addr{
		"allowed.test": {netip.MustParseAddr("127.0.0.1")},
	}}
	var hits int
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits++
		_, _ = w.Write([]byte("internal"))
	}))
	defer upstream.Close()

	server := httptest.NewServer(proxy)
	defer server.Close()
	proxyURL, _ := url.Parse(server.URL)
	client := proxyClient(t, proxyURL, nil)

	req, _ := http.NewRequest("GET", "http://allowed.test/probe", nil)
	req.Header.Set("X-SRC-Mission-Id", targetMissionID)
	response, err := client.Do(req)
	if err != nil {
		t.Fatalf("proxy request: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 from dial-time pinning, got %d", response.StatusCode)
	}
	if hits != 0 {
		t.Fatalf("rebinding reached upstream, hits=%d", hits)
	}
}
