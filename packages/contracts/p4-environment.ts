/** Optional only for compatibility: absence retains the original whole-file fingerprint. */
export interface VerificationEnvironmentScope {
  version: 1;
  projectId: string;
  runId: string;
  workspace: string;
  verificationRoot: string;
}
