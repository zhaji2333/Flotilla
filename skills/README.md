# skills/ — CkSKILLS domain packs for the Worker

These are the domain skill packs the SRC-Agent Worker mounts into DeepSeek
Harness through `skill-filesystem` (`customSkillDirs: ['/app/skills']`).

- **Source**: adapted from the user-owned `CkSKILLS_v2/.agents/skills` library
  (16 packs) plus its `rules/` discipline documents under
  `ck-router/references/rules/`. The packs are product content, not an upstream
  dependency; see ADR-0005 H3.
- **Format**: one directory bundle per skill (`<name>/SKILL.md`), YAML
  frontmatter with kebab-case `name` and a `description`; extra material lives
  in `knowledge/` or `references/` and is loaded on demand via `read`.
- **Loading discipline**: the Worker starts with `skill("ck-router")` for
  triage, then loads at most 1–2 primary packs; bodies stay under the 8K
  tool-result pruner threshold so the catalog stays cheap.
- **Validation**: `node scripts/skills-check.mjs` (part of `pnpm run verify:repo`)
  checks frontmatter, manifest drift, size budget and ck-router rules.
- **Routing**: H3 uses `ck-router` as the default entry; P1-β Planner will map
  mission assets/signals to primary packs and pass them in the assignment.

`manifest.json` is generated from the frontmatter; keep it in sync with
`node scripts/skills-check.mjs`.
