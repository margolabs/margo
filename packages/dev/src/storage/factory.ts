// Picks the right Transport implementation based on margo.config. Used
// by all three plugin entry points (Vite, Next, CLI sidecar) so the
// "local vs server" decision lives in exactly one place.

import { findCredential } from '../auth/credentials-store.js'
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
  /** When true, a server-mode workspace with no resolvable token returns
   *  `{ transport: null, needsAuth: true }` instead of throwing. The dev
   *  plugin sets this so the overlay can offer an in-browser login flow.
   *  CLIs (pull/push/watch) leave it unset — they have no GUI to recover
   *  via, so a missing token is a hard failure. */
  allowMissingAuth?: boolean
}

export interface CreateTransportResult {
  /** Null only when `needsAuth === true`. Otherwise non-null in server
   *  mode (resolved token) or LocalTransport in local mode. */
  transport: Transport | null
  /** Which backend was selected. Surfaced so plugins can log it on boot
   *  and so future ops dashboards can tell at a glance. */
  mode: 'local' | 'server'
  /** Path to the loaded margo.config, or null if none was found. */
  configPath: string | null
  /** Server connection info — populated when `mode === 'server'`. The
   *  bearer token is intentionally omitted; only url + project flow
   *  through to consumers (e.g. surfaced to the overlay UI). */
  serverInfo?: { url: string; project: string }
  /** True iff server mode but no resolvable token AND the caller passed
   *  `allowMissingAuth`. Plugins use this to start in a "sign in to
   *  margo" state and drive the device flow from the overlay. */
  needsAuth?: boolean
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
    const transport = await createRemote(clientCfg, opts.allowMissingAuth === true)
    return {
      transport,
      mode: 'server',
      configPath: loaded?.path ?? null,
      serverInfo: {
        url: clientCfg.server!.url,
        project: clientCfg.server!.project,
      },
      needsAuth: transport === null,
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

async function createRemote(
  cfg: MargoClientConfig,
  allowMissingAuth: boolean,
): Promise<RemoteTransport | null> {
  const s = cfg.server
  if (!s) throw new Error("[margo] storage: 'server' requires a `server: {...}` block in margo.config")
  if (!s.url) throw new Error('[margo] server.url is required')
  if (!s.project) throw new Error('[margo] server.project is required')
  // Defaults applied here so margo.config.json doesn't need to spell out
  // the auth block in the common case. Only `bearer` is supported; if the
  // user spells out something else, fail loudly so they know it's wrong.
  const authType = s.auth?.type ?? 'bearer'
  if (authType !== 'bearer') {
    throw new Error('[margo] only auth.type "bearer" is supported in this version')
  }
  const tokenEnv = s.auth?.tokenEnv ?? 'MARGO_TOKEN'
  const token = await resolveToken(tokenEnv, s.url)
  if (!token) {
    if (allowMissingAuth) {
      // Plugins drop into "needs sign-in" mode. The overlay drives the
      // device-login flow via /__margo/auth/start and re-instantiates the
      // transport after the user authorizes.
      return null
    }
    throw new Error(
      `[margo] no saved credentials for ${s.url} and ${tokenEnv} is unset — ` +
        `run \`npx margo login ${s.url}\` to authorize this device.`,
    )
  }
  return new RemoteTransport({ serverUrl: s.url, project: s.project, token })
}

/** Token-lookup chain shared by the dev plugin (here) and the
 *  margo pull/push/watch CLIs. Order: process.env (for CI / Docker dev
 *  containers / shell-exported tokens) → ~/.margo/credentials.json
 *  (populated by `margo login`). Returns the resolved string, or null
 *  when neither source has one.
 *
 *  Does NOT mutate process.env on a credentials-file hit: that would
 *  outlive a logout (the file gets removed but the env var lingers),
 *  causing the next transport-recreate to keep finding the stale token
 *  and the user appears to "stay signed in" after clicking sign-out. */
export async function resolveToken(
  tokenEnv: string,
  serverUrl: string,
): Promise<string | null> {
  const fromEnv = process.env[tokenEnv]
  if (fromEnv) return fromEnv
  const cred = await findCredential(serverUrl)
  if (cred && cred.token) return cred.token
  return null
}
