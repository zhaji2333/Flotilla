package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// BodyCapture describes a body that streamed through the proxy. Only metadata
// is persisted for target traffic; body bytes are deliberately not retained.
type BodyCapture struct {
	Reader io.Reader
	SHA256 string
	Size   int64
}

// TrafficRecord is the lightweight audit row for one proxied exchange.
type TrafficRecord struct {
	Timestamp      time.Time
	Kind           string // "target" or "internet"
	MissionID      string // source mission UUID; empty for unscoped/internet traffic
	TaskID         string // source task UUID; optional, stripped before upstream
	Method         string
	URL            string
	StatusCode     int
	RequestHeader  http.Header
	ResponseHeader http.Header
	RequestBody    BodyCapture
	ResponseBody   BodyCapture
	RequestSHA256  string
	ResponseSHA256 string
}

type Recorder interface {
	Record(context.Context, TrafficRecord) error
}

// PostgresRecorder keeps exchange metadata (method, URL, status, body hashes,
// sizes) in PostgreSQL. It intentionally stores no bodies: full traffic capture
// is not part of the audit contract and would dominate storage, while hash +
// size is enough to correlate an evidence package produced later by the worker.
type PostgresRecorder struct {
	db *pgxpool.Pool
}

const auditSchema = `
CREATE TABLE IF NOT EXISTS proxy_traffic (
    id             BIGSERIAL PRIMARY KEY,
    observed_at    TIMESTAMPTZ NOT NULL,
    kind           TEXT NOT NULL DEFAULT 'target',
    method         TEXT NOT NULL,
    url            TEXT NOT NULL,
    url_host       TEXT NOT NULL,
    status_code    INTEGER NOT NULL,
    request_sha256 TEXT NOT NULL,
    response_sha256 TEXT NOT NULL,
    request_bytes  BIGINT NOT NULL,
    response_bytes BIGINT NOT NULL,
    mission_id     UUID,
    task_id        UUID
);
CREATE TABLE IF NOT EXISTS action_ledger (
    id             BIGSERIAL PRIMARY KEY,
    mission_id     UUID NOT NULL,
    task_id        UUID,
    method         TEXT NOT NULL,
    url            TEXT NOT NULL,
    status_code    INTEGER,
    request_sha256 TEXT NOT NULL,
    source         TEXT NOT NULL DEFAULT 'proxy',
    observed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS action_ledger_task_idx ON action_ledger (task_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS action_ledger_mission_idx ON action_ledger (mission_id, observed_at DESC);
ALTER TABLE proxy_traffic ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'target';
ALTER TABLE proxy_traffic ADD COLUMN IF NOT EXISTS mission_id UUID;
ALTER TABLE proxy_traffic ADD COLUMN IF NOT EXISTS task_id UUID;
CREATE INDEX IF NOT EXISTS proxy_traffic_observed_at_idx ON proxy_traffic (observed_at DESC);
CREATE INDEX IF NOT EXISTS proxy_traffic_request_hash_idx ON proxy_traffic (request_sha256);
CREATE INDEX IF NOT EXISTS proxy_traffic_mission_idx ON proxy_traffic (mission_id, observed_at DESC);
`

func NewPostgresRecorder(ctx context.Context) (*PostgresRecorder, error) {
	dsn, err := postgresDSN()
	if err != nil {
		return nil, err
	}
	db, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, fmt.Errorf("create postgres pool: %w", err)
	}
	if err := db.Ping(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("ping postgres: %w", err)
	}
	if _, err := db.Exec(ctx, auditSchema); err != nil {
		db.Close()
		return nil, fmt.Errorf("ensure audit schema: %w", err)
	}
	return &PostgresRecorder{db: db}, nil
}

func (r *PostgresRecorder) Record(ctx context.Context, record TrafficRecord) error {
	kind := record.Kind
	if kind == "" {
		kind = "target"
	}
	_, err := r.db.Exec(ctx, `
		INSERT INTO proxy_traffic (
			observed_at, kind, mission_id, task_id, method, url, url_host, status_code,
			request_sha256, response_sha256, request_bytes, response_bytes
		) VALUES ($1,$2,NULLIF($3,'')::uuid,NULLIF($4,'')::uuid,$5,$6,$7,$8,$9,$10,$11,$12)
	`,
		record.Timestamp,
		kind,
		record.MissionID,
		record.TaskID,
		record.Method,
		record.URL,
		hostOf(record.URL),
		record.StatusCode,
		record.RequestSHA256,
		record.ResponseSHA256,
		record.RequestBody.Size,
		record.ResponseBody.Size,
	)
	if err != nil {
		return fmt.Errorf("insert traffic audit: %w", err)
	}
	// Only target write methods are action-ledger candidates. Internet GETs and
	// bodyless probes never block a retry.
	if kind == "target" && record.MissionID != "" && writeMethod(record.Method) {
		_, actionErr := r.db.Exec(ctx, `
			INSERT INTO action_ledger (mission_id, task_id, method, url, status_code, request_sha256, source, observed_at)
			VALUES ($1, CASE WHEN EXISTS (
				SELECT 1 FROM tasks WHERE id = NULLIF($2,'')::uuid AND mission_id = $1
			) THEN NULLIF($2,'')::uuid ELSE NULL END, $3, $4, $5, $6, 'proxy', $7)
		`, record.MissionID, record.TaskID, record.Method, record.URL, record.StatusCode, record.RequestSHA256, record.Timestamp)
		if actionErr != nil {
			// Audit failure must not break an already-authorized exchange; the
			// traffic row still proves the proxy saw it. Caller logs the error.
			return fmt.Errorf("insert action ledger: %w", actionErr)
		}
	}
	return nil
}

func writeMethod(method string) bool {
	switch method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		return true
	default:
		return false
	}
}

func (r *PostgresRecorder) Close() {
	if r.db != nil {
		r.db.Close()
	}
}

func postgresDSN() (string, error) {
	host := strings.TrimSpace(os.Getenv("PG_HOST"))
	if host == "" {
		return "", fmt.Errorf("PG_HOST is required")
	}
	port := envDefault("PG_PORT", "5432")
	database := strings.TrimSpace(os.Getenv("PG_DB"))
	if database == "" {
		return "", fmt.Errorf("PG_DB is required")
	}
	user := strings.TrimSpace(os.Getenv("PG_USER"))
	password := os.Getenv("PG_PASSWORD")
	return fmt.Sprintf("postgres://%s:%s@%s:%s/%s?sslmode=disable", user, password, host, port, database), nil
}

func hostOf(rawURL string) string {
	if i := strings.Index(rawURL, "://"); i >= 0 {
		rest := rawURL[i+3:]
		if j := strings.IndexAny(rest, "/?#"); j >= 0 {
			return rest[:j]
		}
		return rest
	}
	return rawURL
}

func envDefault(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}
