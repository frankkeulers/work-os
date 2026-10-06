import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// The server as one ESM file, as `npm run deploy` ships it and `npm run perf` measures it.

export const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Packages kept out of the bundle and installed in the release instead. The Agent SDK joins in M2. */
export const EXTERNALS: string[] = [];

export async function bundleServer(outfile: string, version: string): Promise<{ bytes: number; ms: number }> {
  const t0 = performance.now();
  const result = await build({
    entryPoints: [join(SERVER_DIR, 'src/main.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: 'linked',
    legalComments: 'none',
    external: EXTERNALS,
    define: { 'process.env.WORKOS_BUILD_VERSION': JSON.stringify(version) },
    // Some dependencies are CommonJS and call require(); give the ESM bundle one.
    banner: {
      js: "import { createRequire as __workosRequire } from 'node:module';\nconst require = __workosRequire(import.meta.url);",
    },
    metafile: true,
    logLevel: 'warning',
  });
  const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
  return { bytes, ms: Math.round(performance.now() - t0) };
}
