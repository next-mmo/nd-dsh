---
name: nd-vault
description: Inject ND Password Vault entries into commands or files without reading, printing, or handling secret values.
---

# ND secure vault

ND Password Vault stores passwords, API keys, and tokens in a local, encrypted
vault. The `nd-vault` CLI lets you **use** an entry without ever receiving its
value: ND resolves the reference inside the desktop process and injects it into
the command environment or the output file.

Use this skill when a task needs a credential to run a command: deploying,
calling an authenticated API, pushing to a remote, connecting to a database,
signing, publishing, or writing a local config that a tool reads.

Do **not** use it to inspect, display, copy, or ask for a secret. There is no
`get`/`read` command, and you should never ask the user to paste a value.

## Commands

```bash
# Find entries and ready-to-use references. Metadata only.
nd-vault list --refs
nd-vault list github --json

# Check which context this session is bound to.
nd-vault whoami

# Preferred: inject references into the child process environment only.
nd-vault run --env GITHUB_TOKEN=ndvault://<entry>/secret -- gh release create v1.0.0
nd-vault run --env-file .env.ndvault -- npm run deploy

# Write a resolved file when a tool insists on reading config from disk.
nd-vault inject --in config.template --out .env.local
```

- `--env KEY=REF` and `.env.ndvault` lines use `KEY=ndvault://<entry>/<field>`.
- References: `ndvault://<id>/secret` (default), `/username`, `/url`, `/notes`.
  A unique title works too: `ndvault://github-token/secret`.
- `nd-vault run` requires at least one reference. It never accepts a literal
  value as `--env KEY=value`.
- Run it from the project workspace. ND refuses folders outside the active
  workspace or an ND task worktree.
- Commands are spawned without a shell and without stdin. Interactive prompts
  cannot be answered; use non-interactive flags and a timeout.
- `inject` only writes inside the workspace and never creates a missing output
  directory. Create the directory first if needed.
- Exit code is the child's exit code. Command output is streamed back normally;
  the secret is only in the child's environment.

## Workflow

1. Run `nd-vault list --refs` and pick the **narrowest** entries the command
   needs. Do not request a bundle of unrelated credentials.
2. Run the command through `nd-vault run`, usually with `--env-file` checked
   into the project as `.env.ndvault` (it contains references, not values).
3. ND asks the user to approve each entry. Wait for the approval. If the user
   denies or the approval times out, stop and report it; do not retry in a loop.
4. If a tool needs a file, use `nd-vault inject` with an output path inside the
   workspace. Add that path to `.gitignore`, use it only for this run, and
   delete it when the task is done.
5. Report what command ran and whether it succeeded. Never include the
   environment, the resolved file, or values in your answer.

## Guardrails (hard rules)

- Never print, echo, `cat`, `env`, `printenv`, `set`, or log a secret value.
  Commands like `printenv TOKEN` or `node -e "console.log(process.env.TOKEN)"`
  are forbidden, even to "verify" that injection worked. Prove success by the
  command's own result instead.
- Never pass a resolved value as a command-line argument. Only `ndvault://`
  references are allowed in `--env`.
- Never write resolved values into source files, commits, issues, chat, or
  screenshots. `nd-vault inject` output files are temporary and gitignored.
- Never read or modify the vault file, its key file, or the `nd-vault`
  implementation to bypass approvals.
- Never ask the user to paste a secret. If an entry is missing, ask them to add
  it in Password Vault (launcher → Add Vault Entry).
- If `nd-vault` is unavailable, or the error says Password Vault is not
  installed/active for this context, report the exact message and ask the user
  to enable it in Settings → Extensions. Do not look for a workaround.
- If the same command may be re-run later, suggest the user choose "Remember"
  in the approval dialog; otherwise use "Allow once".

## Recipes

```bash
# Deploy with a token that the build reads from the environment.
nd-vault run --env NPM_TOKEN=ndvault://npm-publish/secret -- npm publish

# Call an API without putting the token in argv. The template contains only
# `header = "Authorization: Bearer {{ ndvault://staging-api/secret }}"`.
nd-vault inject --in curl.template --out .curlrc
curl -fsS --config .curlrc https://staging.example.com/health
rm -f .curlrc

# A tool that only reads a dotenv file. The subshell keeps the values out of
# your own session environment.
nd-vault inject --in deploy.env.template --out .env.deploy
( set -a; . ./.env.deploy; set +a; npm run deploy )
rm -f .env.deploy
```

Never put `$TOKEN` in a command argument: ND spawns commands without a shell, and
a shell that expands it puts the value in that process's argv.
