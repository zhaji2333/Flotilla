package main

import (
	"net/netip"
	"net/url"
	"testing"
)

func mustScope(t *testing.T, domains, ips, prefixes []string) *Scope {
	t.Helper()
	s, err := NewScope(domains, ips, prefixes)
	if err != nil {
		t.Fatalf("NewScope: %v", err)
	}
	return s
}

func parseURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("url.Parse(%q): %v", raw, err)
	}
	return u
}

func TestScopeDomainSuffixUsesLabelBoundaries(t *testing.T) {
	s := mustScope(t, []string{"Example.COM."}, nil, nil)

	for _, raw := range []string{
		"https://example.com/",
		"https://api.example.com:8443/path",
		"https://EXAMPLE.COM./path",
	} {
		if err := s.CheckURL(parseURL(t, raw)); err != nil {
			t.Errorf("CheckURL(%q) unexpectedly denied: %v", raw, err)
		}
	}

	for _, raw := range []string{
		"https://notexample.com/",
		"https://example.com.evil.test/",
		"https://evil.test/?next=example.com",
		"https://user@example.com@evil.test/",
		"ftp://example.com/file",
	} {
		if err := s.CheckURL(parseURL(t, raw)); err == nil {
			t.Errorf("CheckURL(%q) unexpectedly allowed", raw)
		}
	}
}

func TestScopeIPRanges(t *testing.T) {
	s := mustScope(t, nil, []string{"10.20.0.0/16", "2001:db8::/32"}, nil)

	for _, raw := range []string{"http://10.20.3.4/", "http://[2001:db8::1]:8080/"} {
		if err := s.CheckURL(parseURL(t, raw)); err != nil {
			t.Errorf("CheckURL(%q) unexpectedly denied: %v", raw, err)
		}
	}
	for _, raw := range []string{"http://10.21.3.4/", "http://127.0.0.1/", "http://[2001:db9::1]/"} {
		if err := s.CheckURL(parseURL(t, raw)); err == nil {
			t.Errorf("CheckURL(%q) unexpectedly allowed", raw)
		}
	}
}

func TestScopeURLPrefixDoesNotTrustAuthorityLookalikes(t *testing.T) {
	s := mustScope(t, nil, nil, []string{"https://Example.com:443/allowed/"})

	for _, raw := range []string{
		"https://example.com/allowed/resource",
		"https://example.com:443/allowed/",
	} {
		if err := s.CheckURL(parseURL(t, raw)); err != nil {
			t.Errorf("CheckURL(%q) unexpectedly denied: %v", raw, err)
		}
	}

	for _, raw := range []string{
		"http://example.com/allowed/resource",
		"https://example.com:444/allowed/resource",
		"https://example.com.evil.test/allowed/resource",
		"https://sub.example.com/allowed/resource",
		"https://example.com/other/allowed/resource",
		"https://example.com/allowed",
	} {
		if err := s.CheckURL(parseURL(t, raw)); err == nil {
			t.Errorf("CheckURL(%q) unexpectedly allowed", raw)
		}
	}
}

func TestScopeResolvedIPRejectsRebindingToNonPublicAddresses(t *testing.T) {
	s := mustScope(t, []string{"example.com"}, nil, nil)

	for _, raw := range []string{
		"127.0.0.1", "10.0.0.8", "169.254.169.254", "100.64.0.1",
		"192.0.2.10", "198.18.0.1", "::1", "fe80::1", "fc00::1", "2001:db8::1",
		"::ffff:127.0.0.1",
	} {
		ip := netip.MustParseAddr(raw)
		if err := s.CheckResolvedIPs("example.com", []netip.Addr{ip}); err == nil {
			t.Errorf("CheckResolvedIPs allowed non-public address %s", raw)
		}
	}

	if err := s.CheckResolvedIPs("example.com", []netip.Addr{netip.MustParseAddr("93.184.216.34")}); err != nil {
		t.Fatalf("public address unexpectedly denied: %v", err)
	}
	if err := s.CheckResolvedIPs("example.com", nil); err == nil {
		t.Fatal("empty DNS result unexpectedly allowed")
	}
}

func TestScopeResolvedIPAllowsExplicitlyAuthorizedPrivateLab(t *testing.T) {
	s := mustScope(t, []string{"example.com"}, []string{"127.0.0.0/8"}, nil)
	ips := []netip.Addr{netip.MustParseAddr("127.0.0.1")}
	if err := s.CheckResolvedIPs("example.com", ips); err != nil {
		t.Fatalf("explicitly authorized lab address denied: %v", err)
	}
}

func TestScopeRejectsEveryRedirectTargetIndependently(t *testing.T) {
	s := mustScope(t, []string{"example.com"}, nil, nil)
	if err := s.CheckURL(parseURL(t, "https://example.com/start")); err != nil {
		t.Fatalf("initial target denied: %v", err)
	}
	if err := s.CheckURL(parseURL(t, "https://outside.test/next")); err == nil {
		t.Fatal("out-of-scope redirect target allowed")
	}
}

func TestNewScopeRejectsInvalidOrEmptyConfiguration(t *testing.T) {
	cases := []struct {
		domains, ips, prefixes []string
	}{
		{},
		{domains: []string{"bad/domain"}},
		{ips: []string{"not-an-ip"}},
		{prefixes: []string{"https://example.com/path?query=ignored"}},
		{prefixes: []string{"file:///tmp/allowed"}},
	}
	for _, tc := range cases {
		if _, err := NewScope(tc.domains, tc.ips, tc.prefixes); err == nil {
			t.Fatalf("NewScope(%v, %v, %v) unexpectedly succeeded", tc.domains, tc.ips, tc.prefixes)
		}
	}
}

func TestUnrestrictedScopeAllowsNetwork(t *testing.T) {
	s := NewUnrestrictedScope()
	for _, raw := range []string{"http://127.0.0.1:65280/api", "https://example.com/", "http://10.9.8.7:8080/"} {
		if err := s.CheckURL(parseURL(t, raw)); err != nil {
			t.Fatalf("unrestricted CheckURL(%q): %v", raw, err)
		}
	}
	if err := s.CheckResolvedIPs("example.com", []netip.Addr{netip.MustParseAddr("127.0.0.1")}); err != nil {
		t.Fatalf("unrestricted CheckResolvedIPs: %v", err)
	}
}
