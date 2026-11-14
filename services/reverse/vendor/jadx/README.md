# JADX (vendored)

- Version: 1.5.5 (`jadx-1.5.5-all.jar`)
- Upstream: https://github.com/skylot/jadx
- License: Apache License 2.0 (see `META-INF/LICENSE` inside the jar)
- Why vendored: the `reverse` image must run fully offline and self-contained; the
  Dockerfile copies this jar to `/opt/reverse/jadx/jadx-all.jar`.
- Updating: replace the jar, bump the version here and in the Dockerfile if the
  filename changes, then rebuild the `reverse` image and run the reverse smoke.
