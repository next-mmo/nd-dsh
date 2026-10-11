/**
 * The Extension Developer Guide's downloadable starter: a complete, installable
 * nd.extension/1 package as plain files. It is intentionally declarative-only —
 * it installs and runs with no executable, no build step, and nothing but this
 * folder, so the first `git init` happens on a working extension.
 */

export const STARTER_KIT_ROOT = 'nd-extension-starter'

const STARTER_MANIFEST = `{
  "protocol": "nd.extension/1",
  "id": "dev.my-first-extension",
  "name": "My First Extension",
  "description": "My own ND extension, started from the downloadable starter kit: one launcher command that saves a note, a schema-driven list view over those notes, and an instruction-only skill. Rename the id, make it yours, and ship it.",
  "version": "0.1.0",
  "apiVersion": 1,
  "contexts": ["personal", "company", "project"],
  "permissions": ["notes.read", "notes.write"],
  "contributions": {
    "commands": [
      {
        "id": "save-note",
        "title": "Save a note",
        "description": "Save the launcher text as a note in the selected context.",
        "keywords": ["note", "save", "memo"],
        "host": "note.create",
        "contexts": ["personal", "company", "project"]
      },
      {
        "id": "open-notes",
        "title": "Open my notes",
        "description": "Open the notes list view.",
        "keywords": ["notes", "list", "open"],
        "host": "note.search",
        "openViewId": "my-notes",
        "contexts": ["personal", "company", "project"]
      }
    ],
    "views": [
      {
        "id": "my-notes",
        "title": "My notes",
        "description": "No notes yet. Run Save a note from the launcher.",
        "kind": "list",
        "host": "note.search",
        "itemTitleKey": "title",
        "itemBodyKey": "body",
        "contexts": ["personal", "company", "project"],
        "actions": [
          { "id": "note-open", "title": "Open note", "host": "note.open" }
        ]
      }
    ],
    "skills": [
      {
        "id": "my-extension-walkthrough",
        "title": "My Extension walkthrough",
        "description": "Instruction-only skill describing this package. No code runs.",
        "instructions": "My First Extension is a starter nd.extension/1 package. It saves notes with note.create, lists them in a view backed by note.search, and opens one with note.open. Every contribution calls an allowlisted ND host method through the invocation broker, which enforces the declared permissions and grants. Extend it by adding contributions that reference other host methods from the authoring guide, declaring each method's permission in the manifest.",
        "contexts": ["personal", "company", "project"]
      }
    ]
  }
}
`

const STARTER_README = `# My First Extension

This folder is a **complete, installable ND extension** (\`nd.extension/1\`). There is
nothing to build and nothing to configure — the manifest below is the whole
package. Unzip it anywhere, install it, then make it yours.

## What is inside

| File | What it is |
| --- | --- |
| \`nd-extension.json\` | The manifest: identity, permissions, and every contribution (commands, views, skills) |
| \`README.md\` | This file |
| \`.gitignore\` | Sensible defaults for a repo that may grow an executable tool later |

The starter ships three declarative contributions:

1. **Save a note** — a launcher command backed by ND's \`note.create\` host method.
2. **My notes** — a schema-driven list view over \`note.search\`; ND renders the rows, no UI code.
3. **A walkthrough skill** — instruction-only context for ND Agent.

## Install it right now

1. Open ND, go to **Extensions**, and choose **Install local…**
2. Select **this folder** (the one containing \`nd-extension.json\`).
3. Open the launcher and type "Save a note" — that is your extension running.

## Make it yours

- Open \`nd-extension.json\` and change \`id\`, \`name\`, \`description\`, and \`version\`.
  The \`id\` is the package's identity — keep the \`yourname.something\` shape.
- Add commands, views, and skills that reference other ND host methods. Every
  host method maps to one permission; declare each in \`permissions\` or ND will
  refuse to install the manifest.
- Later, tools can attach an executable runtime (a local command ND spawns and
  supervises). The authoring guide covers the contract.

## Iterate

- Edit the manifest, then reinstall: **Extensions → Install local…** again, or
  use the package's update action. ND re-validates everything on install.
- No build step, no watcher — save the file and reinstall.

## Own it with git

\`\`\`sh
git init
git add -A
git commit -m "Start my ND extension"
\`\`\`

From here it is a normal repository: branch, tag releases, host it anywhere.
The folder layout is the distribution format, so what you commit is what you
install.

## Learn more

- In-app: **Extensions → Extension developer guide** (Overview and the full
  authoring guide ship with every ND build).
- The host-method table in the authoring guide lists every capability an
  extension can call, with the permission each one requires.
`

const STARTER_GITIGNORE = `# OS noise
.DS_Store
Thumbs.db

# Tool runtimes you may add later (local installs, logs)
node_modules/
*.log

# Local scratch — never commit real API keys or tokens
.env
.env.*
`

/** Archive-relative files of the starter kit, in stable order. */
export function starterKitFiles(): { path: string; data: string }[] {
  return [
    { path: `${STARTER_KIT_ROOT}/nd-extension.json`, data: STARTER_MANIFEST },
    { path: `${STARTER_KIT_ROOT}/README.md`, data: STARTER_README },
    { path: `${STARTER_KIT_ROOT}/.gitignore`, data: STARTER_GITIGNORE },
  ]
}
