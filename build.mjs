import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

const result = await esbuild.build({
  absWorkingDir: root,
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  packages: 'external',
  sourcemap: true,
  legalComments: 'eof',
  logLevel: 'warning',
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const bytes = Buffer.byteLength(result.outputFiles?.[0]?.text ?? '');
  console.log(`lib/index.js  ${(bytes / 1024).toFixed(1)} KiB`);
}
