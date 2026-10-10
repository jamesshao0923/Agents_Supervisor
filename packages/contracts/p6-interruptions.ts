/** Durable user pause provenance, separate from mutable verifier error prose. */
export interface SupervisionInterruption {
  id:string;loopId:string;jobId:string;origin:'explicit-supervision-pause';requestedAt:string;
  runtimeId:string;projectId:string;runId:string;kind:'review'|'verification';proposalId:string;planId:string|null;
  boundary:{contractDigest:string;proposalDigest:string;planDigest:string|null;head:{id:string;version:number|null}|null;environmentDigest:string;requestDigest:string;configDigest:string};
  replacement:{commandId:string;intentId:string;authorizedAt:string;jobId:string|null}|null;
}
