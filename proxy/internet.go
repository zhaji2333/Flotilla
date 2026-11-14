package main

import (
	"fmt"
	"net/netip"
	"strings"
)

// InternetPolicy governs the "internet retrieval" egress path. Target traffic
// is authorized by the mission grant scope; internet tooling (web.fetch, model
// API access) is a different risk class: it never touches the authorized target,
// so it is checked against an explicit host allowlist and must resolve to
// public addresses only. Empty allowlist means "no internet egress".
type InternetPolicy struct {
	allowedHosts []string
}

func NewInternetPolicy(hosts []string) *InternetPolicy {
	cleaned := make([]string, 0, len(hosts))
	for _, raw := range hosts {
		host := strings.ToLower(strings.TrimSpace(raw))
		host = strings.TrimPrefix(host, "*.")
		host = strings.TrimSuffix(strings.TrimPrefix(host, "."), ".")
		if host == "" {
			continue
		}
		cleaned = append(cleaned, host)
	}
	return &InternetPolicy{allowedHosts: cleaned}
}

// Allows reports whether an internet egress request to host is permitted.
// IP literals are accepted only when globally routable; hostnames must match an
// allowlisted domain suffix on a label boundary.
func (p *InternetPolicy) Allows(host string) bool {
	if p == nil {
		return false
	}
	host = strings.ToLower(strings.TrimSuffix(strings.TrimSpace(host), "."))
	if host == "" {
		return false
	}
	if addr, err := netip.ParseAddr(host); err == nil {
		return isPublicIP(addr)
	}
	if !validDNSName(host) {
		return false
	}
	for _, suffix := range p.allowedHosts {
		if host == suffix || strings.HasSuffix(host, "."+suffix) {
			return true
		}
	}
	return false
}

func (p *InternetPolicy) String() string {
	if p == nil {
		return "internet:disabled"
	}
	return fmt.Sprintf("internet:allowlist=%v", p.allowedHosts)
}
