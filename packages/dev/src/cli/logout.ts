// `npx margo logout [host]` — remove saved credentials. With a host,
// drops that one entry from ~/.margo/credentials.json. Without, clears
// every entry (e.g. before handing the laptop off / rotating all
// credentials at once).
//
// Logout is intentionally local-only: we don't notify the host that the
// token is no longer wanted. To actually revoke server-side, the user
// has to revoke the token from the dashboard or via `margo-host
// revoke-token`. That's a deliberate split — local cleanup doesn't need
// network access, and server-side revocation is the security primitive.

import { credentialsFilePath, removeCredentials } from '../auth/credentials-store.js'

export interface LogoutOptions {
  /** Host base URL to log out of. Omit to clear every saved credential. */
  host?: string
}

export async function logout(opts: LogoutOptions): Promise<void> {
  if (opts.host && !/^https?:\/\//i.test(opts.host)) {
    console.error('[margo logout] usage: margo logout [<host-url>]')
    console.error('               e.g.  margo logout http://localhost:7331')
    console.error('               or    margo logout    (clears all)')
    process.exit(1)
  }
  const removed = await removeCredentials(opts.host)
  const file = await credentialsFilePath()
  if (removed === 0) {
    if (opts.host) {
      console.log(`[margo logout] no saved credentials for ${opts.host}.`)
    } else {
      console.log(`[margo logout] no saved credentials.`)
    }
    return
  }
  if (opts.host) {
    console.log(`[margo logout] removed credentials for ${opts.host}.`)
  } else {
    console.log(`[margo logout] removed ${removed} credential${removed === 1 ? '' : 's'}.`)
  }
  console.log(`               (${file})`)
  console.log('')
  console.log('Note: the bearer token is still valid on the host. To revoke it')
  console.log('there, sign in to the host dashboard and remove it under "Tokens",')
  console.log('or run `margo-host revoke-token --token-id <id>` from a host shell.')
}
