package main

import (
	"net/http/httptest"
	"net/url"
	"testing"
)

type fakeMissionScopeProvider struct {
	scope   *Scope
	mission string
}

func (p fakeMissionScopeProvider) Current() *Scope                         { return p.scope }
func (p fakeMissionScopeProvider) MissionForURL(_ *url.URL, _ bool) string { return p.mission }
func (p fakeMissionScopeProvider) HasMission(id string) bool               { return id == p.mission }

func TestMissionForRequestUsesHeaderOrTargetScope(t *testing.T) {
	scope := mustScope(t, []string{"target.test"}, []string{"127.0.0.0/8"}, nil)
	missionID := "11111111-1111-4111-8111-111111111111"
	p := NewProxy(scope, nil, nil)
	p.SetScopeProvider(fakeMissionScopeProvider{scope: scope, mission: missionID})

	u, _ := url.Parse("http://target.test/probe")
	req := httptest.NewRequest("GET", u.String(), nil)
	if got := p.missionForRequest(req, u, modeTarget); got != missionID {
		t.Fatalf("target scope attribution = %q, want %q", got, missionID)
	}

	internet, _ := url.Parse("https://example.com/docs")
	req = httptest.NewRequest("GET", internet.String(), nil)
	if got := p.missionForRequest(req, internet, modeInternet); got != "" {
		t.Fatalf("internet without header = %q, want empty", got)
	}

	req.Header.Set("X-SRC-Mission-Id", missionID)
	if got := p.missionForRequest(req, internet, modeInternet); got != missionID {
		t.Fatalf("valid header attribution = %q, want %q", got, missionID)
	}
	req.Header.Set("X-SRC-Mission-Id", "22222222-2222-4222-8222-222222222222")
	if got := p.missionForRequest(req, internet, modeInternet); got != "" {
		t.Fatalf("inactive header attribution = %q, want empty", got)
	}
}

func TestWriteMethodOnlyFlagsTargetMutations(t *testing.T) {
	for _, method := range []string{"POST", "PUT", "PATCH", "DELETE"} {
		if !writeMethod(method) {
			t.Fatalf("%s should be a write method", method)
		}
	}
	for _, method := range []string{"GET", "HEAD", "OPTIONS"} {
		if writeMethod(method) {
			t.Fatalf("%s should not be a write method", method)
		}
	}
}
