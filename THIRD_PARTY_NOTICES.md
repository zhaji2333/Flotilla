# Third-party notices

Flotilla is licensed under the MIT License (see [LICENSE](LICENSE)). The repository
also contains or references the following third-party components:

| Component | Location | License | Notes |
|---|---|---|---|
| JADX 1.5.5 (all-in-one jar) | `services/reverse/vendor/jadx/` | Apache-2.0 | See `META-INF/LICENSE` inside the jar and `services/reverse/vendor/jadx/README.md` |
| ASC 0.1.2 | `services/reverse/vendor/asc/` | Apache-2.0 | See `services/reverse/vendor/asc/LICENSE` |
| agent-skills (Addy Osmani) | `.agents/` | MIT | See `.agents/LICENSE` and `.agents/upstream/agent-skills.json` |
| CkSKILLS skill packs | `skills/` | Project-owned content | Authored/maintained by the Flotilla project; not an upstream dependency |
| IDA / idalib | not distributed | Commercial license | The `reverse-ida` image embeds a licensed IDA installation and must stay private; this repository only ships build scripts |

If you redistribute this repository or a built image, keep the upstream license
files and notices, and do not publish the IDA-bearing image.
