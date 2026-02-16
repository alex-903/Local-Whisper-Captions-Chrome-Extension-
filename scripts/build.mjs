import { build } from 'esbuild';
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const srcDir = path.join(rootDir, 'src');
const distDir = path.join(rootDir, 'dist');

const staticFiles = [
  'manifest.json',
  'popup.html',
  'popup.css',
  'offscreen.html',
  'audio-processor.js'
];

async function copyStaticFiles() {
  await Promise.all(
    staticFiles.map(async (fileName) => {
      await copyFile(path.join(srcDir, fileName), path.join(distDir, fileName));
    })
  );
}

async function copyOrtWasm() {
  const candidates = [
    path.join(rootDir, 'node_modules', 'onnxruntime-web', 'dist'),
    path.join(
      rootDir,
      'node_modules',
      '@huggingface',
      'transformers',
      'node_modules',
      'onnxruntime-web',
      'dist'
    ),
    path.join(rootDir, 'node_modules', '@huggingface', 'transformers', 'dist')
  ];
  const target = path.join(distDir, 'ort');

  await mkdir(target, { recursive: true });

  let files = null;
  let sourceDir = null;

  for (const candidate of candidates) {
    try {
      files = await readdir(candidate);
      sourceDir = candidate;
      break;
    } catch {
      // Try next candidate path.
    }
  }

  if (!files || !sourceDir) {
    throw new Error('Unable to locate ONNX runtime assets. Did you run npm install?');
  }

  const wasmFiles = files.filter((name) => /^ort.*\.(wasm|mjs)$/.test(name));
  await Promise.all(
    wasmFiles.map((fileName) =>
      copyFile(path.join(sourceDir, fileName), path.join(target, fileName))
    )
  );
}

async function bundleScripts() {
  await build({
    entryPoints: [
      path.join(srcDir, 'background.js'),
      path.join(srcDir, 'popup.js'),
      path.join(srcDir, 'offscreen.js'),
      path.join(srcDir, 'content.js'),
      path.join(srcDir, 'whisper-worker.js')
    ],
    outdir: distDir,
    bundle: true,
    format: 'esm',
    target: 'chrome121',
    sourcemap: false,
    minify: false,
    logLevel: 'info'
  });
}

async function main() {
  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });

  await copyStaticFiles();
  await bundleScripts();
  await copyOrtWasm();

  console.log(`Built extension into ${distDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
