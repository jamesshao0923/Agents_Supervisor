/** Private additive migration. No source imports or copied earlier schema.
 * Scratch schema 19 is never imported as an existing production database. */
export const RESEARCH_GROUPS_MIGRATION_SQL = `
CREATE TABLE research_group_registrations(
 id TEXT PRIMARY KEY,
 runtime_id TEXT NOT NULL UNIQUE REFERENCES runtime_runs(id),
 record TEXT NOT NULL CHECK(json_valid(record))
);
CREATE TABLE research_group_receipts(
 command_id TEXT PRIMARY KEY,
 request TEXT NOT NULL CHECK(json_valid(request)),
 result TEXT NOT NULL CHECK(json_valid(result))
);
CREATE TABLE research_group_events(
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 registration_id TEXT NOT NULL REFERENCES research_group_registrations(id),
 kind TEXT NOT NULL,
 record TEXT NOT NULL CHECK(json_valid(record))
);`;
