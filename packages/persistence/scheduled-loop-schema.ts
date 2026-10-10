/** Additive private candidate migration. No runtime imports. */
export const SCHEDULED_LOOP_MIGRATION_SQL = `
CREATE TABLE scheduled_plan_revisions(scheduler_id TEXT NOT NULL REFERENCES scheduled_plans(id),revision INTEGER NOT NULL,parent_revision INTEGER NOT NULL,digest TEXT NOT NULL,record TEXT NOT NULL CHECK(json_valid(record)),PRIMARY KEY(scheduler_id,revision));
CREATE TABLE scheduled_task_origins(scheduler_id TEXT NOT NULL REFERENCES scheduled_plans(id),task_id TEXT NOT NULL,generation INTEGER NOT NULL,record TEXT NOT NULL CHECK(json_valid(record)),PRIMARY KEY(scheduler_id,task_id,generation));
CREATE TABLE scheduled_loop_programs(scheduler_id TEXT PRIMARY KEY REFERENCES scheduled_plans(id),digest TEXT NOT NULL,record TEXT NOT NULL CHECK(json_valid(record)));
CREATE TABLE scheduled_loop_states(scheduler_id TEXT PRIMARY KEY REFERENCES scheduled_plans(id),record TEXT NOT NULL CHECK(json_valid(record)));
CREATE TABLE scheduled_loop_iterations(id TEXT PRIMARY KEY,scheduler_id TEXT NOT NULL REFERENCES scheduled_plans(id),record TEXT NOT NULL CHECK(json_valid(record)));
CREATE TABLE scheduled_loop_decisions(id TEXT PRIMARY KEY,scheduler_id TEXT NOT NULL REFERENCES scheduled_plans(id),iteration_id TEXT NOT NULL,record TEXT NOT NULL CHECK(json_valid(record)),UNIQUE(scheduler_id,iteration_id));
CREATE TABLE scheduled_loop_receipts(command_id TEXT PRIMARY KEY,request TEXT NOT NULL CHECK(json_valid(request)),result TEXT NOT NULL CHECK(json_valid(result)));
CREATE TABLE scheduled_loop_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,scheduler_id TEXT NOT NULL,kind TEXT NOT NULL,record TEXT NOT NULL CHECK(json_valid(record)));
${['scheduled_plan_revisions','scheduled_task_origins','scheduled_loop_programs','scheduled_loop_iterations','scheduled_loop_decisions','scheduled_loop_receipts','scheduled_loop_events'].map(t=>`CREATE TRIGGER ${t}_no_update BEFORE UPDATE ON ${t} BEGIN SELECT RAISE(ABORT,'Loop history immutable');END; CREATE TRIGGER ${t}_no_delete BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT,'Loop history immutable');END;`).join('\n')}
`;
