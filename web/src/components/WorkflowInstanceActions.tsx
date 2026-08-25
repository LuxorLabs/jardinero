import { useState } from 'react';
import type { WorkflowInstanceRow } from '@shared';
import { postJson, readJsonBody } from '@/lib/api';

// WorkflowInstanceActions offers what a person can do with an instance that is waiting for
// one: run the machine again, judge again what it already pushed, or end it. Each answers
// inline, and the live stream brings the row back without it.
export function WorkflowInstanceActions({ instance }: { instance: WorkflowInstanceRow }) {
  const [message, setMessage] = useState('');
  const act = async (action: 'retry' | 'retry-verification' | 'dismiss', failure: string) => {
    const response = await postJson(
      `/dashboard/api/workflow-instances/${instance.workflow_type}/${instance.workflow_instance_id}/${action}`,
    );
    const body = await readJsonBody<{ reason?: string }>(response);
    setMessage(response.ok ? action : (body.reason ?? failure));
  };

  return (
    <span className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        className="h-8 rounded-md border border-control bg-card px-2.5 font-bold text-[13px]"
        onClick={() => act('retry', 'could not retry it')}
      >
        {instance.workflow_type === 'linear_implementer' ? 'Retry implementation' : 'Retry'}
      </button>
      {/* Only the Linear implementer verifies, so nowhere else has a verification to run. */}
      {instance.workflow_type === 'linear_implementer' && (
        <button
          type="button"
          className="h-8 rounded-md border border-control bg-card px-2.5 font-bold text-[13px]"
          onClick={() => act('retry-verification', 'could not verify it again')}
        >
          Retry verification
        </button>
      )}
      <button
        type="button"
        className="h-8 rounded-md border border-control bg-card px-2.5 font-bold text-[13px]"
        onClick={() => act('dismiss', 'could not dismiss it')}
      >
        Dismiss
      </button>
      {message && <span className="text-[12px] text-muted-foreground">{message}</span>}
    </span>
  );
}
