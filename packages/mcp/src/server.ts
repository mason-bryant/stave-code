import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import type { BridgeLike } from './bridge'
import { registerStaveTools, type ToolContext } from './tools'
import pkg from '../package.json'

export const SERVER_NAME = 'stave'
export const SERVER_VERSION: string = pkg.version

const INSTRUCTIONS = [
  'These tools read and change the songs and visuals in the Stave tab the user has paired (Stave is a browser live-coding studio: Strudel patterns, Hydra/p5/GLSL visuals).',
  'Changes go into the user’s open project immediately: a playing song is re-evaluated, a visual on screen redraws, and every change is recorded in Stave’s History panel so the user can roll it back.',
  'Read a file before changing it, prefer edit_file for small changes, and check the diagnostics in each write result. If a tool says no tab is connected, call stave_status and give the user its pairing steps.',
].join(' ')

export function createStaveMcpServer(bridge: BridgeLike, ctx: ToolContext): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS })
  registerStaveTools(server, bridge, ctx)
  return server
}
