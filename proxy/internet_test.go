package main

import (
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"testing"
)

func TestInternetPolicyAllowsOnlyAllowlistedPublicHosts(t *testing.T) {
	policy := NewInternetPolicy([]string{"api.deepseek.com", "example.com"})
	cases := []struct {
		host string
		want bool
	}{
		{"api.deepseek.com", true},
		{"sub.example.com", true},
		{"example.com", true},
		{"evil.com", false},
		{"example.com.evil.com", false},
		{"127.0.0.1", false},
		{"10.0.0.1", false},
		{"169.254.169.254", false},
		{"", false},
	}
	for _, testCase := range cases {
		if got := policy.Allows(testCase.host); got != testCase.want {
			t.Errorf("Allows(%q) = %v, want %v", testCase.host, got, testCase.want)
		}
	}
}

func TestInternetPolicyDisabledByDefault(t *testing.T) {
	policy := NewInternetPolicy(nil)
	if policy.Allows("example.com") {
		t.Fatal("empty allowlist must reject all internet egress")
	}
	var nilPolicy *InternetPolicy
	if nilPolicy.Allows("example.com") {
		t.Fatal("nil policy must reject all internet egress")
	}
}

func TestClassifySeparatesTargetAndInternet(t *testing.T) {
	scope := mustScope(t, []string{"target.test"}, []string{"127.0.0.0/8"}, nil)
	proxy := NewProxy(scope, nil, nil)
	proxy.SetInternetPolicy(NewInternetPolicy([]string{"example.com"}))

	targetURL, _ := url.Parse("http://target.test/api")
	if mode, err := proxy.classify(nil, targetURL, false); err != nil || mode != modeTarget {
		t.Fatalf("target host classified mode=%q err=%v", mode, err)
	}

	internetURL, _ := url.Parse("https://example.com/doc")
	if mode, err := proxy.classify(nil, internetURL, false); err != nil || mode != modeInternet {
		t.Fatalf("allowlisted host classified mode=%q err=%v", mode, err)
	}

	outsideURL, _ := url.Parse("https://evil.com/exfil")
	if _, err := proxy.classify(nil, outsideURL, false); err == nil {
		t.Fatal("host outside target scope and internet allowlist must be denied")
	}
}

func TestDeniedInternetHostUsesInternetKind(t *testing.T) {
	scope := mustScope(t, []string{"target.test"}, []string{"127.0.0.0/8"}, nil)
	proxy := NewProxy(scope, nil, nil)
	proxy.SetInternetPolicy(NewInternetPolicy([]string{"example.com"}))
	proxy.resolver = &stubResolver{answers: map[string][]netip.Addr{
		"evil.com": {netip.MustParseAddr("93.184.216.34")},
	}}
	server := httptest.NewServer(proxy)
	defer server.Close()

	proxyURL, _ := url.Parse(server.URL)
	client := proxyClient(t, proxyURL, nil)
	response, err := client.Get("http://evil.com/steal")
	if err != nil {
		t.Fatalf("proxy request: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", response.StatusCode)
	}
}

func TestNewScopeFromGrantsUnionsActiveMissions(t *testing.T) {
	scope, err := newScopeFromGrants([]scopeJSON{
		{DomainSuffixes: []string{"a.test"}, IPs: []string{"10.0.0.1"}},
		{DomainSuffixes: []string{"a.test", "b.test"}},
	})
	if err != nil {
		t.Fatalf("newScopeFromGrants: %v", err)
	}
	u, _ := url.Parse("https://b.test/x")
	if err := scope.CheckURL(u); err != nil {
		t.Fatalf("b.test should be allowed: %v", err)
	}
	u, _ = url.Parse("https://c.test/x")
	if err := scope.CheckURL(u); err == nil {
		t.Fatal("c.test must not be allowed")
	}
	ipURL, _ := url.Parse("http://10.0.0.1/x")
	if err := scope.CheckURL(ipURL); err != nil {
		t.Fatalf("10.0.0.1 should be allowed: %v", err)
	}
}
