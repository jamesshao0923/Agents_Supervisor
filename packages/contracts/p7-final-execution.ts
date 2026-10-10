/** Future final integration only: distinct from P4 protection, never spent twice.
 * Exact attempt identity prevents a different claim for the same node consuming it. */
export interface FutureExecutionAllocation {
 allocationId:string;contractVersion:number;nodeId:string;attemptId:string;amount:number;
}
