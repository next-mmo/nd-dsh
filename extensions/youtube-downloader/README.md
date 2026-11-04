# YouTube Downloader for ND

An on-demand ND extension that saves a **single YouTube video** as a single-file MP4 (up to roughly 720p) or its audio as M4A. It uses the ND embedded browser or connected Chrome companion to find the active video and saves the result to your Downloads folder.

This package is fully external: it is not bundled with ND. Install it from **Settings → Extensions → Discover**, then open it from **Ctrl+K → "YouTube Downloader"**.

## First use

The downloader needs two pinned tools, fetched only after you press **Set up downloader**:

| Tool | Version | Download | License | Source |
| --- | --- | --- | --- | --- |
| yt-dlp | 2026.10.21 | 17,880,111 bytes | Unlicense | `github.com/yt-dlp/yt-dlp` |
| Deno | 2.9.8 | 42,917,472 bytes | MIT | `github.com/denoland/deno` |

ND verifies the exact byte count and SHA-256 before installing either one. Tools live under ND's user data folder (`runtimes/media-downloader/<tool>/<version>/`), not in the app bundle and not on your PATH. Setup never executes the tools; the first download starts them.

Deno is the JavaScript runtime yt-dlp requires for full YouTube support. EJS challenge scripts are bundled inside the official yt-dlp executable.

## What it does

- Reads the **active** YouTube tab (in ND built-in browser or connected Chrome companion), or accepts a pasted watch, Shorts, live, or `youtu.be` link.
- Video: one progressive MP4 with AAC audio, capped at 720p and 4 GiB.
- Audio: one M4A (AAC) file, capped at 512 MiB.
- Moves a verified file into the OS Downloads folder using a Windows-safe filename and never overwrites an existing file.
- Shows progress, speed, ETA, and height; supports cancel and "Show in folder".

## Limits

- **Windows only** in this version.
- No playlists, channels, or batch downloads.
- No 1080p/4K, MP3 conversion, or merging: those need ffmpeg, which this package intentionally does not install.
- No sign-in-only, age-restricted, or members-only videos. The downloader never imports browser cookies.
- YouTube may ask for a bot check; the UI reports it instead of retrying indefinitely.
- One download runs at a time. Recent jobs are kept for the session.

The video button says **up to 720p** because YouTube does not offer a progressive MP4 at 720p for every video. When only 360p is available, that is what you get; higher-resolution streams are video-only and would require ffmpeg to merge.

## Files and removal

- Staging: `<ND user data>/media-downloads/staging/<job>`
- Tool cache: `<ND user data>/media-downloads/cache`
- Tools: `<ND user data>/runtimes/media-downloader/`
- Finished files: your system Downloads folder (revealed after completion)

Uninstalling the extension removes its package and jobs but leaves the downloaded tools and your saved media. Delete `runtimes/media-downloader` to reclaim the tool space.

## Safety

- Fixed yt-dlp arguments; no user-supplied flags, paths, cookies, or output templates.
- `--ignore-config`, `--no-playlist`, and `--no-exec` are always set.
- The child runs with a minimal environment and a PATH that contains only the pinned Deno directory and Windows system folders.
- Downloads are staged, checked for a single expected media file, size-capped, and moved with a collision-safe name. Only a stored completed-job path can be revealed.
- Tool downloads are HTTPS-only, restricted to GitHub release hosts, and rejected on any size or SHA-256 mismatch.

## Rights

Download only content you own or have permission to save. YouTube's terms and the rights of the video owner apply. ND does not host, redistribute, or bypass paid access to any video.

## Licenses

yt-dlp is released under the Unlicense. Deno is released under the MIT License. This package's UI code is part of ND-DSH; its license follows the repository's `LICENSE`.
