# ND-DSH Rust migration glossary

| ND term | Meaning / native boundary |
| --- | --- |
| ND Core | One shared Rust sidecar, stdio RPC owned by Electron main |
| Worktree | Isolated writable task checkout under ND orchestration; NOT equivalent to workspace root |
| Company / project / task | Persisted product-scope identity and policy boundaries |
| Runtime permit | Capacity claim, cancellation/resource ownership in ND core |
| Workspace | User-selected root, with canonical containment and symlink checks |
| ND Harness | Vendor coding runtime; remains replaceable infrastructure |
| ND Router | Provider/model routing; existing Rust crate + desktop adapter |
| Browser profile | Persistent Electron Chromium partition, **not** a Rust process |
| Parity case | Captured input, original output/error and observable side effects |
| Gate | rust-anything acceptance on a recorded Rust unit; not a desktop release approval |
| Shadow | Wrapper that returns original results while comparing Rust, with explicit cutover toggle |
| Lift | Remove fallback only after all standalone sub-app units and replay are green |
