import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const softLimit = 800;
const hardLimit = 1000;
const outputDirectories = new Set([
  'node_modules', 'vendor', 'dist', 'coverage', '.git', '__pycache__',
]);
const contentExtensions = new Set([
  '.md', '.txt', '.rst', '.csv', '.tsv', '.jsonl', '.pdf', '.svg',
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.woff', '.woff2',
]);
const lockfiles = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']);

export function countLines(bytes) {
  let lines = 0;
  for (const byte of bytes) if (byte === 10) lines++;
  return lines + Number(bytes.length > 0 && bytes.at(-1) !== 10);
}

export function isCode(path) {
  const parts = path.split('/');
  const name = basename(path);
  if (parts.some(part => outputDirectories.has(part)) || lockfiles.has(name)) return false;
  if (contentExtensions.has(extname(name).toLowerCase())) return false;
  if (['LICENSE', '.env.example', '.gitattributes', '.gitignore'].includes(name)) return false;
  // JSON payloads are data; package/build configuration in those same trees stays code.
  if (extname(name) === '.json' && !/^(package|tsconfig(?:\.[^.]+)?)\.json$/.test(name)
      && parts.slice(0, -1).some(part => ['fixtures', 'testdata', 'data'].includes(part))) return false;
  // Unknown text formats stay covered until their content classification is reviewed.
  return true;
}

export function check(root) {
  const paths = execFileSync('git', ['-C', root, 'ls-files', '--cached', '--others',
    '--exclude-standard', '-z'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  let errors = 0;
  let checked = 0;
  for (const path of [...new Set(paths.split('\0').filter(Boolean))].sort()) {
    if (!isCode(path)) continue;
    const absolute = resolve(root, path);
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch (error) {
      if (error.code === 'ENOENT') continue; // A locally deleted tracked file has no code to check.
      throw error;
    }
    // Never follow a link into private data or outside the repository.
    if (!stat.isFile()) continue;
    const bytes = readFileSync(absolute);
    if (bytes.includes(0)) continue;
    checked++;
    const lines = countLines(bytes);
    if (lines > hardLimit) {
      console.error(`ERROR ${JSON.stringify(path)}: ${lines} lines exceeds hard limit ${hardLimit}`);
      errors++;
    } else if (lines > softLimit) {
      console.warn(`WARN ${JSON.stringify(path)}: ${lines} lines exceeds soft limit ${softLimit} (passes)`);
    }
  }
  console.log(`LOC: checked ${checked} code files; target <=500, warn >${softLimit}, error >${hardLimit}`);
  return errors ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = check(resolve(process.argv[2] || '.'));
  } catch (error) {
    console.error(`LOC check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
