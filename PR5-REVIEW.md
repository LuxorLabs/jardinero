# PR #5 — worker: add Freestyle sandbox support

One thread per finding, line numbers on the PR head (79ce9b1). All fourteen anchors fall inside diff hunks, so they can be posted inline.

Checked first: make check passes on the branch (2,656 tests, type-check clean), it merges cleanly with main, and the Freestyle CLI commands the docs introduce all exist.

---

   ## 1. src/orchestrator/worker/tenki-worker.ts:124

   SandboxWorkerRunner is provider-neutral now, but it lives in tenki-worker.ts, so the Freestyle worker imports its base class from the Tenki module. Could you move it to sandbox-worker.ts and leave the Tenki provider behind, splitting the six tenki-worker.*.test.ts shards the same way?

   ## 2. src/adapters/tenki/tenki-utils.ts:8

   Nothing in this file is Tenki-specific anymore: the exec readers take WorkerSandboxExecResult and the rest just handles strings. Could you move it to orchestrator/worker/sandbox-utils.ts?

   ## 3. src/orchestrator/worker/tenki-worker.ts:101

   TenkiWorkerRunnerDeps is an empty alias of SandboxWorkerRunnerDeps, and nothing outside this repo consumes the name. Could you drop it?

   ## 4. src/orchestrator/worker/tenki-worker.ts:1234

   TenkiWorkerRunner is an empty alias of SandboxWorkerRunner, and nothing outside this repo consumes the name. Could you drop it?

   ## 5. src/orchestrator/worker/freestyle-worker.ts:49

   FreestyleWorkerRunner composes a SandboxWorkerRunner while TenkiWorkerRunner inherits from it. Could you make this one inherit too, passing the provider up from its constructor?

   ## 6. src/types.ts:47

   Every type in this area is Sandbox with no prefix: SandboxRunner, SandboxRunContext, SandboxPool, SandboxRun, and the 23 sandbox.* events. Could you drop the Worker from WorkerSandboxSession, WorkerSandboxProvider, WorkerSandboxExecResult and WorkerSandboxExecOutput? The class you added is SandboxWorkerRunner, so the two orders are already mixed.

   ## 7. src/types.ts:32

   WorkerSandboxExecResult accepts almost anything: every field optional, stdout as string or Uint8Array, exitCode and code and status at once. It replaces the SDK's strict ExecResult, so the Tenki path loses type safety too. Both providers already normalize into it, so could you narrow it to exit code, stdout and stderr?

   ## 8. src/orchestrator/worker/freestyle-worker.ts:173

   Let's declare implements WorkerSandboxSession on the class and drop this method.

   ## 9. src/orchestrator/worker/freestyle-worker.test.ts:178

   Let's fold these seven loose tests into one table. And run() is never called anywhere, only the constructor on line 15, so let's add a case that drives it against the fake VM.

   ## 10. src/orchestrator/worker/freestyle-worker.ts:26

   WORKER_HOME is hardcoded but worker.workspace_path is configurable, so any path outside /home/tenki fails at prepareWorkspace's mkdir, after the VM is paid for. Could WORKER_HOME come from worker.workspace_path?

   ## 11. src/orchestrator/worker/freestyle-worker.ts:372

   Let's fail here when sudo is missing. codex-auth.ts uses it unconditionally and setup.md:173 lists it as required, so a snapshot without it starts the run and dies later in the auth forwarding.

   ## 12. src/orchestrator/worker/freestyle-worker.ts:385

   When a command hits the 5 minute limit, the run fails with "exit code 1" and an empty error, so nobody can tell a timeout from a real failure. Let's report the timeout as a timeout, the way line 403 already does.

   ## 13. src/orchestrator/worker/freestyle-worker.ts:330

   Let's add a comment with the reason this can't be ephemeral. The TTL backstops either mode, so it doesn't explain the choice on its own.

   ## 14. AGENTS.md:7

   Could you lowercase Persistent here and in the same sentence in docs/architecture.md:3? Though the VM is created and deleted per run, so from Jardinero's side it is as ephemeral as a Tenki sandbox: is the Freestyle storage mode worth naming in this sentence at all?
