// Picks the right Transport implementation based on margo.config. Used
// by all three plugin entry points (Vite, Next, CLI sidecar) so the
// "local vs server" decision lives in exactly one place.

import { loadMargoConfig } from '../config/load.js'
import type { MargoClientConfig } from '../config/types.js'
import { LocalTransport } from './local-transport.js'
import { RemoteTransport } from './remote-transport.js'
import type { Transport } from './transport.js'
import type { MargoConfig } from '../shared/types.js'

export interface CreateTransportOptions {
  rootDir: string
  commentsDir: string
  config: MargoConfig
}

export interface CreateTransportResult {
  transport: Transport
  /** Which backend was selected. Surfaced so plugins can log it on boot
   *  and so future ops dashboards can tell at a glance. */
  mode: 'local' | 'server'
  /** Path to the loaded margo.config, or null if none was found. */
  configPath: string | null
}

/**
 * Construct a Transport for the given workspace. Reads margo.config.* from
 * rootDir; absent/local → LocalTransport, server → RemoteTransport. Throws
 * with a clear error if server mode is selected but its config is invalid
 * or the bearer token env var is missing — better to fail loudly at boot
 * than silently fall back to local and create files in a repo that's been
 * configured to keep them out.
 */
export async function createTransport(
  opts: CreateTransportOptions,
): Promise<CreateTransportResult> {
  const loaded = await loadMargoConfig(opts.rootDir)
  const clientCfg = loaded?.config ?? {}
  const mode: 'local' | 'server' = clientCfg.storage === 'server' ? 'server' : 'local'

  if (mode === 'server') {
    return {
      transport: createRemote(clientCfg),
      mode: 'server',
      configPath: loaded?.path ?? null,
    }
  }
  return {
    transport: new LocalTransport({
      rootDir: opts.rootDir,
      commentsDir: opts.commentsDir,
      config: opts.config,
    }),
    mode: 'local',
    configPath: loaded?.path ?? null,
  }
}

function createRemote(cfg: MargoClientConfig): RemoteTransport {
  const s = cfg.server
  if (!s) throw new Error("[margo] storage: 'server' requires a `server: {...}` block in margo.config")
  if (!s.url) throw new Error('[margo] server.url is required')
  if (!s.project) throw new Error('[margo] server.project is required')
  if (s.auth?.type !== 'bearer') throw new Error('[margo] only auth.type "bearer" is supported in this version')
  const tokenEnv = s.auth.tokenEnv
  if (!tokenEnv) throw new Error('[margo] server.auth.tokenEnv is required')
  const token = process.env[tokenEnv]
  if (!token) {
    throw new Error(
      `[margo] env var ${tokenEnv} is empty — set it before starting the dev server, ` +
        `or revert margo.config to storage: 'local'.`,
    )
  }
  return new RemoteTransport({ serverUrl: s.url, project: s.project, token })
}
