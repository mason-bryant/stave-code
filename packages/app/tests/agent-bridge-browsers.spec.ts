/**
 * OBSERVATION — what a deployed (https) Stave page meets when it dials
 * stave-mcp at ws://127.0.0.1, in Chromium and in WebKit (Safari's engine).
 *
 * Manual: `STAVE_OBSERVE_BRIDGE=1 npx playwright test tests/agent-bridge-browsers.spec.ts --project=chromium`.
 * It launches both engines itself, so the one project is enough.
 *
 * The page is served from https://stave.example by request interception, so the
 * browser treats it as a public https origin — the stave.live case — without a
 * deployment; http://localhost stands for the local dev build.
 *
 * ⚠ Playwright's bundled Chromium opens the hosted case with no permission at
 * all: an intercepted page has no address, so Local Network Access has nothing
 * to compare. So the installed Google Chrome is also driven (a throwaway
 * profile) from a real public page, https://example.com — that needs the network.
 *
 * Results are recorded in packages/mcp/README.md ("Which browsers can
 * connect"). It is gated because what it measures belongs to the browsers, not
 * to this repo: a browser update can change the answer.
 */
import { chromium, expect, test, webkit, type Browser } from '@playwright/test'

import { startStaveMcp } from './_staveMcp'

/** A public https origin — the stave.live case. */
const HOSTED = 'https://stave.example'
/** The local dev build's origin (no server needed: the page is intercepted too). */
const DEV = 'http://localhost:4999'
/** A real public https page, for real Chrome's Local Network Access check. */
const PUBLIC = 'https://example.com'

interface Probe {
  events: string[]
  threw?: string
  timeout?: boolean
  console: string[]
}

async function dialFrom(
  browser: Browser,
  origin: string,
  port: number,
  opts: { grant?: string[]; intercept?: boolean } = {},
): Promise<Probe> {
  const context = await browser.newContext()
  if (opts.grant?.length) await context.grantPermissions(opts.grant, { origin })
  const page = await context.newPage()
  const consoleLines: string[] = []
  page.on('console', (m) => consoleLines.push(`${m.type()}: ${m.text()}`))
  if (opts.intercept !== false) {
    await page.route(`${origin}/**`, (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>probe</title><p>probe</p>' }),
    )
  }
  await page.goto(`${origin}/`)
  const result = await page.evaluate(
    (url) =>
      new Promise<{ events: string[]; threw?: string; timeout?: boolean }>((resolve) => {
        const events: string[] = []
        let ws: WebSocket
        try {
          ws = new WebSocket(url)
        } catch (e) {
          resolve({ events, threw: `${(e as Error).name}: ${(e as Error).message}` })
          return
        }
        ws.onopen = () => {
          events.push('open')
          ws.close()
        }
        ws.onerror = () => events.push('error')
        ws.onclose = (e) => {
          events.push(`close ${e.code}`)
          resolve({ events })
        }
        setTimeout(() => resolve({ events, timeout: true }), 5000)
      }),
    `ws://127.0.0.1:${port}/`,
  )
  await context.close()
  return { ...result, console: consoleLines }
}

test('an https page dialing ws://127.0.0.1 — Chromium and WebKit', async () => {
  test.skip(!process.env.STAVE_OBSERVE_BRIDGE, 'manual observation — set STAVE_OBSERVE_BRIDGE=1')
  test.setTimeout(120_000)

  const mcp = await startStaveMcp({ origins: `${HOSTED},${DEV},${PUBLIC}` })
  try {
    const report: Record<string, unknown> = {}

    const cr = await chromium.launch()
    report.chromiumVersion = cr.version()
    report.chromiumDev = await dialFrom(cr, DEV, mcp.port)
    report.chromium = await dialFrom(cr, HOSTED, mcp.port)
    for (const name of ['local-network-access', 'loopback-network']) {
      try {
        report[`chromium+${name}`] = await dialFrom(cr, HOSTED, mcp.port, { grant: [name] })
      } catch (err) {
        report[`chromium+${name}`] = `cannot grant: ${(err as Error).message.split('\n')[0]}`
      }
    }
    await cr.close()

    try {
      const chrome = await chromium.launch({ channel: 'chrome' })
      report.chromeVersion = chrome.version()
      // Headless, the permission prompt cannot be answered, which reads as "denied".
      report.chrome = await dialFrom(chrome, PUBLIC, mcp.port, { intercept: false })
      report['chrome+local-network-access'] = await dialFrom(chrome, PUBLIC, mcp.port, {
        intercept: false,
        grant: ['local-network-access'],
      })
      await chrome.close()
    } catch (err) {
      report.chrome = `not measured: ${(err as Error).message.split('\n')[0]}`
    }

    const wk = await webkit.launch()
    report.webkitVersion = wk.version()
    report.webkitDev = await dialFrom(wk, DEV, mcp.port)
    report.webkit = await dialFrom(wk, HOSTED, mcp.port)
    await wk.close()

    console.log(JSON.stringify(report, null, 2))

    // WebKit refuses ws:// to loopback from https as mixed content: it never opens.
    expect((report.webkit as Probe).events).not.toContain('open')
    // From the local dev build (http) both engines connect.
    expect((report.webkitDev as Probe).events).toContain('open')
    expect((report.chromiumDev as Probe).events).toContain('open')
    // Real Chrome: refused until the page holds the local-network permission, then open.
    if (typeof report.chrome === 'object') {
      expect((report.chrome as Probe).events).not.toContain('open')
      expect((report.chrome as Probe).console.join('\n')).toContain('ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS')
      expect((report['chrome+local-network-access'] as Probe).events).toContain('open')
    }
  } finally {
    await mcp.close()
  }
})
