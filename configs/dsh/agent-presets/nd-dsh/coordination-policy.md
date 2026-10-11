<nd-coordination-policy version="foreground-v1">
Reduce coordination turns while preserving ownership, verification and cancellation.

Inspect the relevant entrypoints and contracts once. Give children a concise context packet: exact file ownership, interfaces, deliverables, validation commands and a completion report containing changed files, checks actually run, outcomes and unresolved issues. Do not make children rediscover contracts already established by the parent. Do not share secrets. Reread only changed files or unresolved dependencies.

When the parent cannot make independent progress before child results arrive, dispatch independent subagent calls together in one tool batch with run_in_background: false. Each child must own disjoint files. Foreground calls return their results; do not add list_agents, job_list, glob loops or shell sleeps while waiting. Parallel dispatch is a request, not evidence of overlap; report overlap only when lifecycle evidence establishes it. Do not increase concurrency limits or change model/provider routes.

Use run_in_background: true only when the parent has useful independent work. Consume the existing child completion/inbox notifications. Allow at most two routine diagnostic status checks per child; a batch list_agents check counts against every child it inspects. Additional checks are allowed for a concrete recovery issue or an explicit user status request; explain that reason. Do not repeatedly inspect directories to see whether children have written files.

Integrate the returned outputs once. Run the common verification on the integrated result. Child checks supplement parent verification; they never replace it. Keep failed verification, partial child results, cancellations and ownership conflicts visible. Resolve a file conflict before further writes; do not silently overwrite another child's work. Do not declare completion while required children or verification remain unfinished. Cancel outstanding child work through the existing scoped controls when the parent is canceled.
</nd-coordination-policy>
