# stave-mcp

A local [MCP](https://modelcontextprotocol.io) server that lets Claude Code read and change
the songs and visuals in a Stave tab you have open — and see what it did: evaluation errors
come back with each change, and it can take a picture of a visual. It can also start a new
project in that tab, or switch it to another of your projects.

```
Claude Code ──stdio (MCP)──▶ stave-mcp ──WebSocket, 127.0.0.1──▶ your Stave tab
                                                                 (Settings → Claude Code)
```

Projects live only in the browser (IndexedDB), so the tab does the work. stave-mcp relays
each tool call to it, and the tab answers by calling its own workspace API — the same
functions its editor calls when you type.

## Set up

From the repository root:

```bash
pnpm install
pnpm --filter @stave/mcp build
claude mcp add stave -- node "$PWD/packages/mcp/dist/cli.js"
```

Then pair a tab:

1. Print the pairing code: `node packages/mcp/dist/cli.js pairing-code`
   (or ask Claude — the `stave_status` tool shows it while no tab is connected).
2. In Stave: **File ▸ Editor Settings… ▸ Claude Code**, turn on **Let Claude Code edit this
   tab**, paste the code and press **Pair**. The status line says *Connected* once a Claude
   Code session with the server is open.

The code is `<port>-<token>`. The token is made once and kept in
`~/.config/stave-mcp/pairing.json` (mode 0600), so a paired tab stays paired across Claude
Code sessions. `stave-mcp reset-pairing` replaces it.

## Tools

| Tool | What it does |
|---|---|
| `stave_status` | Is a tab paired; its project, open and playing files. With no tab: the pairing steps. |
| `list_files` | Every file, with language, size, and whether it is open or playing. |
| `read_file` | A file's current text, as the editor holds it. |
| `edit_file` | Exact-text replacements (`old_text` → `new_text`, all or nothing). |
| `write_file` | Replace a file's whole text. |
| `create_file` | A new file; the extension picks its type. |
| `rename_file` | Rename or move, keeping its type. |
| `get_diagnostics` | Evaluate a file as Stave would and return its errors. |
| `capture_canvas` | A PNG of what a visual is drawing on screen. |
| `list_projects` | Every project in the tab's browser, most recently opened first; which one is open. |
| `create_project` | A new, empty project, and switch the tab to it. Answers once it is ready for files. |
| `open_project` | Switch the tab to another project, by id or exact name. |

The file tools act on the project open in the tab. `create_project` and `open_project` switch
it the way the project switcher does: the project you had open is saved as it is, anything
playing stops, and the call answers only once the new project's editor and History have
started — so a `create_file` straight after lands in it and is recorded. They refuse, and say
why, while you are viewing a past version from History, while the tab is already switching,
or while storage is full and the open project holds changes the disk refused (leaving would
lose them). `create_project` also refuses a name a project already has, so `open_project`
by name stays unambiguous.

Every change:

- **is applied as the regions that changed**, through the open editor when there is one
  (`commitToFile`, the same door the Mixer and Sequencer write through), so your cursor stays
  where it is and one Ctrl/Cmd+Z undoes it;
- **is recorded in History** as its own commit, labelled `Claude Code: edited <file>`;
- **goes live**: a playing song is re-evaluated, a visual on screen redraws;
- **comes back with diagnostics**: the engine's error for a song (evaluated silently, without
  sound, when it is not playing), or a visual's syntax and draw-time errors;
- shows a toast in the tab, so you see what changed.

## Security

The bridge can change your work, so it is closed by default and each layer refuses on its own:

1. **Off unless you turn it on**, per browser, in Settings. Off, the tab opens no socket.
2. **Loopback only.** stave-mcp listens on `127.0.0.1`; nothing off the machine reaches it.
3. **Host check.** The `Host` header must name this machine, which defeats DNS rebinding.
4. **Origin allow-list.** Browsers always send `Origin` on a WebSocket handshake and a page
   cannot forge it, so an arbitrary site you visit cannot even open the socket. Default:
   `https://stave.live` and `http://localhost:*` / `127.0.0.1:*` / `[::1]:*` (any port, for
   a dev server). Override with `STAVE_MCP_ORIGINS` (comma-separated; `*` as the port means
   any port) — e.g. to add a preview deployment.
5. **Pairing token.** A local program that is not a browser can forge an Origin, so the first
   message must carry the token, within 5 seconds, compared in constant time.
6. **One tab at a time.** The most recently paired tab is driven; the older one is told it
   was replaced and stops reconnecting until you press *Take over*.

The tab, for its part, trusts whatever answers on the paired port of `127.0.0.1`. A program
already running as you could stand in for stave-mcp there — but such a program can read the
token file, and your files, anyway.

Tab-side, the agent can only do what the workspace API offers: read, write, create and
rename files in the open project, and create or switch to a project. It cannot delete files
or projects, change a project it has not opened, or reach assets, and it refuses to write
(or switch) while you are viewing a past version from History.

## Which browsers can connect

Stave on **your own dev server** (`pnpm dev`, an `http://localhost` page) connects in every
browser. **stave.live** is an https page dialling `ws://127.0.0.1`, and browsers treat that
differently:

| Browser | stave.live → `ws://127.0.0.1` | Measured |
|---|---|---|
| Chrome 147+ | Works after you allow the site to reach apps on this device (Chrome asks once, the first time the tab tries). Refused until then. Not treated as mixed content. | Chrome 155.0.8059.84: without the permission the socket fails with `net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS` (`error`, then `close` 1006); with `local-network-access` granted it opens. |
| Safari (through 27) | **Blocked** as mixed content. No prompt and no setting a site can use. Use Chrome, or run Stave locally. | WebKit 26.4: the page logs `[blocked] The page at https://… requested insecure content from ws://127.0.0.1:…` and the socket never opens. |
| Firefox | Not mixed content (Firefox exempts loopback). Recent versions roll out a local-network prompt like Chrome's; expect to allow it once. | Not measured. |

Measured with `STAVE_OBSERVE_BRIDGE=1 npx playwright test tests/agent-bridge-browsers.spec.ts
--project=chromium` in `packages/app` (2026-10-16). It drives the installed Google Chrome with a
throwaway profile from a real public page, and Playwright's WebKit from an intercepted https
page. Background on each browser's rules — Chrome's Local Network Access ([chromestatus][lna]),
WebKit's open bug on loopback mixed content ([171934][wk171934]) — was gathered separately and
is cited, not measured, where the table says so.

[lna]: https://chromestatus.com/feature/5152728072060928
[wk171934]: https://bugs.webkit.org/show_bug.cgi?id=171934

## Design notes

- **No second Yjs peer.** stave-mcp never joins the project document. History's auto-commit
  hears only local transactions (`historyDriver` subscribes with `{ localOnly: true }`), so an
  edit arriving as a remote Yjs update would never be snapshotted and could not be rolled
  back. Every write is made inside the tab instead, and is local.
- **Minimal edits, applied by the editor.** `setContent` replaces the whole text, and an open
  editor follows a changed file by replacing its whole model (`@monaco-editor/react` syncs its
  `value` with one full-range edit) — either way the cursor jumps to the end. So the tab diffs
  old against new (lines first, then characters) and hands only the changed regions to the
  file's open editor; the editor's own change handler then writes the store. A diff applied to
  the store alone would not help: the editor would still replace its whole model.
- **The tab dials out.** A page cannot listen, so the tab is the WebSocket client and
  stave-mcp the server. While no Claude Code session is running, the tab retries with
  back-off up to every 30 seconds.
- **Protocol.** JSON-RPC 2.0. The tab opens with `bridge.hello` (token, protocol version,
  project); after that stave-mcp sends the requests in [`src/protocol.ts`](src/protocol.ts) and
  the tab answers them one at a time, so two writes never interleave. The app takes only
  types from this package; `protocolConstants.test.ts` holds its copy of the codes equal.
- **Adding a method does not bump `PROTOCOL_VERSION`.** A tab without it answers -32601
  (method not found), and the tool tells the agent the tab needs reloading; every other tool
  keeps working with that tab. A bump would refuse the older tab outright. The version moves
  only when an existing method changes shape.

## Environment

| Variable | Default | |
|---|---|---|
| `STAVE_MCP_PORT` | `47883` | Port on 127.0.0.1. One stave-mcp per port: a second Claude Code session's server waits for the port and says so in `stave_status`. |
| `STAVE_MCP_ORIGINS` | see Security | Pages allowed to connect. |
| `STAVE_MCP_TOKEN` | saved token | Use this token instead (tests). |

## Tests

- `pnpm --filter @stave/mcp test` — the bridge's refusals (origin, host, token, protocol),
  request/response, timeouts, takeover, a busy port; and each MCP tool's mapping.
- `packages/app/src/agentBridge/__tests__` — the tab side: the diff, exact-text edits, the
  connector's states, and the handlers against the real workspace store (the project
  handlers against a stand-in for the app's project list).
- `packages/app/tests/agent-bridge.spec.ts` — end to end: the real CLI over stdio and a dev
  tab paired through Settings. The user's cursor stays put, one undo reverts an edit, History
  records it, a playing song re-evaluates and reports a bad edit's error, a Hydra visual on
  screen redraws and is captured, and a project the agent creates takes its next file and
  History commit before `open_project` switches back.
