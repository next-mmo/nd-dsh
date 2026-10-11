# Ultra, reasoning, and parallel-work efficiency

Checked 2026-10-03. These sources explain the distinction; they do not establish a measured speedup for this skill. Recheck current official guidance when product behavior matters.

- [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents): Product Ultra is available on eligible accounts and supported models. It combines maximum reasoning with proactive delegation. Explicit skill instructions can request subagents at other intelligence levels. Subagents can isolate exploration context and reduce elapsed time for independent work, but add model/tool tokens. Parallel code edits require careful ownership. Model and effort inheritance depend on client configuration.
- [Reasoning models](https://developers.openai.com/api/docs/guides/reasoning): Supported efforts vary by model. Lower effort favors speed and lower token use; greater effort may improve difficult reasoning. API reasoning mode and effort are separate controls. Do not assume the product's Ultra label is a portable API parameter, or that maximum effort is best for every task.
- [Latency optimization](https://developers.openai.com/api/docs/guides/latency-optimization): Reduce unnecessary input/output and requests; parallelize independent work. Apply these principles to worker packets and concise reports while retaining acceptance evidence.

## Apply to ND Ultra

Keep difficult planning, diagnosis, and integration with a capable coordinator or specialist. Delegate bounded work with the minimum sufficient context and effort, subject to supported controls and explicit user settings. Schedule prerequisites before downstream work, coordinate shared writes, and evaluate useful completion rather than agent count. Change fan-out when observed overhead or contention outweighs overlap. This is a workflow recommendation derived from the sources, not a built-in Ultra performance guarantee.
