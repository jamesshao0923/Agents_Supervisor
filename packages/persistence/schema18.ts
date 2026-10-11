/** Import-free additive schema; immutable plans and prior claims are untouched. */
export const EXPLORATION_POLICY_MIGRATION_SQL = `
CREATE TABLE scheduled_exploration_policy (
 scheduler_id TEXT PRIMARY KEY REFERENCES scheduled_records(id),
 revision INTEGER NOT NULL CHECK(revision > 0),
 tier TEXT NOT NULL CHECK(tier IN ('low','medium','high','unlimited')),
 record TEXT NOT NULL CHECK(json_valid(record))
);`;
