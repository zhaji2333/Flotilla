package main

import (
	"context"
	"encoding/json"
	"log"
	"net/url"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// ScopeProvider supplies the target-scope allowlist used by the proxy. The
// deployment can either pin a static scope from environment variables or load
// the union of active mission grants from PostgreSQL, which is what makes
// "target enters the database" take effect at the network boundary.
type ScopeProvider interface {
	Current() *Scope
}

type staticScopeProvider struct {
	scope *Scope
}

func (p staticScopeProvider) Current() *Scope { return p.scope }

// dbScopeProvider refreshes the union of grants attached to active missions.
// A refresh failure keeps the previous snapshot (fail closed relative to broad
// authorization: it never broadens the allowlist on error).
type missionScope struct {
	missionID string
	scope     *Scope
	// allowAll marks unlimited missions (attachment-only). They are authorized
	// only through an explicit X-SRC-Mission-Id attribution or when they are the
	// only active mission, never through the shared union scope.
	allowAll bool
}

type dbScopeProvider struct {
	db       *pgxpool.Pool
	interval time.Duration
	current  atomic.Pointer[Scope]
	missions atomic.Pointer[[]missionScope]
}

func newDBScopeProvider(db *pgxpool.Pool, interval time.Duration) *dbScopeProvider {
	if interval <= 0 {
		interval = 3 * time.Second
	}
	return &dbScopeProvider{db: db, interval: interval}
}

func (p *dbScopeProvider) Current() *Scope { return p.current.Load() }

// MissionForURL resolves the active mission whose grant authorizes this URL.
// It is used only to attach audited traffic to a mission; authorization itself
// still uses the union scope.
func (p *dbScopeProvider) MissionForURL(u *url.URL, connect bool) string {
	missions := p.missions.Load()
	if missions == nil {
		return ""
	}
	for _, item := range *missions {
		// allowAll missions match every URL, so attributing headerless traffic
		// to them would silently authorize it. Only explicit attribution may
		// use an allowAll grant.
		if item.allowAll {
			continue
		}
		var err error
		if connect {
			err = item.scope.CheckConnect(u.Host)
		} else {
			err = item.scope.CheckURL(u)
		}
		if err == nil {
			return item.missionID
		}
	}
	return ""
}

// MissionAllows authorizes one request against a single mission's grant. This
// is the per-mission isolation path: an allowAll mission only ever authorizes
// traffic attributed to itself.
func (p *dbScopeProvider) MissionAllows(id string, u *url.URL, connect bool) bool {
	missions := p.missions.Load()
	if missions == nil {
		return false
	}
	for _, item := range *missions {
		if item.missionID != id {
			continue
		}
		if connect {
			return item.scope.CheckConnect(u.Host) == nil
		}
		return item.scope.CheckURL(u) == nil
	}
	return false
}

// MissionScope returns the immutable scope of one mission. It is used at dial
// time so DNS-rebinding checks use the same grant that authorized the request.
func (p *dbScopeProvider) MissionScope(id string) *Scope {
	missions := p.missions.Load()
	if missions == nil {
		return nil
	}
	for _, item := range *missions {
		if item.missionID == id {
			return item.scope
		}
	}
	return nil
}

// SingleUnrestrictedMission reports the only active mission when it is an
// allowAll mission. Unattributed traffic (bash/curl) has no mission id, so the
// proxy accepts it only in this unambiguous single-mission case; once a second
// mission is active such traffic must carry X-SRC-Mission-Id.
func (p *dbScopeProvider) SingleUnrestrictedMission() (string, bool) {
	missions := p.missions.Load()
	if missions == nil || len(*missions) != 1 {
		return "", false
	}
	item := (*missions)[0]
	if !item.allowAll {
		return "", false
	}
	return item.missionID, true
}

func (p *dbScopeProvider) HasMission(id string) bool {
	missions := p.missions.Load()
	if missions == nil {
		return false
	}
	for _, item := range *missions {
		if item.missionID == id {
			return true
		}
	}
	return false
}

func (p *dbScopeProvider) Start(ctx context.Context) {
	p.refresh(ctx)
	go func() {
		ticker := time.NewTicker(p.interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				p.refresh(ctx)
			}
		}
	}()
}

func (p *dbScopeProvider) refresh(ctx context.Context) {
	missions, err := loadActiveMissionScopes(ctx, p.db)
	if err != nil {
		log.Printf("scope refresh failed (keeping previous scope): %v", err)
		return
	}
	if len(missions) == 0 {
		p.current.Store(nil)
		p.missions.Store(nil)
		return
	}
	scopes := make([]scopeJSON, 0, len(missions))
	for _, item := range missions {
		scopes = append(scopes, item.raw)
	}
	scope, err := newScopeFromGrants(scopes)
	if err != nil {
		log.Printf("scope refresh produced invalid scope (keeping previous): %v", err)
		return
	}
	snapshot := make([]missionScope, 0, len(missions))
	for _, item := range missions {
		itemScope, err := newScopeFromGrants([]scopeJSON{item.raw})
		if err != nil {
			log.Printf("mission %s scope invalid; excluded from traffic attribution", item.missionID)
			continue
		}
		snapshot = append(snapshot, missionScope{missionID: item.missionID, scope: itemScope, allowAll: item.raw.AllowAll})
	}
	p.current.Store(scope)
	p.missions.Store(&snapshot)
}

type scopeJSON struct {
	AllowAll       bool     `json:"allowAll"`
	DomainSuffixes []string `json:"domainSuffixes"`
	IPs            []string `json:"ips"`
	URLPrefixes    []struct {
		Prefix string `json:"prefix"`
	} `json:"urlPrefixes"`
}

type activeMissionScope struct {
	missionID string
	raw       scopeJSON
}

func loadActiveMissionScopes(ctx context.Context, db *pgxpool.Pool) ([]activeMissionScope, error) {
	rows, err := db.Query(ctx, `
		SELECT m.id::text, g.scope
		FROM grants g
		JOIN missions m ON m.grant_id = g.id AND m.grant_version = g.version
		WHERE m.state IN ('pending', 'running', 'paused')
		ORDER BY m.created_at ASC, m.id ASC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var scopes []activeMissionScope
	for rows.Next() {
		var missionID string
		var raw []byte
		if err := rows.Scan(&missionID, &raw); err != nil {
			return nil, err
		}
		var parsed scopeJSON
		if err := json.Unmarshal(raw, &parsed); err != nil {
			log.Printf("mission %s scope JSON invalid: %v", missionID, err)
			continue
		}
		scopes = append(scopes, activeMissionScope{missionID: missionID, raw: parsed})
	}
	return scopes, rows.Err()
}

func loadActiveGrantScopes(ctx context.Context, db *pgxpool.Pool) ([]scopeJSON, error) {
	rows, err := db.Query(ctx, `
		SELECT g.scope
		FROM grants g
		JOIN missions m ON m.grant_id = g.id AND m.grant_version = g.version
		WHERE m.state IN ('pending', 'running', 'paused')
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var scopes []scopeJSON
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		var parsed scopeJSON
		if err := json.Unmarshal(raw, &parsed); err != nil {
			return nil, err
		}
		scopes = append(scopes, parsed)
	}
	return scopes, rows.Err()
}

func newScopeFromGrants(scopes []scopeJSON) (*Scope, error) {
	for _, scope := range scopes {
		if scope.AllowAll {
			return NewUnrestrictedScope(), nil
		}
	}
	var domains, ips, prefixes []string
	seenDomains := map[string]struct{}{}
	seenIPs := map[string]struct{}{}
	seenPrefixes := map[string]struct{}{}
	for _, scope := range scopes {
		for _, domain := range scope.DomainSuffixes {
			if _, ok := seenDomains[domain]; ok {
				continue
			}
			seenDomains[domain] = struct{}{}
			domains = append(domains, domain)
		}
		for _, ip := range scope.IPs {
			if _, ok := seenIPs[ip]; ok {
				continue
			}
			seenIPs[ip] = struct{}{}
			ips = append(ips, ip)
		}
		for _, prefix := range scope.URLPrefixes {
			if _, ok := seenPrefixes[prefix.Prefix]; ok {
				continue
			}
			seenPrefixes[prefix.Prefix] = struct{}{}
			prefixes = append(prefixes, prefix.Prefix)
		}
	}
	return NewScope(domains, ips, prefixes)
}
