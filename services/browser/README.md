# Browser capability service

Isolated Playwright/Chromium runtime for SRC-Agent workers. The service has no
database, provider key, or host mounts; it reaches targets only through the
audited egress proxy (`BROWSER_PROXY_URL`, default `http://proxy:8080`).

## Endpoints

All endpoints require `x-browser-token` (or a Bearer token) when `BROWSER_TOKEN`
is set.

| Method | Path | Purpose |
|---|---|---|
| GET | `/healthz` | health |
| POST | `/v1/sessions` | create a task-scoped context (`missionId`, `taskId`) |
| POST | `/v1/sessions/:id/navigate` | navigate `{url}` |
| POST | `/v1/sessions/:id/snapshot` | bounded DOM/form/link snapshot |
| POST | `/v1/sessions/:id/act` | one click/fill/press/select |
| POST | `/v1/sessions/:id/network` | captured responses with request/response text |
| POST | `/v1/sessions/:id/chunks` | JS chunks, source maps, extracted URL/API candidates |
| POST | `/v1/sessions/:id/eval` | bounded JS evaluation (disabled by default) |
| DELETE | `/v1/sessions/:id` | close context |
| POST | `/v1/close-task` | close all contexts for a mission/task |

Network bodies/source maps are written to the shared `/artifacts` volume by
mission/task/SHA-256. Browser traffic is evidence only when the Agent records
the returned request/response through the harness plugin.

## Security

- Chromium runs with `--no-sandbox` inside a disposable container with
  `cap_drop: ALL`, no-new-privileges, no host mounts, and no DB/provider secrets.
- Only http(s) navigation is accepted; `file:`, `data:`, `javascript:` and
  embedded-credential URLs are rejected.
- Downloads, persistent contexts and service workers are disabled.
- The proxy remains the network scope/audit boundary; the browser adds
  `X-SRC-Mission-Id` / `X-SRC-Task-Id` headers to its requests.
