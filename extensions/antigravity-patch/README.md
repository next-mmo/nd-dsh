# Antigravity Patch

A small GUI in ND for the separately installed **Antigravity desktop app**. It prepares requests for ND's bundled `/antigravity-patch` skill; it does not enable or modify ND's browser inspector.

After restarting the updated ND app, open **Extensions → Discover → Antigravity Patch**, install it, and activate **Personal**. Packaged users can use **Install from folder** with this directory. Open the panel from Extensions or Ctrl+K → **Antigravity Patch**.

Choose **Help**, **Status**, **Apply / Reapply**, **Reset patch**, or **Adopt existing patch**. Preview changes is enabled by default for Apply, Reset, and Adopt. Click **Open in ND Chat** to insert the slash-skill request into the current composer. Existing draft text is kept beneath it. Review the request and press Send yourself.

The panel never runs a helper, changes app files, starts a model turn, or switches engines. Select an ND agent route with authorized local execution tools to actually patch Antigravity. A web-only chat route can explain the request but cannot run local patch commands. The skill handles version checks, backups, adoption, and rollback using `%LOCALAPPDATA%/ND/Patches/Antigravity/`.

The package ships only static HTML/CSS/JavaScript. Its sole host action is `skill.compose`, with `chat.compose` permission. That host checks the current ND skill catalog and accepts user callers only. No executable runtime, Node access, external browser, network connection, or background job is needed for the panel.
