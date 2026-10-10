/** Migration definitions have no runtime imports: service startup must not depend on repository initialization order. */
export const SCHEDULED_MIGRATION_SQL=`
CREATE TABLE scheduled_plans(id TEXT PRIMARY KEY,digest TEXT NOT NULL,record TEXT NOT NULL CHECK(json_valid(record)));
CREATE TABLE scheduled_records(id TEXT PRIMARY KEY REFERENCES scheduled_plans(id),runtime_id TEXT NOT NULL REFERENCES runtime_runs(id),project_id TEXT NOT NULL,run_id TEXT NOT NULL,record TEXT NOT NULL CHECK(json_valid(record)),FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id));
CREATE UNIQUE INDEX scheduled_one_runtime ON scheduled_records(runtime_id);
CREATE TABLE scheduled_claims(id TEXT PRIMARY KEY,scheduler_id TEXT NOT NULL REFERENCES scheduled_records(id),attempt_id TEXT NOT NULL UNIQUE,task_id TEXT NOT NULL,generation INTEGER NOT NULL,record TEXT NOT NULL CHECK(json_valid(record)),UNIQUE(scheduler_id,task_id,generation));
CREATE TABLE scheduled_outbox(id TEXT PRIMARY KEY,claim_id TEXT NOT NULL UNIQUE REFERENCES scheduled_claims(id),record TEXT NOT NULL CHECK(json_valid(record)));
CREATE TABLE scheduled_leases(id TEXT PRIMARY KEY,claim_id TEXT NOT NULL REFERENCES scheduled_claims(id),state TEXT NOT NULL CHECK(state IN ('held','released')),record TEXT NOT NULL CHECK(json_valid(record)));
CREATE TABLE scheduled_meta(id INTEGER PRIMARY KEY CHECK(id=1),lease_revision INTEGER NOT NULL CHECK(lease_revision>=0));
INSERT INTO scheduled_meta VALUES(1,0);
CREATE TABLE scheduled_receipts(command_id TEXT PRIMARY KEY,request TEXT NOT NULL CHECK(json_valid(request)),result TEXT NOT NULL CHECK(json_valid(result)));
CREATE TABLE scheduled_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,scheduler_id TEXT NOT NULL REFERENCES scheduled_records(id),kind TEXT NOT NULL,record TEXT NOT NULL CHECK(json_valid(record)));
CREATE TRIGGER scheduled_plans_no_update BEFORE UPDATE ON scheduled_plans BEGIN SELECT RAISE(ABORT,'Plan immutable');END;
CREATE TRIGGER scheduled_plans_no_delete BEFORE DELETE ON scheduled_plans BEGIN SELECT RAISE(ABORT,'Plan immutable');END;
CREATE TRIGGER scheduled_claims_no_update BEFORE UPDATE ON scheduled_claims BEGIN SELECT RAISE(ABORT,'Claim intent immutable');END;
CREATE TRIGGER scheduled_claims_no_delete BEFORE DELETE ON scheduled_claims BEGIN SELECT RAISE(ABORT,'Claim intent immutable');END;
`;

export const SUPERVISION_ROUTING_MIGRATION_SQL=`
CREATE TABLE supervision_routing_policies(loop_id TEXT PRIMARY KEY REFERENCES supervision_loops(id),record TEXT NOT NULL CHECK(json_valid(record)));
CREATE TABLE supervision_routing_capabilities(id TEXT PRIMARY KEY,record TEXT NOT NULL CHECK(json_valid(record)));
CREATE TABLE supervision_progress_rounds(id TEXT PRIMARY KEY,loop_id TEXT NOT NULL REFERENCES supervision_loops(id),contract_digest TEXT NOT NULL,job_id TEXT NOT NULL UNIQUE,record TEXT NOT NULL CHECK(json_valid(record)));
CREATE TABLE supervision_routes(id TEXT PRIMARY KEY,command_id TEXT NOT NULL UNIQUE,loop_id TEXT NOT NULL REFERENCES supervision_loops(id),failure_job_id TEXT NOT NULL,request TEXT NOT NULL CHECK(json_valid(request)),record TEXT NOT NULL CHECK(json_valid(record)),UNIQUE(loop_id,failure_job_id));
${['supervision_routing_policies','supervision_routing_capabilities','supervision_progress_rounds','supervision_routes'].map(table=>`CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Immutable routing evidence'); END; CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Immutable routing evidence'); END;`).join('\n')}
`;
