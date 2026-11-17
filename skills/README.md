# skills/ — CkSKILLS v2.1 domain packs for the Worker

These are the domain skill packs the SRC-Agent Worker mounts into DeepSeek
Harness through `skill-filesystem` (`customSkillDirs: ['/app/skills']`).

- **Source**: adapted from the user-owned `CkSKILLS_v2` **v2.1** library
  (`.agents/skills`, 18 packs) plus its data layers: `rules/` discipline docs,
  the structured `kb/` dataset and `templates/`. The packs are product content,
  not an upstream dependency; see ADR-0005 H3. Library provenance:
  [`MIGRATION.md`](MIGRATION.md) and `migration-*.json`.
- **Packs (18)**: `ck-router` (invocation `router`) plus 17 `on-demand` packs —
  `ai-agent`, `binary-re`, `cloud-infra`, `internal-network`, `kb-security-data`,
  `mobile-app`, `source-audit`, `web-api-protocol`, `web-auth-access`,
  `web-deser-xxe`, `web-file-path`, `web-injection`, `web-logic-race`,
  `web-recon`, `web-ssrf-render`, `web-waf-bypass`, `web-xss-frontend`.
  v2.1 added `internal-network` (10 internal/AD blocks) and `kb-security-data`
  (kb triage) and expanded `cloud-infra` with `cloud-01…10`.
- **Format**: one directory bundle per skill (`<name>/SKILL.md`), YAML
  frontmatter with kebab-case `name` and a `description`; extra material lives
  in `knowledge/` or `references/` and is loaded on demand via `read`.
- **Path convention**: upstream packs live one level deeper
  (`.agents/skills/<pack>/...`), while this repo flattens them to
  `skills/<pack>/...`. Root-relative references were therefore normalized by
  one level when importing:
  - `skills/<pack>/SKILL.md`: `../../../kb/...` → `../../kb/...` (same for
    `rules/`, `templates/`, `docs/`, `AGENTS.md`);
  - `skills/<pack>/knowledge/*.md`: `../../../../rules/...` →
    `../../../rules/...` (same for `AGENTS.md`, `kb/`);
  - cross-pack references (`../../<other-pack>/...`) are unchanged because both
    layouts have the same depth below the repository root;
  - `skills/MIGRATION.md` is upstream `docs/MIGRATION.md`, moved here so the
    "原始清单" pointers in 14 SKILL.md panels resolve both in the repo and in
    the worker image (`/app/skills`, where `docs/` is not shipped).
- **Data layers** (repository root, **not** default-loaded — INDEX first, single
  entries/slices on demand, per `rules/55-kb-usage.md`):

  | Path | Content | Size |
  |---|---|---|
  | `kb/vuln/` | 664 CVE/vuln entries in 5 categories + `INDEX.md` / `INDEX-middleware.md` | 1.76 MiB |
  | `kb/dict/` | 237 password/user/directory/subdomain/port dictionaries (+68 `_meta.yaml`) + `INDEX.md` | 34.25 MiB |
  | `kb/payload/` | 69 XSS/SQLi/SSRF/LFI/RCE/upload payload files (+19 `_meta.yaml`) + `INDEX.md` | 1.08 MiB |
  | `kb/` total | 1,062 files | ~40 MB on disk |
  | `rules/` | 12 discipline docs incl. `55-kb-usage.md`; mirrored byte-for-byte to `ck-router/references/rules/` | 31 KiB |
  | `templates/` | `CLUEBOARD.template.md`, `SEEDS.template.md`, `TEAMMATE-SYNC.template.md` | 5 KiB |
  | `tools/` | `kb_index.py` (generate indexes / `--check` consistency), `clueboard_sync_check.py` | 34 KiB |

- **Loading discipline**: the Worker starts with `skill("ck-router")` for
  triage, then loads at most 1–2 primary packs; bodies stay under the 8K
  tool-result pruner threshold so the catalog stays cheap. `kb/` is searched via
  its INDEX files with `grep`/`sed -n` slices, never read in full; CVE facts
  must be verified against vendor advisories/NVD and PoCs reproduced locally
  before they go into a report (`rules/55-kb-usage.md`).
- **Image/build**: `packages/orchestrator/Dockerfile` copies `skills/` to
  `/app/skills` and the data layers `kb/` → `/app/kb`, `rules/` → `/app/rules`,
  `templates/` → `/app/templates` (guarded by `tests/skills-image.test.mjs`).
  `kb/` adds ~40 MB to the worker image; `skills/` itself must stay under the
  8 MB budget (currently ~3.4 MB including the rules mirror).
- **Validation** (all part of `pnpm run verify:repo`):
  - `node scripts/skills-check.mjs` — exactly 18 packs, frontmatter/manifest
    drift, per-SKILL.md 7800-byte budget, `skills/` < 8 MB, ck-router
    `references/rules/` mirrored from `rules/` (incl. `55-kb-usage.md`), and the
    `kb/{vuln,dict,payload}/INDEX.md` files present;
  - `python3 tools/kb_index.py --check` — kb data/index consistency;
  - relative links in `skills/**/*.md` must resolve to repository files (checked
    when packs are synced from upstream; keep new references file-relative).
- **Manifest**: `manifest.json` is generated from the frontmatter
  (`name`/`description`/`path`/`invocation`) and must be kept in sync with
  `node scripts/skills-check.mjs`.
- **Routing**: `ck-router` is the default entry; the P1-β Planner will map
  mission assets/signals to primary packs and pass them in the assignment.