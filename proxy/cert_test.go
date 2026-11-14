package main

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"net/netip"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLoadOrGenerateCAPersistsAndSignsSNIHost(t *testing.T) {
	dir := t.TempDir()
	certPath := filepath.Join(dir, "ca.pem")
	keyPath := filepath.Join(dir, "ca-key.pem")
	certs, err := LoadOrGenerateCA(certPath, keyPath)
	if err != nil {
		t.Fatalf("LoadOrGenerateCA: %v", err)
	}
	info, err := os.Stat(keyPath)
	if err != nil {
		t.Fatalf("stat CA key: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("CA key permissions = %o, want 600", info.Mode().Perm())
	}

	reloaded, err := LoadOrGenerateCA(certPath, keyPath)
	if err != nil {
		t.Fatalf("reload CA: %v", err)
	}
	if !reloaded.Certificate().Equal(certs.Certificate()) {
		t.Fatal("reloaded CA differs from persisted CA")
	}

	leaf, err := certs.CertificateFor("API.Example.COM")
	if err != nil {
		t.Fatalf("CertificateFor: %v", err)
	}
	parsed, err := x509.ParseCertificate(leaf.Certificate[0])
	if err != nil {
		t.Fatalf("parse dynamic leaf: %v", err)
	}
	if len(parsed.DNSNames) != 1 || parsed.DNSNames[0] != "api.example.com" {
		t.Fatalf("leaf DNS SANs = %v", parsed.DNSNames)
	}
	roots := x509.NewCertPool()
	roots.AddCert(certs.Certificate())
	if _, err := parsed.Verify(x509.VerifyOptions{
		DNSName:     "api.example.com",
		Roots:       roots,
		CurrentTime: time.Now(),
	}); err != nil {
		t.Fatalf("dynamic certificate does not verify: %v", err)
	}
}

func TestMain(m *testing.M) {
	if os.Getenv("SRC_AGENT_TEST_PARENT_PID") == "" && os.Getppid() > 1 {
		_ = os.Setenv("SRC_AGENT_TEST_PARENT_PID", fmt.Sprintf("%d", os.Getppid()))
	}
	os.Exit(m.Run())
}

func TestDynamicCertificateSupportsIPWithoutSNI(t *testing.T) {
	certs, err := LoadOrGenerateCA(filepath.Join(t.TempDir(), "ca.pem"), filepath.Join(t.TempDir(), "ca-key.pem"))
	if err != nil {
		t.Fatalf("LoadOrGenerateCA: %v", err)
	}
	config := certs.TLSConfig("127.0.0.1")
	leaf, err := config.GetCertificate(&tls.ClientHelloInfo{})
	if err != nil {
		t.Fatalf("GetCertificate without SNI: %v", err)
	}
	parsed, err := x509.ParseCertificate(leaf.Certificate[0])
	if err != nil {
		t.Fatalf("parse leaf: %v", err)
	}
	if len(parsed.IPAddresses) != 1 || !parsed.IPAddresses[0].Equal(netip.MustParseAddr("127.0.0.1").AsSlice()) {
		t.Fatalf("leaf IP SANs = %v", parsed.IPAddresses)
	}
	if len(config.NextProtos) != 1 || config.NextProtos[0] != "http/1.1" {
		t.Fatalf("ALPN protocols = %v, want HTTP/1.1 only", config.NextProtos)
	}
}

func TestLoadOrGenerateCARefusesPartialPair(t *testing.T) {
	dir := t.TempDir()
	certPath := filepath.Join(dir, "ca.pem")
	if err := os.WriteFile(certPath, []byte("not-empty"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadOrGenerateCA(certPath, filepath.Join(dir, "missing-key.pem")); err == nil {
		t.Fatal("partial CA pair unexpectedly accepted")
	}
}
