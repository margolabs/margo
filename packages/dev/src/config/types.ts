// Schema for `margo.config.{ts,js,mjs,json}` — committed to the repo,
// picks how the dev plugin stores comments. Default `storage: 'local'`
// means existing users see no change. `storage: 'server'` opts in to the
// remote host backend; the bearer token lives in an env var (never the
// committed file).

export type StorageMode = 'local' | 'server'

export interface MargoClientConfig {
  /** `local` (default) — comments as files in this repo, committed via git.
   *  `server` — comments live on a margo host, this repo stays clean. */
  storage?: StorageMode
  /** Server-mode connection details. Required when storage === 'server'. */
  server?: {
    /** Host base URL, e.g. https://margo.acme.com or http://localhost:7331. */
    url: string
    /** Project id on the host. */
    project: string
    /** How the plugin obtains the bearer token. */
    auth: {
      type: 'bearer'
      /** Name of the env var that holds the token at plugin boot. The
       *  token itself is NEVER written to the committed file. */
      tokenEnv: string
    }
  }
}

/** Type-safe authoring helper for margo.config.ts. Returns the input
 *  verbatim — the helper only exists so TypeScript can attach autocomplete
 *  and IntelliSense to user-authored config files. */
export function defineConfig(config: MargoClientConfig): MargoClientConfig {
  return config
}
