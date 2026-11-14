package main

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// CertManager owns the local interception CA and a concurrency-safe cache of
// short-lived leaf certificates keyed by normalized SNI hostname.
type CertManager struct {
	caCert *x509.Certificate
	caKey  crypto.Signer
	cache  sync.Map
}

func LoadOrGenerateCA(certPath, keyPath string) (*CertManager, error) {
	certPEM, certErr := os.ReadFile(certPath)
	keyPEM, keyErr := os.ReadFile(keyPath)
	switch {
	case certErr == nil && keyErr == nil:
		return parseCA(certPEM, keyPEM)
	case errors.Is(certErr, os.ErrNotExist) && errors.Is(keyErr, os.ErrNotExist):
		return generateCA(certPath, keyPath)
	default:
		return nil, fmt.Errorf("CA certificate and key must both exist and be readable: cert error=%v, key error=%v", certErr, keyErr)
	}
}

func parseCA(certPEM, keyPEM []byte) (*CertManager, error) {
	pair, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return nil, fmt.Errorf("parse CA key pair: %w", err)
	}
	if len(pair.Certificate) == 0 {
		return nil, fmt.Errorf("CA certificate chain is empty")
	}
	caCert, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		return nil, fmt.Errorf("parse CA certificate: %w", err)
	}
	caKey, ok := pair.PrivateKey.(crypto.Signer)
	if !ok {
		return nil, fmt.Errorf("CA private key cannot sign certificates")
	}
	if !caCert.IsCA || caCert.KeyUsage&x509.KeyUsageCertSign == 0 {
		return nil, fmt.Errorf("configured certificate is not a certificate-signing CA")
	}
	if !publicKeysEqual(caCert.PublicKey, caKey.Public()) {
		return nil, fmt.Errorf("CA certificate and private key do not match")
	}
	return &CertManager{caCert: caCert, caKey: caKey}, nil
}

func generateCA(certPath, keyPath string) (*CertManager, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generate CA key: %w", err)
	}
	serial, err := randomSerial()
	if err != nil {
		return nil, err
	}
	now := time.Now()
	template := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "SRC-Agent Local Interception CA"},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.AddDate(10, 0, 0),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return nil, fmt.Errorf("create CA certificate: %w", err)
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, fmt.Errorf("encode CA key: %w", err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})
	if err := writeNewFile(certPath, certPEM, 0o644); err != nil {
		return nil, fmt.Errorf("write CA certificate: %w", err)
	}
	if err := writeNewFile(keyPath, keyPEM, 0o600); err != nil {
		return nil, fmt.Errorf("write CA private key: %w", err)
	}
	return parseCA(certPEM, keyPEM)
}

func writeNewFile(path string, data []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	if _, err := file.Write(data); err != nil {
		file.Close()
		return err
	}
	return file.Close()
}

func (m *CertManager) Certificate() *x509.Certificate { return m.caCert }

// CertificateFor returns a cached certificate or signs a new 24-hour leaf.
func (m *CertManager) CertificateFor(host string) (tls.Certificate, error) {
	host = strings.ToLower(strings.TrimSuffix(strings.TrimSpace(host), "."))
	if cached, ok := m.cache.Load(host); ok {
		return cached.(tls.Certificate), nil
	}

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("generate leaf key: %w", err)
	}
	serial, err := randomSerial()
	if err != nil {
		return tls.Certificate{}, err
	}
	now := time.Now()
	// Intercepted leaf certificates must outlive long-running proxy containers:
	// a 24h leaf silently expired mid-mission and broke every TLS handshake
	// through the MITM proxy. Keep the leaf validity bounded by the CA.
	notAfter := now.AddDate(5, 0, 0)
	if m.caCert.NotAfter.Before(notAfter) {
		notAfter = m.caCert.NotAfter
	}
	template := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: host},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              notAfter,
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}
	if addr, err := netip.ParseAddr(host); err == nil && addr.Zone() == "" {
		template.IPAddresses = []net.IP{addr.Unmap().AsSlice()}
	} else {
		if !validDNSName(host) {
			return tls.Certificate{}, fmt.Errorf("invalid TLS interception hostname %q", host)
		}
		template.DNSNames = []string{host}
	}
	der, err := x509.CreateCertificate(rand.Reader, template, m.caCert, &key.PublicKey, m.caKey)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("sign leaf certificate: %w", err)
	}
	leaf, err := x509.ParseCertificate(der)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("parse generated leaf: %w", err)
	}
	certificate := tls.Certificate{
		Certificate: [][]byte{der, m.caCert.Raw},
		PrivateKey:  key,
		Leaf:        leaf,
	}
	actual, _ := m.cache.LoadOrStore(host, certificate)
	return actual.(tls.Certificate), nil
}

// TLSConfig forces HTTP/1.1 on intercepted connections. The CONNECT host is a
// fallback for clients connecting to an IP address and therefore omitting SNI.
func (m *CertManager) TLSConfig(connectHost string) *tls.Config {
	return &tls.Config{
		MinVersion: tls.VersionTLS12,
		NextProtos: []string{"http/1.1"},
		GetCertificate: func(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
			host := hello.ServerName
			if host == "" {
				host = connectHost
			}
			certificate, err := m.CertificateFor(host)
			if err != nil {
				return nil, err
			}
			return &certificate, nil
		},
	}
}

func randomSerial() (*big.Int, error) {
	limit := new(big.Int).Lsh(big.NewInt(1), 128)
	serial, err := rand.Int(rand.Reader, limit)
	if err != nil {
		return nil, fmt.Errorf("generate certificate serial: %w", err)
	}
	return serial, nil
}

func publicKeysEqual(a, b crypto.PublicKey) bool {
	aDER, err := x509.MarshalPKIXPublicKey(a)
	if err != nil {
		return false
	}
	bDER, err := x509.MarshalPKIXPublicKey(b)
	if err != nil {
		return false
	}
	return string(aDER) == string(bDER)
}
