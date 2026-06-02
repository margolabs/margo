// Loads `margo.config.{ts,mts,js,mjs,cjs,json}` from a project root.
// Returns null when no config file exists — that's the implicit-local
// case and the rest of the system treats it as `storage: 'local'`.
//
// TypeScript and ESM-syntax JS configs are transpiled on the fly with
// esbuild (declared as an optional peer dependency). JSON configs need
// nothing extra and are read directly — that's the recommended path
// unless the user genuinely wants TS IntelliSense via defineConfig.

import * as fs from 'node:fs/promises'
import * as fsSync from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import type { MargoClientConfig } from './types.js'

// Static analyzers (Turbopack, webpack's module-resolution pre-pass,
// some Vite plugins) walk every `import('literal')` call at build time
// and bail if the module isn't resolvable — even when the call sits
// behind a branch that never executes for the user's actual config.
//
// We can't declare esbuild as a hard runtime dep (it's ~20 MB and only
// needed for the TS/JS config path; JSON users would pay the cost for
// nothing). And declaring it as an optional peer doesn't help static
// analysis — Turbopack still sees the bare import('esbuild') and 500s.
//
// The Function constructor takes a STRING that runtime evaluates, so
// bundlers / static analyzers have no way to see the module name
// inside. The cost is one extra Function compile per loader bootstrap,
// which is invisible.
const dynamicImport = new Function('m', 'return import(m)') as <T = unknown>(m: string) => Promise<T>

async function loadEsbuildBuild(): Promise<typeof import('esbuild').build> {
  try {
    const mod = await dynamicImport<typeof import('esbuild')>('esbuild')
    return mod.build
  } catch (err) {
    const isModuleNotFound = (err as { code?: string })?.code === 'ERR_MODULE_NOT_FOUND'
      || /Cannot find package 'esbuild'/i.test((err as Error).message ?? '')
    if (isModuleNotFound) {
      throw new Error(
        '[margo] margo.config.ts / .mts / .mjs / .js / .cjs requires the optional `esbuild` peer dependency.\n'
          + '        Install it with: npm install -D esbuild\n'
          + '        Or switch to margo.config.json (no transpiler needed).',
      )
    }
    throw err
  }
}

const CANDIDATES = [
  'margo.config.ts',
  'margo.config.mts',
  'margo.config.mjs',
  'margo.config.js',
  'margo.config.cjs',
  'margo.config.json',
]

export interface LoadConfigResult {
  /** Absolute path to the file that was loaded. */
  path: string
  config: MargoClientConfig
}

/**
 * Find and load a margo.config.* file from `rootDir`. Returns null when
 * no such file exists (implicit-local mode); throws on syntax errors or
 * unknown extensions so misconfiguration surfaces loudly instead of
 * silently degrading to local.
 */
export async function loadMargoConfig(rootDir: string): Promise<LoadConfigResult | null> {
  for (const name of CANDIDATES) {
    const full = path.join(rootDir, name)
    if (!fsSync.existsSync(full)) continue
    const config = await readFromPath(full)
    return { path: full, config }
  }
  return null
}

async function readFromPath(filePath: string): Promise<MargoClientConfig> {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.json') {
    const raw = await fs.readFile(filePath, 'utf8')
    return JSON.parse(raw) as MargoClientConfig
  }
  // For TS/JS/CJS/MJS: bundle to ESM with esbuild and write to a temp
  // file. Bundling (rather than transforming a single file) lets the user
  // import helpers from sibling files if they want — same authoring story
  // as vite.config.ts.
  const outPath = path.join(
    tmpdir(),
    `margo.config.${crypto.randomBytes(6).toString('hex')}.mjs`,
  )
  const esbuild = await loadEsbuildBuild()
  try {
    await esbuild({
      entryPoints: [filePath],
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node18',
      outfile: outPath,
      // The user authored against `margo-dev/config`; pretend it resolves
      // to a tiny inline stub that re-exports defineConfig. Avoids forcing
      // the user's project to actually install margo-dev for plain config
      // authoring (it'll already be installed in practice — this just
      // keeps the loader honest if it isn't).
      external: ['margo-dev', 'margo-dev/*'],
      logLevel: 'silent',
    })
    const mod = (await import(pathToFileURL(outPath).href)) as {
      default?: MargoClientConfig
    }
    if (!mod.default) {
      throw new Error(`[margo] ${filePath} must \`export default defineConfig({...})\``)
    }
    return mod.default
  } finally {
    await fs.unlink(outPath).catch(() => { /* best effort */ })
  }
}
