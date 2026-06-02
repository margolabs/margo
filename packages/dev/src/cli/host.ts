// `npx margo host start` — shortcut for solo onboarding. Prints the
// single Docker command that starts a personal margo-host on
// localhost:7331 with persistence under ~/.margo/hosts/default/data.
//
// We deliberately don't auto-run Docker — the user might not have it
// installed, and silently starting a daemon they didn't expect is
// hostile. The command is short enough to paste; the wrapper exists
// so the solo path is one `npx margo …` instead of "go read the docs."

import * as os from 'node:os'
import * as path from 'node:path'

export interface HostStartOptions {
  /** Port to bind. Defaults to 7331. */
  port?: number
  /** Data dir on host filesystem. Defaults to ~/.margo/hosts/default/data. */
  dataDir?: string
  /** Container name (for `docker stop`/`docker logs`). Defaults to margo-host-local. */
  name?: string
}

export async function hostStart(opts: HostStartOptions = {}): Promise<void> {
  const port = opts.port ?? 7331
  const home = process.env.HOME || os.homedir()
  const dataDir = opts.dataDir ?? path.join(home, '.margo', 'hosts', 'default', 'data')
  const containerName = opts.name ?? 'margo-host-local'

  console.log('')
  console.log('Solo / local margo-host — paste this Docker one-liner:')
  console.log('')
  console.log(`  docker run -d --name ${containerName} \\`)
  console.log(`    -p ${port}:7331 \\`)
  console.log(`    -v ${dataDir}:/data \\`)
  console.log(`    margolabs/margo-host:latest`)
  console.log('')
  console.log(`Then in your app's repo:`)
  console.log('')
  console.log(`  npx margo init --server http://localhost:${port} --project default`)
  console.log(`  npm run dev`)
  console.log('')
  console.log(`Open the app, click "Sign in to margo" in the overlay. The first signup`)
  console.log(`at http://localhost:${port}/setup becomes the superuser.`)
  console.log('')
  console.log(`Manage the host later:`)
  console.log(`  docker logs ${containerName}        # see what it's doing`)
  console.log(`  docker stop ${containerName}        # pause`)
  console.log(`  docker start ${containerName}       # resume`)
  console.log(`  docker rm -f ${containerName}       # delete (data at ${dataDir} stays)`)
  console.log('')
}
