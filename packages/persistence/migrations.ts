import {RESEARCH_GROUPS_MIGRATION_SQL} from './schema19.js';
import {EXPLORATION_POLICY_MIGRATION_SQL} from './schema18.js';
import {RESEARCH_WORKFLOW_MIGRATION_SQL} from './schema-research-workflow.js';
import {CONTROL_MAINTENANCE_MIGRATION_SQL} from './schema16.js';
import {SCHEDULED_LOOP_MIGRATION_SQL} from './scheduled-loop-schema.js';
import { AUTHOR_ROUTE_MIGRATION_SQL } from './schema14.js';
import { SCHEDULED_MIGRATION_SQL, SUPERVISION_ROUTING_MIGRATION_SQL } from './schema13.js';
import { SUPERVISION_CONCERN_MIGRATION_SQL } from './supervision-concerns.js';
import { VERIFICATION_LINEAGE_MIGRATION_SQL } from './verification-lineage.js';
import { CONTROL_QUALIFICATION_MIGRATION_SQL } from './control-qualification.js';
import { TASK_RESULTS_MIGRATION_SQL } from './task-results.js';
import type { DatabaseSync } from 'node:sqlite';
import { SUPERVISION_MIGRATION_SQL } from './supervision.js';
import { SUPERVISION_INTERRUPTION_MIGRATION_SQL } from './supervision-interruptions.js';
import { SUPERVISION_MONITOR_MIGRATION_SQL } from './supervision-monitor.js';
import { CONVERSATION_MIGRATION_SQL, ASSESSMENT_MIGRATION_SQL } from './conversations.js';

export const SCHEMA_VERSION = 19;

const migrations = [
  `CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
   CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT NOT NULL);
   CREATE TABLE runs(project_id TEXT NOT NULL REFERENCES projects(id), id TEXT NOT NULL,
     revision INTEGER NOT NULL CHECK(revision >= 0), snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
     PRIMARY KEY(project_id,id));
   CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT, command_id TEXT NOT NULL,
     project_id TEXT NOT NULL REFERENCES projects(id), run_id TEXT, type TEXT NOT NULL,
     payload TEXT NOT NULL CHECK(json_valid(payload)), FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id));
   CREATE INDEX events_project_cursor ON events(project_id,seq);
   CREATE TABLE command_receipts(command_id TEXT PRIMARY KEY, request TEXT NOT NULL CHECK(json_valid(request)),
     result TEXT NOT NULL CHECK(json_valid(result)), event_seq INTEGER NOT NULL REFERENCES events(seq));
   CREATE TABLE artifacts(project_id TEXT NOT NULL, run_id TEXT NOT NULL, id TEXT NOT NULL,
     digest TEXT NOT NULL CHECK(length(digest)=64), path TEXT NOT NULL, contract_version INTEGER NOT NULL CHECK(contract_version>0),
     PRIMARY KEY(project_id,run_id,id), FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id));`,
  `CREATE TABLE verification_changes(project_id TEXT NOT NULL REFERENCES projects(id), id TEXT NOT NULL,
     base_version INTEGER NOT NULL CHECK(base_version>=0), status TEXT NOT NULL CHECK(status IN ('proposed','published','rejected')),
     definition TEXT NOT NULL CHECK(json_valid(definition)), PRIMARY KEY(project_id,id));
   CREATE TABLE verification_catalogs(project_id TEXT NOT NULL REFERENCES projects(id), version INTEGER NOT NULL CHECK(version>0),
     digest TEXT NOT NULL CHECK(length(digest)=64), path TEXT NOT NULL, definition TEXT NOT NULL CHECK(json_valid(definition)),
     PRIMARY KEY(project_id,version));
   CREATE TABLE verification_catalog_heads(project_id TEXT PRIMARY KEY REFERENCES projects(id), version INTEGER NOT NULL,
     FOREIGN KEY(project_id,version) REFERENCES verification_catalogs(project_id,version));
   CREATE TABLE verification_cases(project_id TEXT NOT NULL REFERENCES projects(id), id TEXT NOT NULL,
     revision INTEGER NOT NULL CHECK(revision>0), definition TEXT NOT NULL CHECK(json_valid(definition)), PRIMARY KEY(project_id,id,revision));
   CREATE TABLE verification_catalog_cases(project_id TEXT NOT NULL, version INTEGER NOT NULL, case_id TEXT NOT NULL, revision INTEGER NOT NULL,
     PRIMARY KEY(project_id,version,case_id,revision),
     FOREIGN KEY(project_id,version) REFERENCES verification_catalogs(project_id,version),
     FOREIGN KEY(project_id,case_id,revision) REFERENCES verification_cases(project_id,id,revision));
   CREATE TABLE verification_coverage(project_id TEXT NOT NULL, version INTEGER NOT NULL, case_id TEXT NOT NULL,
     revision INTEGER NOT NULL, criterion_id TEXT NOT NULL, PRIMARY KEY(project_id,version,case_id,revision,criterion_id),
     FOREIGN KEY(project_id,version,case_id,revision) REFERENCES verification_catalog_cases(project_id,version,case_id,revision));
   CREATE TABLE verification_replacements(project_id TEXT NOT NULL, version INTEGER NOT NULL, case_id TEXT NOT NULL,
     revision INTEGER NOT NULL, replaced_id TEXT NOT NULL, PRIMARY KEY(project_id,version,case_id,revision,replaced_id),
     FOREIGN KEY(project_id,version,case_id,revision) REFERENCES verification_catalog_cases(project_id,version,case_id,revision));
   CREATE TABLE verification_plans(project_id TEXT NOT NULL, run_id TEXT NOT NULL, id TEXT NOT NULL,
     catalog_version INTEGER NOT NULL, definition TEXT NOT NULL CHECK(json_valid(definition)), PRIMARY KEY(project_id,id),
     FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id),
     FOREIGN KEY(project_id,catalog_version) REFERENCES verification_catalogs(project_id,version));`,
  `CREATE TABLE executions(id TEXT PRIMARY KEY, command_id TEXT NOT NULL UNIQUE,
     project_id TEXT NOT NULL, run_id TEXT NOT NULL, request TEXT NOT NULL CHECK(json_valid(request)),
     record TEXT NOT NULL CHECK(json_valid(record)), FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id));
   CREATE TABLE execution_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, execution_id TEXT NOT NULL REFERENCES executions(id),
     received_at TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)));
   CREATE INDEX execution_event_cursor ON execution_events(execution_id,seq);`,
  `CREATE TABLE runtime_runs(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, run_id TEXT NOT NULL,
     record TEXT NOT NULL CHECK(json_valid(record)), FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id));
   CREATE TABLE runtime_outbox(id TEXT PRIMARY KEY, runtime_id TEXT NOT NULL REFERENCES runtime_runs(id), record TEXT NOT NULL CHECK(json_valid(record)));
   CREATE TABLE runtime_inbox(message_id TEXT PRIMARY KEY, request TEXT NOT NULL CHECK(json_valid(request)), result TEXT NOT NULL CHECK(json_valid(result)));
   CREATE TABLE runtime_receipts(command_id TEXT PRIMARY KEY, request TEXT NOT NULL CHECK(json_valid(request)), result TEXT NOT NULL CHECK(json_valid(result)));
   CREATE TABLE runtime_checkpoints(id TEXT PRIMARY KEY, runtime_id TEXT NOT NULL REFERENCES runtime_runs(id), digest TEXT NOT NULL, record TEXT NOT NULL CHECK(json_valid(record)));
   CREATE TABLE runtime_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, runtime_id TEXT NOT NULL REFERENCES runtime_runs(id), kind TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)), created_at TEXT NOT NULL);
   CREATE INDEX runtime_events_cursor ON runtime_events(runtime_id,seq);`,
  `CREATE TABLE verification_records(kind TEXT NOT NULL CHECK(kind IN ('proposal','plan','job','delivery')), id TEXT NOT NULL,
     project_id TEXT NOT NULL, run_id TEXT NOT NULL, record TEXT NOT NULL CHECK(json_valid(record)), PRIMARY KEY(kind,id),
     FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id));
   CREATE TABLE verification_product_heads(project_id TEXT PRIMARY KEY REFERENCES projects(id), proposal_id TEXT NOT NULL);
   CREATE TABLE verification_product_receipts(command_id TEXT PRIMARY KEY, request TEXT NOT NULL CHECK(json_valid(request)), result TEXT NOT NULL CHECK(json_valid(result)));`,
  `CREATE TABLE goal_sessions(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, run_id TEXT NOT NULL, record TEXT NOT NULL CHECK(json_valid(record)), FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id));
   CREATE TABLE goal_receipts(command_id TEXT PRIMARY KEY, request TEXT NOT NULL CHECK(json_valid(request)), session_id TEXT NOT NULL REFERENCES goal_sessions(id));`,
  CONVERSATION_MIGRATION_SQL,
  ASSESSMENT_MIGRATION_SQL + SUPERVISION_MIGRATION_SQL,
  SUPERVISION_INTERRUPTION_MIGRATION_SQL + SUPERVISION_MONITOR_MIGRATION_SQL,
  VERIFICATION_LINEAGE_MIGRATION_SQL,
  CONTROL_QUALIFICATION_MIGRATION_SQL + TASK_RESULTS_MIGRATION_SQL,
  SUPERVISION_CONCERN_MIGRATION_SQL,
  SCHEDULED_MIGRATION_SQL + SUPERVISION_ROUTING_MIGRATION_SQL,
  AUTHOR_ROUTE_MIGRATION_SQL,
  SCHEDULED_LOOP_MIGRATION_SQL,
  CONTROL_MAINTENANCE_MIGRATION_SQL,
  RESEARCH_WORKFLOW_MIGRATION_SQL,
  EXPLORATION_POLICY_MIGRATION_SQL,
  RESEARCH_GROUPS_MIGRATION_SQL,
];

export function migrate(db: DatabaseSync): void {
  // Configure lock waiting before the first schema read: another connection may
  // still be initializing WAL when this real process opens the same database.
  db.exec('PRAGMA busy_timeout=5000');
  const row = db.prepare('PRAGMA user_version').get();
  const version = Number(row?.['user_version']);
  if (!Number.isInteger(version) || version < 0 || version > SCHEMA_VERSION) {
    throw new Error(`Unsupported database schema version ${version}; supported through ${SCHEMA_VERSION}`);
  }
  // WAL and FULL durability are set for every connection, not merely at creation.
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  db.exec('BEGIN IMMEDIATE');
  try {
    // An opener may have migrated while we waited. Decide the next migration
    // under the writer lock, never from the earlier unlocked observation.
    const lockedVersion = Number(db.prepare('PRAGMA user_version').get()?.['user_version']);
    if (!Number.isInteger(lockedVersion) || lockedVersion < 0 || lockedVersion > SCHEMA_VERSION) {
      throw new Error(`Unsupported database schema version ${lockedVersion}; supported through ${SCHEMA_VERSION}`);
    }
    for (let next = lockedVersion + 1; next <= SCHEMA_VERSION; next++) {
      db.exec(migrations[next - 1]!);
      db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES (?,?)').run(next, new Date().toISOString());
      db.exec(`PRAGMA user_version=${next}`);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
