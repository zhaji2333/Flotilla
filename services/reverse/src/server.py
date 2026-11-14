#!/usr/bin/env python3
"""Offline static reverse capability service.

JADX/ASC/Hermes run as subprocesses over uploaded artifacts only. No download,
no target requests, no DB/provider access. The executor calls this internal
service and turns bounded results into blackboard facts/evidence.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

os.umask(0o002)
ROOT = Path(os.environ.get("ARTIFACTS_DIR", "/artifacts")).resolve()
JADX_JAR = Path(os.environ.get("JADX_JAR", "/opt/reverse/jadx/jadx-all.jar"))
ASC_HOME = Path(os.environ.get("ASC_HOME", "/opt/reverse/asc"))
PYTHON = os.environ.get("PYTHON", "python3")
TOKEN = os.environ.get("REVERSE_SERVICE_TOKEN", "dev-reverse-token")
PORT = int(os.environ.get("REVERSE_PORT", "9402"))
MAX_JOBS = max(1, int(os.environ.get("REVERSE_MAX_JOBS", "1")))
JOB_TIMEOUT = max(30, int(os.environ.get("REVERSE_JOB_TIMEOUT_SECONDS", "600")))
IDA_PYTHON = os.environ.get("IDA_PYTHON", "/opt/ida-venv/bin/python")
IDA_INSTALL = os.environ.get("IDADIR", "/opt/ida-pro-9.5")
IDA_SCRIPT = Path(os.environ.get("IDA_RUNNER", "/opt/reverse/src/ida_runner.py"))
IDA_HOME = os.environ.get("IDA_HOME_DIR", "/tmp/ida-home")
IDA_EULA_SEED = Path(os.environ.get("IDA_EULA_SEED", "/opt/ida-license/ida.reg"))
MAX_RESULT_CHARS = max(10_000, int(os.environ.get("REVERSE_MAX_RESULT_CHARS", "120000")))
KEYWORDS = ["appkey", "appkey", "appsecret", "secret", "token", "sign", "signature", "hmac", "aes", "rsa", "http://", "https://", "/api/"]

log_lock = threading.Lock()
jobs: dict[str, dict[str, Any]] = {}
job_lock = threading.Lock()
queue: list[str] = []
queue_cv = threading.Condition(job_lock)


def log(message: str) -> None:
    with log_lock:
        print(f"[reverse] {message}", flush=True)


def bounded(value: Any, limit: int = MAX_RESULT_CHARS) -> Any:
    text = json.dumps(value, ensure_ascii=False)
    if len(text) <= limit:
        return value
    return {"truncated": True, "preview": text[:limit]}


def safe_storage_path(storage_path: str) -> Path:
    if not storage_path or ".." in storage_path.split("/"):
        raise ValueError("invalid storagePath")
    candidate = (ROOT / storage_path).resolve()
    if ROOT not in candidate.parents and candidate != ROOT:
        raise ValueError("storagePath escapes artifact root")
    if not candidate.is_file():
        raise ValueError("artifact file not found")
    return candidate


def run(cmd: list[str], timeout: int = JOB_TIMEOUT, env: dict[str, str] | None = None) -> dict[str, Any]:
    merged = dict(os.environ)
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"):
        merged.pop(key, None)
    merged["JAVA_TOOL_OPTIONS"] = merged.get("JAVA_TOOL_OPTIONS", "-Xmx2g")
    if env:
        merged.update(env)
    started = time.monotonic()
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=merged, check=False)
        return {
            "cmd": cmd,
            "returncode": proc.returncode,
            "stdout": proc.stdout[-20_000:],
            "stderr": proc.stderr[-20_000:],
            "seconds": round(time.monotonic() - started, 2),
        }
    except subprocess.TimeoutExpired as error:
        return {
            "cmd": cmd,
            "returncode": -1,
            "stdout": (error.stdout or "")[-10_000:] if isinstance(error.stdout, str) else "",
            "stderr": f"timeout after {timeout}s",
            "seconds": round(time.monotonic() - started, 2),
        }
    except FileNotFoundError as error:
        return {"cmd": cmd, "returncode": -2, "stdout": "", "stderr": str(error), "seconds": 0}


def extract_zip(apk: Path, out: Path) -> list[str]:
    names: list[str] = []
    if not zipfile.is_zipfile(apk):
        return names
    with zipfile.ZipFile(apk) as archive:
        for info in archive.infolist():
            if len(names) >= 2_000:
                break
            name = info.filename
            if ".." in name.split("/") or name.startswith("/"):
                continue
            target = (out / name).resolve()
            if out not in target.parents and target != out:
                continue
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            if info.file_size > 64 * 1024 * 1024:
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(info) as source, target.open("wb") as destination:
                shutil.copyfileobj(source, destination)
            names.append(name)
    return names


def candidates_from_tree(root: Path) -> dict[str, list[str]]:
    words = {key: [] for key in KEYWORDS}
    url_re = re.compile(r"https?://[^\s\"'<>)]+")
    api_re = re.compile(r"(?:/api|/v\d+)[A-Za-z0-9_./?&=%:-]*")
    seen: set[str] = set()
    for path in root.rglob("*"):
        if not path.is_file() or path.stat().st_size > 4 * 1024 * 1024:
            continue
        try:
            text = path.read_text("utf-8", errors="ignore")
        except OSError:
            continue
        for url in url_re.findall(text):
            if url not in seen:
                seen.add(url)
                words["http://" if url.startswith("http://") else "https://"].append(url[:500])
        for api in api_re.findall(text):
            if api not in seen:
                seen.add(api)
                words.setdefault("/api/", []).append(api[:500])
        lower = text.lower()
        for keyword in KEYWORDS:
            if keyword in ("http://", "https://", "/api/"):
                continue
            if keyword in lower:
                for line in text.splitlines():
                    if keyword in line.lower() and len(words[keyword]) < 80:
                        words[keyword].append(line.strip()[:500])
    return {key: values[:80] for key, values in words.items() if values}


def analyze_apk(job: dict[str, Any], artifact: Path) -> dict[str, Any]:
    output = Path(job["outputDir"])
    output.mkdir(parents=True, exist_ok=True)
    extracted = extract_zip(artifact, output / "unzipped")
    result: dict[str, Any] = {
        "kind": "apk",
        "artifact": {"sha256": job.get("sha256"), "filename": artifact.name, "size": artifact.stat().st_size},
        "files": [name for name in extracted if name.endswith((".so", ".js", ".bundle", ".hbc", ".xml", ".json"))][:300],
        "libs": [name for name in extracted if name.startswith("lib/") and name.endswith(".so")][:100],
        "assets": [name for name in extracted if name.startswith("assets/")][:200],
        "engines": {},
        "candidates": {},
        "commands": [],
    }
    # ASC manifest + fast keyword triage.
    manifest = run([PYTHON, "-m", "droidasc", "getmanifest", str(artifact)], timeout=min(180, JOB_TIMEOUT))
    result["commands"].append(manifest)
    if manifest.get("returncode") == 0:
        result["manifest_excerpt"] = manifest.get("stdout", "")[:20_000]
    asc_refs: dict[str, list[str]] = {}
    for keyword in ("token", "appkey", "secret", "sign", "http", "/api/"):
        refs = run([PYTHON, "-m", "droidasc", "findrefs", str(artifact), "string", keyword], timeout=min(120, JOB_TIMEOUT))
        result["commands"].append(refs)
        if refs.get("returncode") == 0 and refs.get("stdout"):
            asc_refs[keyword] = refs["stdout"].splitlines()[:80]
    result["asc_refs"] = asc_refs
    # JADX full source. Keep the command bounded; output is paged by search.
    jadx_out = output / "jadx"
    jadx = run(["java", "-Xmx2g", "-jar", str(JADX_JAR), "-d", str(jadx_out), "--show-bad-code", "--no-res", str(artifact)], timeout=JOB_TIMEOUT)
    result["commands"].append(jadx)
    result["jadx"] = {"returncode": jadx.get("returncode"), "seconds": jadx.get("seconds"), "output": str(jadx_out)}
    if jadx_out.exists():
        result["candidates"] = candidates_from_tree(jadx_out)
    # React Native / Hermes.
    bundle = next((name for name in extracted if name.endswith("index.android.bundle") or name.endswith(".hbc")), None)
    if bundle:
        bundle_path = output / "unzipped" / bundle
        result["react_native"] = {"bundle": bundle, "size": bundle_path.stat().st_size}
        if bundle_path.read_bytes()[:4] == bytes.fromhex("c61fbc03"):
            result["react_native"]["format"] = "hermes"
            hermes_out = output / "hermes.js"
            hermes = run(["hbc-decompiler", str(bundle_path), str(hermes_out)], timeout=min(300, JOB_TIMEOUT))
            result["commands"].append(hermes)
            result["react_native"]["decompiler"] = {"returncode": hermes.get("returncode"), "output": str(hermes_out)}
            if hermes_out.exists():
                result["candidates"] = {**result.get("candidates", {}), **candidates_from_tree(hermes_out.parent)}
        else:
            result["react_native"]["format"] = "javascript"
            result["react_native"]["preview"] = bundle_path.read_text("utf-8", errors="ignore")[:20_000]
            result["candidates"] = {**result.get("candidates", {}), **candidates_from_tree(output / "unzipped")}
    return result


def prepare_ida_home() -> str:
    home = Path(IDA_HOME)
    idadir = home / ".idapro"
    idadir.mkdir(parents=True, exist_ok=True)
    registry = idadir / "ida.reg"
    if not registry.is_file() and IDA_EULA_SEED.is_file():
        shutil.copy2(IDA_EULA_SEED, registry)
    if registry.is_file():
        registry.chmod(0o600)
    return str(home)


def analyze_ida(job: dict[str, Any], artifact: Path) -> dict[str, Any]:
    output = Path(job["outputDir"])
    output.mkdir(parents=True, exist_ok=True)
    # Never let IDA create .i64/.id0 files next to the uploaded artifact; copy
    # the input into this job's writable output directory first.
    input_dir = output / "input"
    input_dir.mkdir(parents=True, exist_ok=True)
    input_path = input_dir / artifact.name
    shutil.copy2(artifact, input_path)
    try:
        output.chmod(0o2775)
        output.parent.chmod(0o2775)
    except OSError:
        pass
    result_path = output / "ida-result.json"
    if not Path(IDA_PYTHON).is_file():
        raise RuntimeError(f"IDA Python runtime not found: {IDA_PYTHON}")
    if not Path(IDA_INSTALL).is_dir():
        raise RuntimeError(f"IDA installation not found: {IDA_INSTALL}")
    env = {
        "IDADIR": IDA_INSTALL,
        "IDA_LICENSE": str(Path(os.environ.get("IDA_LICENSE", "/opt/ida-license/idapro.hexlic"))),
        "QT_QPA_PLATFORM": "offscreen",
        "HOME": prepare_ida_home(),
    }
    command = run([IDA_PYTHON, str(IDA_SCRIPT), str(input_path), str(result_path)], timeout=JOB_TIMEOUT, env=env)
    if command.get("returncode") != 0:
        raise RuntimeError(f"IDA analysis failed: {command.get('stderr', '')[-2_000:]}")
    if not result_path.is_file():
        raise RuntimeError("IDA runner produced no result")
    result = json.loads(result_path.read_text("utf-8"))
    result["commands"] = [command]
    return result


def process_job(job: dict[str, Any]) -> None:
    try:
        artifact = safe_storage_path(job["storagePath"])
        if job["kind"] not in ("apk", "ida"):
            raise ValueError(f"unsupported reverse kind: {job['kind']}")
        result = analyze_ida(job, artifact) if job["kind"] == "ida" else analyze_apk(job, artifact)
        (Path(job["outputDir"]) / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        job["result"] = bounded(result)
        job["state"] = "done"
    except Exception as error:  # noqa: BLE001 - service boundary
        job["state"] = "failed"
        job["error"] = str(error)[:2_000]
        log(f"job {job['id']} failed: {error}")
    finally:
        job["finishedAt"] = time.time()


def worker_loop() -> None:
    while True:
        with queue_cv:
            while not queue:
                queue_cv.wait()
            job_id = queue.pop(0)
        job = jobs.get(job_id)
        if not job:
            continue
        job["state"] = "running"
        job["startedAt"] = time.time()
        log(f"job {job_id} started kind={job['kind']}")
        process_job(job)


def auth(handler: BaseHTTPRequestHandler) -> bool:
    value = handler.headers.get("x-reverse-token", "")
    if not value and handler.headers.get("authorization", "").startswith("Bearer "):
        value = handler.headers["authorization"][7:]
    return value == TOKEN


def capabilities() -> dict[str, bool]:
    return {
        "jadx": JADX_JAR.is_file(),
        "asc": (ASC_HOME / "droidasc").is_dir(),
        "hermes_dec": shutil.which("hbc-decompiler") is not None,
        "hbctool": shutil.which("hbctool") is not None,
        "ida_runner": Path(IDA_PYTHON).is_file() and Path(IDA_INSTALL).is_dir(),
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "src-agent-reverse/1"

    def log_message(self, fmt: str, *args: Any) -> None:
        log(f"{self.address_string()} {fmt % args}")

    def send_json(self, status: int, value: Any) -> None:
        data = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("content-length", "0"))
        if length > 1_000_000:
            raise ValueError("body too large")
        return json.loads(self.rfile.read(length) or b"{}")

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/healthz":
            self.send_json(200, {"ok": True, "role": "reverse-service", "jobs": len(jobs), "capabilities": capabilities()})
            return
        if not auth(self):
            self.send_json(401, {"error": "unauthorized"})
            return
        match = re.fullmatch(r"/v1/jobs/([0-9a-f-]{36})", path)
        if match:
            job = jobs.get(match.group(1))
            if not job:
                self.send_json(404, {"error": "job not found"})
            else:
                self.send_json(200, {**job, "result": job.get("result")})
            return
        self.send_json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if not auth(self):
            self.send_json(401, {"error": "unauthorized"})
            return
        path = urlparse(self.path).path
        try:
            body = self.read_json()
        except Exception as error:  # noqa: BLE001
            self.send_json(400, {"error": str(error)})
            return
        if path == "/v1/jobs":
            kind = str(body.get("kind", "apk"))
            storage_path = str(body.get("storagePath", ""))
            try:
                artifact = safe_storage_path(storage_path)
            except ValueError as error:
                self.send_json(400, {"error": str(error)})
                return
            with job_lock:
                if len([job for job in jobs.values() if job["state"] in ("queued", "running")]) >= MAX_JOBS:
                    self.send_json(429, {"error": "reverse job limit reached"})
                    return
                job_id = str(uuid.uuid4())
                mission = re.sub(r"[^A-Za-z0-9._:-]", "_", str(body.get("missionId", "unknown")))[:160]
                task = re.sub(r"[^A-Za-z0-9._:-]", "_", str(body.get("taskId", "unknown")))[:160]
                output = ROOT / mission / task / "reverse" / job_id
                job = {
                    "id": job_id,
                    "kind": kind,
                    "state": "queued",
                    "storagePath": storage_path,
                    "sha256": str(body.get("sha256", "")),
                    "missionId": mission,
                    "taskId": task,
                    "outputDir": str(output),
                    "createdAt": time.time(),
                }
                jobs[job_id] = job
                queue.append(job_id)
                queue_cv.notify()
            self.send_json(202, {"jobId": job_id, "state": "queued"})
            return
        match = re.fullmatch(r"/v1/jobs/([0-9a-f-]{36})/search", path)
        if match:
            job = jobs.get(match.group(1))
            if not job or job.get("state") != "done":
                self.send_json(404, {"error": "completed job not found"})
                return
            query = str(body.get("query", "")).strip()
            if not query or len(query) > 200:
                self.send_json(400, {"error": "query is required (max 200 chars)"})
                return
            root = Path(job["outputDir"])
            matches: list[dict[str, Any]] = []
            needle = query.lower()
            for file in root.rglob("*"):
                if len(matches) >= 100 or not file.is_file() or file.stat().st_size > 8 * 1024 * 1024:
                    continue
                try:
                    lines = file.read_text("utf-8", errors="ignore").splitlines()
                except OSError:
                    continue
                for number, line in enumerate(lines, 1):
                    if needle in line.lower():
                        matches.append({"file": str(file.relative_to(root)), "line": number, "text": line.strip()[:500]})
                        if len(matches) >= 100:
                            break
            self.send_json(200, {"query": query, "matches": matches})
            return
        self.send_json(404, {"error": "not found"})


def main() -> None:
    threading.Thread(target=worker_loop, daemon=True).start()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    log(f"listening on :{PORT} artifacts={ROOT} jadx={JADX_JAR} maxJobs={MAX_JOBS}")
    server.serve_forever()


if __name__ == "__main__":
    main()
