package main

import (
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"strings"
)

// ScopeError marks an authorization failure. The proxy turns it into a 403
// system_block response instead of forwarding the request.
type ScopeError struct {
	Reason string
}

func (e *ScopeError) Error() string { return e.Reason }

func scopeDenied(format string, args ...any) error {
	return &ScopeError{Reason: fmt.Sprintf(format, args...)}
}

type urlPrefix struct {
	scheme    string
	authority string
	path      string
}

// Scope is an immutable authorization allowlist. Domain suffixes include the
// suffix itself and its subdomains, never authority lookalikes.
type Scope struct {
	domainSuffixes []string
	ipRanges       []netip.Prefix
	urlPrefixes    []urlPrefix
	// AllowAll is set only for attachment-only missions whose operator chose
	// unrestricted audited egress. Every request still goes through the proxy.
	AllowAll bool
}

// NewUnrestrictedScope is used only when an active mission grant explicitly
// carries allowAll=true. It must not be used for env-configured scopes.
func NewUnrestrictedScope() *Scope {
	return &Scope{AllowAll: true}
}

func NewScope(domains, ips, prefixes []string) (*Scope, error) {
	s := &Scope{}
	for _, raw := range domains {
		name := strings.ToLower(strings.TrimSpace(raw))
		name = strings.TrimPrefix(name, "*.")
		name = strings.TrimSuffix(strings.TrimPrefix(name, "."), ".")
		// An IP literal in the domain list is a common config shape; treat it
		// as an exact /32 (or /128) address grant instead of rejecting startup.
		if addr, err := netip.ParseAddr(name); err == nil {
			s.ipRanges = append(s.ipRanges, netip.PrefixFrom(addr, addr.BitLen()).Masked())
			continue
		}
		if !validDNSName(name) {
			return nil, fmt.Errorf("invalid scope domain %q", raw)
		}
		s.domainSuffixes = append(s.domainSuffixes, name)
	}
	for _, raw := range ips {
		value := strings.TrimSpace(raw)
		prefix, err := netip.ParsePrefix(value)
		if err != nil {
			addr, addrErr := netip.ParseAddr(value)
			if addrErr != nil {
				return nil, fmt.Errorf("invalid scope IP range %q", raw)
			}
			prefix = netip.PrefixFrom(addr, addr.BitLen())
		}
		s.ipRanges = append(s.ipRanges, prefix.Masked())
	}
	for _, raw := range prefixes {
		u, err := url.Parse(strings.TrimSpace(raw))
		if err != nil {
			return nil, fmt.Errorf("invalid scope URL prefix %q: %w", raw, err)
		}
		if err := validateAbsoluteHTTPURL(u); err != nil {
			return nil, fmt.Errorf("invalid scope URL prefix %q: %w", raw, err)
		}
		if u.RawQuery != "" || u.ForceQuery || u.Fragment != "" {
			return nil, fmt.Errorf("invalid scope URL prefix %q: query and fragment are not allowed", raw)
		}
		authority, err := canonicalAuthority(u)
		if err != nil {
			return nil, fmt.Errorf("invalid scope URL prefix %q: %w", raw, err)
		}
		s.urlPrefixes = append(s.urlPrefixes, urlPrefix{
			scheme:    strings.ToLower(u.Scheme),
			authority: authority,
			path:      u.EscapedPath(),
		})
	}
	if len(s.domainSuffixes)+len(s.ipRanges)+len(s.urlPrefixes) == 0 {
		return nil, fmt.Errorf("scope is empty; refusing to start an unrestricted proxy")
	}
	return s, nil
}

// CheckURL validates the exact request target, including its scheme, authority,
// and any configured URL-prefix restriction.
func (s *Scope) CheckURL(u *url.URL) error {
	return s.checkURL(u, false)
}

// CheckConnect authorizes only the CONNECT authority. URL paths are checked
// after TLS interception, when the inner HTTP request is available.
func (s *Scope) CheckConnect(authority string) error {
	if _, _, err := net.SplitHostPort(authority); err != nil {
		return scopeDenied("invalid CONNECT authority")
	}
	u := &url.URL{Scheme: "https", Host: authority}
	return s.checkURL(u, true)
}

func (s *Scope) checkURL(u *url.URL, authorityOnly bool) error {
	if s.AllowAll {
		return nil
	}
	if err := validateAbsoluteHTTPURL(u); err != nil {
		return scopeDenied("invalid request target: %v", err)
	}
	hostname, err := canonicalHostname(u.Hostname())
	if err != nil {
		return scopeDenied("invalid request hostname")
	}

	if addr, err := netip.ParseAddr(hostname); err == nil {
		if s.ipAllowed(addr) {
			return nil
		}
	} else {
		for _, suffix := range s.domainSuffixes {
			if hostname == suffix || strings.HasSuffix(hostname, "."+suffix) {
				return nil
			}
		}
	}

	authority, err := canonicalAuthority(u)
	if err != nil {
		return scopeDenied("invalid request authority")
	}
	path := u.EscapedPath()
	if path == "" {
		path = "/"
	}
	for _, prefix := range s.urlPrefixes {
		if prefix.scheme != strings.ToLower(u.Scheme) || prefix.authority != authority {
			continue
		}
		if authorityOnly || prefix.path == "" || strings.HasPrefix(path, prefix.path) {
			return nil
		}
	}
	return scopeDenied("target %q is outside the authorized scope", u.Host)
}

// CheckResolvedIPs must run after CheckURL. Every answer is checked before any
// socket is opened. Public addresses are valid for an authorized hostname;
// private, local, reserved, and documentation addresses additionally require an
// explicit SCOPE_IPS grant. This prevents an authorized DNS name from rebounding
// to loopback, link-local, or internal services.
func (s *Scope) CheckResolvedIPs(host string, ips []netip.Addr) error {
	if s.AllowAll {
		return nil
	}
	if len(ips) == 0 {
		return scopeDenied("DNS returned no addresses for %q", host)
	}
	for _, addr := range ips {
		if !addr.IsValid() {
			return scopeDenied("DNS returned an invalid address for %q", host)
		}
		addr = addr.Unmap()
		if s.ipAllowed(addr) {
			continue
		}
		if !isPublicIP(addr) {
			return scopeDenied("resolved address %s for %q is not explicitly authorized", addr, host)
		}
	}
	return nil
}

func (s *Scope) ipAllowed(addr netip.Addr) bool {
	addr = addr.Unmap()
	for _, prefix := range s.ipRanges {
		if prefix.Contains(addr) {
			return true
		}
	}
	return false
}

func validateAbsoluteHTTPURL(u *url.URL) error {
	if u == nil || u.Opaque != "" || u.Host == "" || u.Hostname() == "" {
		return fmt.Errorf("absolute HTTP URL with a hostname is required")
	}
	if u.User != nil {
		return fmt.Errorf("URL userinfo is not allowed")
	}
	switch strings.ToLower(u.Scheme) {
	case "http", "https":
	default:
		return fmt.Errorf("unsupported URL scheme %q", u.Scheme)
	}
	if _, err := canonicalAuthority(u); err != nil {
		return err
	}
	return nil
}

func canonicalAuthority(u *url.URL) (string, error) {
	host, err := canonicalHostname(u.Hostname())
	if err != nil {
		return "", err
	}
	port := u.Port()
	if port == "" {
		if strings.EqualFold(u.Scheme, "https") {
			port = "443"
		} else {
			port = "80"
		}
	}
	return net.JoinHostPort(host, port), nil
}

func canonicalHostname(host string) (string, error) {
	host = strings.ToLower(strings.TrimSuffix(strings.TrimSpace(host), "."))
	if host == "" || strings.ContainsAny(host, "/\\@") {
		return "", fmt.Errorf("invalid hostname")
	}
	if addr, err := netip.ParseAddr(host); err == nil {
		if addr.Zone() != "" {
			return "", fmt.Errorf("IP zones are not allowed")
		}
		return addr.Unmap().String(), nil
	}
	if !validDNSName(host) {
		return "", fmt.Errorf("invalid hostname")
	}
	return host, nil
}

func validDNSName(name string) bool {
	if len(name) == 0 || len(name) > 253 || net.ParseIP(name) != nil {
		return false
	}
	for _, label := range strings.Split(name, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, r := range label {
			if (r < 'a' || r > 'z') && (r < '0' || r > '9') && r != '-' && r != '_' {
				return false
			}
		}
	}
	return true
}

var nonPublicRanges = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("192.88.99.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("2001::/23"),
	netip.MustParsePrefix("2001:db8::/32"),
}

func isPublicIP(addr netip.Addr) bool {
	addr = addr.Unmap()
	if !addr.IsGlobalUnicast() || addr.IsPrivate() || addr.IsLoopback() ||
		addr.IsLinkLocalUnicast() || addr.IsLinkLocalMulticast() || addr.IsMulticast() || addr.IsUnspecified() {
		return false
	}
	for _, prefix := range nonPublicRanges {
		if prefix.Contains(addr) {
			return false
		}
	}
	return true
}
