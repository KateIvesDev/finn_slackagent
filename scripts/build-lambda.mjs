// Bundles the two Lambda handlers into self-contained ESM files (no
// node_modules needed in the zip) and zips each into infra/build/, which
// Terraform's aws_lambda_function points at via a source_code_hash so a
// content change triggers a redeploy.
//
// Run with: `npm run build:lambda` (Terraform's null_resource can also shell
// out to this directly before an apply — see infra/lambda.tf).
import { build } from 'esbuild';
import { mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outRoot = path.join(root, 'infra', 'build');

const targets = [
  { name: 'receiver', entry: 'src/lambda/receiver.ts' },
  { name: 'worker', entry: 'src/lambda/worker.ts' },
  // The Zendesk MCP server (hand-rolled JSON-RPC), behind its own Function URL.
  { name: 'zendesk-mcp', entry: 'src/lambda/zendeskMcp.ts' },
];

rmSync(outRoot, { recursive: true, force: true });
mkdirSync(outRoot, { recursive: true });

for (const { name, entry } of targets) {
  const stageDir = path.join(outRoot, name);
  mkdirSync(stageDir, { recursive: true });

  await build({
    entryPoints: [path.join(root, entry)],
    outfile: path.join(stageDir, 'index.mjs'),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    // Bundle all deps in (Lambda's zip won't have node_modules) — hackathon
    // scale, so bundle size isn't a concern worth trimming externals for.
    external: [],
    minify: false,
    sourcemap: false,
    logLevel: 'info',
    banner: {
      // esbuild's ESM output assumes `require`/`__dirname` aren't needed, but
      // a couple of transitive deps (e.g. proto-loader-style CJS interop)
      // probe for `require` at load time — this shim keeps that from
      // crashing without pulling in a CJS build.
      js: "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);",
    },
  });

  // Lambda's Node runtime picks ESM vs CJS from the nearest package.json's
  // "type" field (the file is .mjs so it's unambiguous either way, but this
  // keeps `Handler: index.handler` resolving cleanly).
  writeFileSync(path.join(stageDir, 'package.json'), JSON.stringify({ type: 'module' }, null, 2));

  const zipPath = path.join(outRoot, `${name}.zip`);
  // System `zip` keeps this dependency-free; both macOS and Amazon Linux CI
  // runners have it. -X drops extra file attrs for reproducible-ish output.
  execFileSync('zip', ['-X', '-r', zipPath, '.'], { cwd: stageDir, stdio: 'inherit' });

  console.log(`✔ ${name}: ${path.relative(root, zipPath)}`);
}
