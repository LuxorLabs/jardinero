// operationUrl is where a person watches one workflow instance: the same link the
// dashboard's own lists build in web/src/lib/links.ts, absolute so it can be handed to
// somebody outside the browser. An instance nobody can reach has no link, which is what a
// deployment with no public url means.
export function operationUrl(
  publicUrl: string,
  workflowInstanceId: string,
  sandboxRunId?: string | null,
): string | undefined {
  const base = publicUrl.trim().replace(/\/+$/, '');
  if (!base) return undefined;
  const query = new URLSearchParams({ workflow_instance_id: workflowInstanceId });
  if (sandboxRunId) query.set('sandbox_run_id', sandboxRunId);
  return `${base}/dashboard/operation?${query.toString()}`;
}
