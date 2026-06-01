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
    /** How the plugin obtains the bearer token. Optional — defaults to
     *  `{ type: 'bearer', tokenEnv: 'MARGO_TOKEN' }`. Only set when the
     *  developer wants to override the env var name (e.g. a consultant
     *  juggling tokens for two different hosts). */
    auth?: {
      type?: 'bearer'
      /** Name of the env var that holds the token at plugin boot. The
       *  token itself is NEVER written to the committed file. */
      tokenEnv?: string
    }
  }
  // ─── No repoBinding here ──────────────────────────────────────────
  //
  // The plugin auto-derives a repo anchor at runtime from
  // `git remote get-url origin` and sends it to the host on first
  // connect (first-bind-wins). The host warns the overlay on mismatch.
  //
  // Workspaces without a git remote (prototype dirs, local-only repos)
  // skip the binding entirely — there's no team to protect from typo'd
  // configs. Adding a git remote is the documented path to enable
  // binding protection on a previously-bare repo.
}

/** Type-safe authoring helper for margo.config.ts. Returns the input
 *  verbatim — the helper only exists so TypeScript can attach autocomplete
 *  and IntelliSense to user-authored config files. */
export function defineConfig(config: MargoClientConfig): MargoClientConfig {
  return config
}
