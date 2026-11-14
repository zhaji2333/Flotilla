// Re-export the shared schema/migration runner so worker/planner entrypoints
// keep their existing `../db/schema.js` import while API/worker converge on one
// implementation.
export { applyMigrations, applySchema, loadSchemaSql } from '@src-agent/control-plane';
