import * as esbuild from 'esbuild';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

const result = await esbuild.build({
  absWorkingDir: root,
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  packages: 'external',
  sourcemap: true,
  legalComments: 'eof',
  logLevel: 'warning',
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // esbuild writes the bundle to disk (write defaults to true), so
  // outputFiles is empty — measure the written artifact instead.
  const { statSync } = await import('node:fs');
  const bytes = statSync(join(root, 'lib/index.js')).size;
  console.log(`lib/index.js  ${(bytes / 1024).toFixed(1)} KiB`);
}
