/** Import-free DDL; scratch migration must be merged/versioned by the root. */
/** Root keeps maintenance16 first; this packet is an additive migration17. */
export const RESEARCH_WORKFLOW_MIGRATION_VERSION = 17;
export const RESEARCH_WORKFLOW_MIGRATION_SQL = `
CREATE TABLE research_workflow_plans(proposal_id TEXT PRIMARY KEY,proposal_kind TEXT NOT NULL DEFAULT 'proposal' CHECK(proposal_kind='proposal'),record TEXT NOT NULL CHECK(json_valid(record)),FOREIGN KEY(proposal_kind,proposal_id) REFERENCES verification_records(kind,id));
CREATE TABLE research_artifact_evidence(job_id TEXT PRIMARY KEY,job_kind TEXT NOT NULL DEFAULT 'job' CHECK(job_kind='job'),record TEXT NOT NULL CHECK(json_valid(record)),FOREIGN KEY(job_kind,job_id) REFERENCES verification_records(kind,id));
CREATE TABLE research_delivery_seals(delivery_id TEXT PRIMARY KEY,delivery_kind TEXT NOT NULL DEFAULT 'delivery' CHECK(delivery_kind='delivery'),command_id TEXT NOT NULL UNIQUE,record TEXT NOT NULL CHECK(json_valid(record)),FOREIGN KEY(delivery_kind,delivery_id) REFERENCES verification_records(kind,id));`;
