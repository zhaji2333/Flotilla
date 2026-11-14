# Reverse capability service

Offline static-analysis runtime for uploaded APK/ELF artifacts. It has no
database, provider key, target network, or host mounts; artifacts are uploaded
through the API/CLI into the shared `src_agent_artifacts` volume.

## Endpoints

All endpoints require `x-reverse-token` (or Bearer).

| Method | Path | Purpose |
|---|---|---|
| GET | `/healthz` | health |
| POST | `/v1/jobs` | start `{kind:'apk'|'ida', storagePath, missionId, taskId}` |
| GET | `/v1/jobs/:id` | job state/result |
| POST | `/v1/jobs/:id/search` | bounded file/line search over produced output |

## APK pipeline

- ZIP extraction of manifest/assets/libs, with path traversal and size limits.
- ASC vendored at `vendor/asc` (Apache-2.0): manifest + `findrefs`.
- JADX 1.5.5 full source (offline).
- React Native `index.android.bundle` detection and Hermes decompilation when
  `hermes-dec` is available.
- Candidate URL/API/secret extraction and a bounded summary.

## IDA pipeline (no MCP, no GUI, self-contained runtime)

- `src/ida_runner.py` uses `idapro` + `ida_domain` directly.
- Build `scripts/build-reverse-ida-image.sh` once to produce
  `agent_research-reverse-ida:latest`; it embeds IDA, idalib, license and the
  EULA-accepted registry using BuildKit build contexts/secrets.
- At runtime the overlay `docker-compose.ida.yml` mounts only the artifact
  volume. There are no IDA/venv/license host volumes.
- Keep the resulting image private: it contains the licensed IDA installation
  and license.
- The analysis process is offline and disposable.

## Verified tools

```text
ASC      0.1.2.post4  getmanifest/findrefs OK
JADX     1.5.5        --version / full APK decompile OK
Hermes   hbc-decompiler 0.1.8  .hbc bundle decompile OK
IDA      idalib 9.5   reverse_ida job OK (ELF64 format, strings)
```

`GET /healthz` returns a `capabilities` map:

```json
{"jadx":true,"asc":true,"hermes_dec":true,"hbctool":true,"ida_runner":true}
```
