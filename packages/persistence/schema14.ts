/** No runtime imports: migrations must never initialize controllers/repositories. */
export const AUTHOR_ROUTE_MIGRATION_SQL = `
CREATE TABLE supervision_author_routes(
 id TEXT PRIMARY KEY, command_id TEXT NOT NULL UNIQUE,
 previous_job_id TEXT NOT NULL UNIQUE REFERENCES supervision_jobs(id),
 loop_id TEXT NOT NULL REFERENCES supervision_loops(id),
 request TEXT NOT NULL CHECK(json_valid(request)),record TEXT NOT NULL CHECK(json_valid(record))
);
CREATE TRIGGER supervision_author_routes_no_update BEFORE UPDATE ON supervision_author_routes BEGIN SELECT RAISE(ABORT,'Immutable author route'); END;
CREATE TRIGGER supervision_author_routes_no_delete BEFORE DELETE ON supervision_author_routes BEGIN SELECT RAISE(ABORT,'Immutable author route'); END;
`;
