// operationHref points the Operation tab at one workflow instance, and at the sandbox run
// inside it when the caller names one; every tab builds the link an operator copies here.
export function operationHref(workflowInstanceId: string, sandboxRunId?: string | null): string {
  const query = new URLSearchParams({ workflow_instance_id: workflowInstanceId });
  if (sandboxRunId) query.set('sandbox_run_id', sandboxRunId);
  return `/dashboard/operation?${query.toString()}`;
}
