---
title: Editing with Claude Code
description: Let Claude Code read and change the songs and visuals in your open project — live, undoable, and recorded in History.
---

Claude Code can work on the project you have open in Stave: change a pattern, write a Hydra
sketch, fix an error. It does this through **stave-mcp**, a small server on your computer that
Claude Code starts, and a setting in Stave that lets your tab talk to it. Nothing leaves your
machine, and nothing happens until you turn it on.

## Set it up once

In a checkout of the Stave repository:

```bash
pnpm install
pnpm --filter @stave/mcp build
claude mcp add stave -- node "$PWD/packages/mcp/dist/cli.js"
```

Then, in Stave, open **File ▸ Editor Settings… ▸ Claude Code**:

1. Turn on **Let Claude Code edit this tab**.
2. Paste the pairing code and press **Pair**. Get the code with
   `node packages/mcp/dist/cli.js pairing-code`, or ask Claude for it.

The status line reads **Connected** whenever a Claude Code session is open. When you close
Claude Code it reads *Waiting for stave-mcp*, and the tab reconnects by itself next time.

## What Claude can do

Ask in plain words — "make the hi-hats double time", "add a Hydra visual that pulses with the
kick and show it with the drums". Claude can list, read, edit, create and rename the project's
files, check them for errors, and take a picture of a visual on screen.

Each change it makes:

- **goes live.** A playing song is re-evaluated, so you hear it; a visual on screen redraws.
- **leaves your cursor alone.** Only the changed text is touched, in the open editor.
- **is one undo.** Press Ctrl/Cmd+Z in the editor to take it back.
- **is recorded in History**, labelled *Claude Code: edited …*, so you can compare or roll back
  from the Version History panel at any time.
- **is announced** with a small notice in the corner.

Claude also sees what you would see: if a change does not evaluate, the error comes back to it
with the line number, and it can look at a visual to judge the result. A visual has to be on
screen (open it and press its Play) for Claude to see it draw.

Claude cannot delete files, open other projects, or change anything while you are viewing a
past version from History.

## Which browser

| | Your local dev server (`pnpm dev`) | stave.live |
|---|---|---|
| **Chrome** | ✓ | ✓ — Chrome asks once whether stave.live may reach apps on this device. Allow it. |
| **Safari** | ✓ | ✗ — Safari blocks a secure page from connecting to `127.0.0.1`. Use Chrome, or run Stave locally. |
| **Firefox** | ✓ | ✓ — it may ask for local-network access, like Chrome. |

## Turning it off

Switch off **Let Claude Code edit this tab**. The connection closes at once and the tab stops
looking for stave-mcp. To make a new pairing code (any paired tab then has to pair again), run
`node packages/mcp/dist/cli.js reset-pairing`.
