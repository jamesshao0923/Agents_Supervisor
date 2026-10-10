/** Import-free additive SQL prevents migration dependency initialization cycles. */
export const CONTROL_MAINTENANCE_MIGRATION_SQL=`
CREATE TABLE supervision_control_maintenance(id TEXT PRIMARY KEY,loop_id TEXT NOT NULL UNIQUE REFERENCES supervision_loops(id),record TEXT NOT NULL CHECK(json_valid(record)));
CREATE TABLE control_maintenance_replays(review_id TEXT PRIMARY KEY,proposal_id TEXT NOT NULL,record TEXT NOT NULL CHECK(json_valid(record)));
CREATE TABLE control_maintenance_receipts(command_id TEXT PRIMARY KEY,request TEXT NOT NULL CHECK(json_valid(request)),result TEXT NOT NULL CHECK(json_valid(result)));
CREATE TABLE control_maintenance_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,maintenance_id TEXT NOT NULL,record TEXT NOT NULL CHECK(json_valid(record)));
CREATE TRIGGER supervision_control_maintenance_binding BEFORE UPDATE ON supervision_control_maintenance WHEN NEW.id!=OLD.id OR NEW.loop_id!=OLD.loop_id OR json_extract(NEW.record,'$.basis')!=json_extract(OLD.record,'$.basis') OR json_extract(NEW.record,'$.basisDigest')!=json_extract(OLD.record,'$.basisDigest') OR json_extract(NEW.record,'$.authorJobId')!=json_extract(OLD.record,'$.authorJobId') BEGIN SELECT RAISE(ABORT,'Maintenance binding is immutable');END;
CREATE TRIGGER control_maintenance_replays_immutable BEFORE UPDATE ON control_maintenance_replays BEGIN SELECT RAISE(ABORT,'Maintenance replay is immutable');END;
CREATE TRIGGER control_maintenance_replays_no_delete BEFORE DELETE ON control_maintenance_replays BEGIN SELECT RAISE(ABORT,'Maintenance replay is immutable');END;
`;
