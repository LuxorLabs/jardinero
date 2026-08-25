import { Check, ChevronRight, Copy } from 'lucide-react';
import { type MouseEvent, useCallback, useEffect, useRef, useState } from 'react';
import type {
  AgentCatalogEntry,
  PromptActionResponse,
  PromptsResponse,
  PromptWire,
  AgentPromptSegment,
} from '@shared';
import { PageHeader, Panel, SectionHeading } from '@/components/layout';
import { useReveal } from '@/components/Reveal';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { getJson, postJson, readJsonBody } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useLive } from '@/live/LiveProvider';

const GLOBAL_REPO = '*';

export function PromptsTab() {
  const { refreshSignal, setLive } = useLive();
  const [data, setData] = useState<PromptsResponse | null>(null);
  const [selectedRepo, setSelectedRepo] = useState(() =>
    (new URLSearchParams(window.location.search).get('repo') || GLOBAL_REPO).toLowerCase(),
  );
  // Scopes with unsaved edits; live refreshes are skipped while any card is
  // dirty so a snapshot can never clobber text the operator is still typing.
  const dirtyKeys = useRef<Set<string>>(new Set());
  const [dirtyCount, setDirtyCount] = useState(0);

  const reloadSeq = useRef(0);
  const reload = useCallback(async () => {
    if (dirtyKeys.current.size > 0) return;
    const seq = ++reloadSeq.current;
    try {
      const result = await getJson<PromptsResponse>('/dashboard/api/agents', {
        errorMessage: 'agents refresh failed',
      });
      if (result && seq === reloadSeq.current) setData(result);
    } catch {
      setLive('degraded', 'Agents refresh failed');
    }
  }, [setLive]);

  useEffect(() => {
    void reload();
  }, [reload, refreshSignal]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (selectedRepo && selectedRepo !== GLOBAL_REPO) params.set('repo', selectedRepo);
    else params.delete('repo');
    const query = params.toString();
    window.history.replaceState(null, '', window.location.pathname + (query ? `?${query}` : ''));
  }, [selectedRepo]);

  const setDirty = useCallback((key: string, dirty: boolean) => {
    if (dirty) dirtyKeys.current.add(key);
    else dirtyKeys.current.delete(key);
    setDirtyCount(dirtyKeys.current.size);
  }, []);

  const patchInstruction = useCallback((stored: PromptWire) => {
    // Invalidate any reload already in flight: reload() only checks dirtyKeys at
    // its start, so a GET issued before this mutation would otherwise commit its
    // stale snapshot after this update and clobber it. Bumping the seq makes that
    // in-flight reload discard its result.
    reloadSeq.current += 1;
    setData((prev) => {
      if (!prev) return prev;
      const rest = prev.instructions.filter(
        (entry) => !(entry.repo === stored.repo && entry.agent === stored.agent),
      );
      const knownRepos =
        stored.repo !== GLOBAL_REPO && !prev.known_repos.includes(stored.repo)
          ? [...prev.known_repos, stored.repo].sort()
          : prev.known_repos;
      return { ...prev, known_repos: knownRepos, instructions: [...rest, stored] };
    });
  }, []);

  const removeInstruction = useCallback((repo: string, agent: string) => {
    // Same in-flight-reload guard as patchInstruction: a GET issued before this
    // delete must not reintroduce the just-removed override when it resolves.
    reloadSeq.current += 1;
    setData((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        instructions: prev.instructions.filter(
          (entry) => !(entry.repo === repo && entry.agent === agent),
        ),
      };
    });
  }, []);

  // Cards keep edits in local state, so switching scope remounts them and
  // discards anything unsaved; confirm before throwing that work away.
  const selectScope = useCallback(
    (repo: string) => {
      if (repo === selectedRepo) return;
      if (
        dirtyKeys.current.size > 0 &&
        !window.confirm('Discard unsaved guidance edits in the current scope?')
      ) {
        return;
      }
      setSelectedRepo(repo);
    },
    [selectedRepo],
  );

  const repos = data?.known_repos ?? [];
  const storedFor = (repo: string) => (data?.instructions ?? []).filter((e) => e.repo === repo);
  const scopeLabel = selectedRepo === GLOBAL_REPO ? 'Defaults (all repos)' : selectedRepo;
  const scopeReveal = useReveal();
  const detailsReveal = useReveal();

  return (
    <>
      <PageHeader
        title="Agents"
        description="Rewrite an agent's guidance prose per repository. The machine-readable output contract stays locked and is shown read-only, so a customization can never break the control plane. Changes apply from the next run."
      />
      <div className="grid grid-cols-[280px_1fr] items-start gap-[18px] max-[900px]:grid-cols-1">
        <section
          ref={scopeReveal.ref}
          style={scopeReveal.style}
          className={cn(
            'grid content-start gap-2 self-start rounded-lg border border-border bg-card p-[18px] min-[900px]:sticky min-[900px]:top-6 min-[900px]:max-h-[calc(100vh-3rem)] min-[900px]:overflow-y-auto',
            scopeReveal.className,
          )}
          data-agents-scope-list
        >
          <SectionHeading title="Scope" />
          <ScopeButton
            label="Defaults (all repos)"
            repo={GLOBAL_REPO}
            count={storedFor(GLOBAL_REPO).length}
            selected={selectedRepo === GLOBAL_REPO}
            onSelect={() => selectScope(GLOBAL_REPO)}
          />
          {repos.map((repo) => (
            <ScopeButton
              key={repo}
              label={repo}
              repo={repo}
              count={storedFor(repo).length}
              selected={selectedRepo === repo}
              onSelect={() => selectScope(repo)}
            />
          ))}
          {dirtyCount > 0 && (
            <p className="text-[12px] text-muted-foreground">
              Live refresh is paused while edits are unsaved.
            </p>
          )}
        </section>
        <section
          ref={detailsReveal.ref}
          style={detailsReveal.style}
          className={cn('grid content-start gap-[14px]', detailsReveal.className)}
        >
          <SectionHeading
            title={scopeLabel}
            description={
              selectedRepo === GLOBAL_REPO
                ? 'This guidance overrides the built-in default for every repository.'
                : "This guidance overrides the global default for this repository only; where it's unset, the global default (then the built-in) applies."
            }
          />
          {!data && <p className="text-[13px] text-muted-foreground">Loading prompts…</p>}
          {agentsByWorkflow(data?.agents ?? []).map(([workflowLabel, agents]) => (
            <Panel key={workflowLabel} className="gap-[14px]">
              <SectionHeading title={workflowLabel} />
              {agents.map((agent) => (
                <PromptsCard
                  key={`${selectedRepo}:${agent.agent}`}
                  agent={agent}
                  repo={selectedRepo}
                  stored={data?.instructions.find(
                    (entry) => entry.repo === selectedRepo && entry.agent === agent.agent,
                  )}
                  maxLength={data?.max_instructions_length ?? 0}
                  onDirtyChange={setDirty}
                  onSaved={patchInstruction}
                  onDeleted={removeInstruction}
                />
              ))}
            </Panel>
          ))}
        </section>
      </div>
    </>
  );
}

function ScopeButton({
  label,
  repo,
  count,
  selected,
  onSelect,
}: {
  label: string;
  repo: string;
  count: number;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      data-agents-scope={repo}
      aria-current={selected ? 'true' : 'false'}
      onClick={onSelect}
      className={cn(
        'flex items-center justify-between rounded-md border border-border px-3 py-2 text-left text-[13px] transition-colors hover:bg-accent/50',
        selected && 'border-nav-active bg-nav-active/10 font-[650] text-nav-active hover:bg-nav-active/10',
      )}
    >
      <span className="truncate">{label}</span>
      {count > 0 && (
        <span className="ml-2 rounded-full bg-accent px-2 py-0.5 font-[650] text-[12px]">
          {count}
        </span>
      )}
    </button>
  );
}

function PromptsCard({
  agent,
  repo,
  stored,
  maxLength,
  onDirtyChange,
  onSaved,
  onDeleted,
}: {
  agent: AgentCatalogEntry;
  repo: string;
  stored: PromptWire | undefined;
  maxLength: number;
  onDirtyChange: (key: string, dirty: boolean) => void;
  onSaved: (stored: PromptWire) => void;
  onDeleted: (repo: string, agent: string) => void;
}) {
  const key = `${repo}:${agent.agent}`;
  // The built-in guidance is what the operator edits from; a stored override
  // replaces it. Locked segments (context + output contract) render read-only.
  const editableIndex = agent.segments.findIndex((seg) => seg.editable);
  const defaultText = editableIndex >= 0 ? agent.segments[editableIndex].text : '';
  const lockedSegments = agent.segments.filter((seg) => !seg.editable);

  const [text, setText] = useState(stored?.instructions ?? defaultText);
  const [enabled, setEnabled] = useState(stored?.enabled ?? true);
  // Dirtiness is judged against the row as this card last saw it, not the live
  // prop, so a background refresh can never silently re-arm Save with a fresh
  // revision and let a stale click overwrite someone else's edit. The text
  // baseline falls back to the built-in default when there is no stored override.
  const [baseline, setBaseline] = useState(() => ({
    text: stored?.instructions ?? defaultText,
    enabled: stored?.enabled ?? true,
    revision: stored?.revision,
  }));
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<{ message: string; error: boolean } | null>(null);

  const dirty = text !== baseline.text || enabled !== baseline.enabled;

  useEffect(() => {
    if (stored?.revision === baseline.revision) return;
    if (dirty) return;
    setText(stored?.instructions ?? defaultText);
    setEnabled(stored?.enabled ?? true);
    setBaseline({
      text: stored?.instructions ?? defaultText,
      enabled: stored?.enabled ?? true,
      revision: stored?.revision,
    });
  }, [stored, baseline.revision, dirty, defaultText]);

  useEffect(() => {
    // Blank guidance is unsaveable; reporting it dirty would freeze live refresh.
    onDirtyChange(key, dirty && text.trim().length > 0);
    return () => onDirtyChange(key, false);
  }, [key, dirty, text, onDirtyChange]);

  const save = async () => {
    if (submitting || !dirty) return;
    setSubmitting(true);
    setStatus(null);
    try {
      // The baseline revision, not the live prop: if the row moved on the
      // server since this card last synced, the server answers 409 instead of
      // silently overwriting the newer edit.
      const response = await postJson('/dashboard/api/agents/instructions', {
        repo,
        agent: agent.agent,
        instructions: text,
        enabled,
        confirmed: true,
        ...(baseline.revision !== undefined ? { revision: baseline.revision } : {}),
      });
      const body = await readJsonBody<PromptActionResponse>(response);
      if (!response.ok) {
        setStatus({ message: saveErrorMessage(response.status, body), error: true });
        return;
      }
      if (body.instruction) {
        setBaseline({
          text: body.instruction.instructions,
          enabled: body.instruction.enabled,
          revision: body.instruction.revision,
        });
        onSaved(body.instruction);
      }
      setStatus({ message: 'Saved. Applies from the next run of this agent.', error: false });
    } catch {
      setStatus({ message: 'Save failed. Check the connection and retry.', error: true });
    } finally {
      setSubmitting(false);
    }
  };

  const resetToDefault = async () => {
    if (submitting || !stored) return;
    if (!window.confirm('Reset this agent to its built-in guidance for this scope?')) return;
    setSubmitting(true);
    setStatus(null);
    try {
      const response = await postJson('/dashboard/api/agents/instructions/delete', {
        repo,
        agent: agent.agent,
        confirmed: true,
        ...(baseline.revision !== undefined ? { revision: baseline.revision } : {}),
      });
      const body = await readJsonBody<PromptActionResponse>(response);
      if (!response.ok) {
        setStatus({ message: saveErrorMessage(response.status, body), error: true });
        return;
      }
      onDeleted(repo, agent.agent);
      setText(defaultText);
      setEnabled(true);
      setBaseline({ text: defaultText, enabled: true, revision: undefined });
      setStatus({
        message: 'Reset to the built-in default. Applies from the next run of this agent.',
        error: false,
      });
    } catch {
      setStatus({ message: 'Reset failed. Check the connection and retry.', error: true });
    } finally {
      setSubmitting(false);
    }
  };

  const customization = stored ? (stored.enabled ? ' · customized' : ' · override disabled') : '';

  return (
    <Card data-agent-card={agent.agent}>
      <CardHeader>
        <CardTitle>{agent.label}</CardTitle>
        <CardDescription>
          {agent.workflow_label}
          {customization}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <LockedPromptSection agent={agent.agent} segments={lockedSegments} />
        <div className="grid gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[13px] font-[650]">Guidance</span>
            <CopyButton text={text} label="Copy guidance" />
          </div>
          <p className="text-[12px] text-muted-foreground">
            Editable. Seeded with the built-in guidance; your edits replace it for this scope.
          </p>
          <Textarea
            rows={8}
            value={text}
            maxLength={maxLength}
            disabled={submitting}
            placeholder="Guidance for this agent."
            data-agent-instructions={agent.agent}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-[13px] text-slate">
            <input
              type="checkbox"
              checked={enabled}
              disabled={submitting}
              data-agent-enabled={agent.agent}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Enabled
          </label>
          <div className="flex items-center gap-2">
            <div
              className="h-1 w-16 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={maxLength}
              aria-valuenow={text.length}
            >
              <div
                className={cn(
                  'h-full rounded-full transition-all',
                  text.length / maxLength >= 0.9 ? 'bg-danger-fg' : 'bg-nav-active',
                )}
                style={{ width: `${Math.min(100, (text.length / Math.max(1, maxLength)) * 100)}%` }}
              />
            </div>
            <span className="text-[12px] text-muted-foreground tabular-nums">
              {text.length}/{maxLength}
            </span>
          </div>
          <Button
            type="button"
            disabled={submitting || !dirty || text.trim().length === 0}
            data-agent-save={agent.agent}
            onClick={() => void save()}
          >
            Save
          </Button>
          {stored && (
            <Button
              type="button"
              variant="secondary"
              disabled={submitting}
              data-agent-clear={agent.agent}
              onClick={() => void resetToDefault()}
            >
              Reset to default
            </Button>
          )}
        </div>
        {status && (
          <p
            className={cn('form-status text-[13px]', status.error ? 'text-danger-fg' : 'text-slate')}
            aria-live="polite"
          >
            {status.message}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function LockedPromptSection({
  agent,
  segments,
}: {
  agent: string;
  segments: AgentPromptSegment[];
}) {
  if (segments.length === 0) return null;
  const lockedPromptText = segments
    .map((segment) => `${segment.title}\n${segment.text}`)
    .join('\n\n');
  return (
    <details className="group" data-agent-locked-prompt={agent}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-[13px] text-muted-foreground [&::-webkit-details-marker]:hidden">
        <span className="inline-flex items-center gap-1.5">
          <ChevronRight
            className="size-3.5 shrink-0 transition-transform group-open:rotate-90"
            aria-hidden="true"
          />
          Locked system prompt
        </span>
        <CopyButton text={lockedPromptText} label="Copy" />
      </summary>
      <div className="mt-2 grid gap-2">
        {segments.map((segment) => (
          <section
            key={segment.key}
            data-agent-segment={segment.key}
            data-agent-locked-agent={agent}
          >
            <h4 className="mb-1 text-[12px] font-[650] text-slate">{segment.title}</h4>
            <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-accent/30 p-3 text-[12px]">
              {segment.text}
            </pre>
          </section>
        ))}
      </div>
    </details>
  );
}

// Copies text to the clipboard with a brief "Copied" confirmation. Guards
// against the toggle/submit side effects of its host (summary, form) via
// preventDefault + stopPropagation.
function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied (insecure context, permission); no-op.
    }
  };

  return (
    <button
      type="button"
      disabled={text.trim().length === 0}
      aria-label={copied ? 'Copied' : label}
      onClick={(event) => void copy(event)}
      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-[12px] text-slate transition-colors hover:bg-accent hover:text-ink disabled:cursor-not-allowed disabled:opacity-55"
    >
      {copied ? (
        <Check className="size-3.5 text-success-fg" aria-hidden="true" />
      ) : (
        <Copy className="size-3.5" aria-hidden="true" />
      )}
      {copied ? 'Copied' : label}
    </button>
  );
}

function saveErrorMessage(statusCode: number, body: PromptActionResponse): string {
  if (statusCode === 409) {
    return 'Saved elsewhere since this was loaded. Reload the page to pick up the latest revision.';
  }
  switch (body.error) {
    case 'invalid_instructions':
      return 'Guidance must be non-empty text.';
    case 'instructions_too_long':
      return `Guidance exceeds the ${body.max_length ?? ''} character limit.`;
    case 'invalid_repo':
      return body.message || 'The repository must be an owner/repo slug.';
    case 'invalid_agent':
      return 'Unknown agent.';
    case 'instructions_not_found':
      return 'This customization was already removed.';
    default:
      return body.message || body.error || 'Request failed.';
  }
}

// agentsByWorkflow groups the agents under the workflow that runs them, which is how
// an operator looks for a prompt.
function agentsByWorkflow(agents: AgentCatalogEntry[]): Array<[string, AgentCatalogEntry[]]> {
  const grouped = new Map<string, AgentCatalogEntry[]>();
  for (const agent of agents) {
    const agentsOfWorkflow = grouped.get(agent.workflow_label) ?? [];
    agentsOfWorkflow.push(agent);
    grouped.set(agent.workflow_label, agentsOfWorkflow);
  }
  return [...grouped.entries()];
}
