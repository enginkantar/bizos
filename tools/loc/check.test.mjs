import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { countLines, isCode } from './check.mjs';

const checker = fileURLToPath(new URL('./check.mjs', import.meta.url));

function repository(t) {
  const root = mkdtempSync(join(tmpdir(), 'bizos-loc-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  return {
    root,
    write(path, text) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    },
    run() {
      const result = spawnSync(process.execPath, [checker, root], { encoding: 'utf8' });
      assert.ifError(result.error);
      return { status: result.status, output: result.stdout + result.stderr };
    },
  };
}

for (const newline of ['\n', '\r\n']) {
  for (const terminated of [false, true]) {
    for (const lines of [800, 801, 1000, 1001]) {
      test(`${lines} lines, ${JSON.stringify(newline)}, terminated=${terminated}`, t => {
        const repo = repository(t);
        const text = Array.from({ length: lines }, (_, i) => i % 2 || i === lines - 1 ? '// comment' : '')
          .join(newline) + (terminated ? newline : '');
        assert.equal(countLines(Buffer.from(text)), lines);
        repo.write('new code.js', text);
        const result = repo.run();
        assert.equal(result.status, lines > 1000 ? 1 : 0, result.output);
        assert.equal(result.output.includes('WARN '), lines > 800 && lines <= 1000);
        assert.equal(result.output.includes('ERROR '), lines > 1000);
        if (lines > 800) assert.ok(result.output.includes('"new code.js"'));
      });
    }
  }
}

test('empty files, one line and trailing newlines have no phantom line', () => {
  for (const [text, lines] of [['', 0], ['one', 1], ['one\n', 1], ['one\r\n', 1], ['\n\n', 2]]) {
    assert.equal(countLines(Buffer.from(text)), lines);
  }
});

test('code classification includes tests, generators, HTML/CSS and config in content trees', t => {
  const repo = repository(t);
  const paths = ['server/test/new.ts', 'tools/claimcheck/claimcheck.py',
    'templates/generator.js', 'fixtures/gen.py', 'testdata/gen.go', 'fixtures/fixture.gen.ts', 'data/build.sh', 'build/build.mjs',
    'web/index.html', 'web/src/style.css', '.github/workflows/checks.yml',
    'package.json', 'tsconfig.json', 'claims.ini', 'fixtures/package.json', 'new-format.conf'];
  for (const path of paths) {
    assert.equal(isCode(path), true, path);
    repo.write(path, '// code\n'.repeat(1001));
  }
  const result = repo.run();
  assert.equal(result.status, 1);
  assert.equal((result.output.match(/ERROR /g) || []).length, paths.length);
  for (const path of paths) assert.ok(result.output.includes(JSON.stringify(path)), path);
});

test('only content, payloads and explicit generated/dependency/output paths are exempt', t => {
  const repo = repository(t);
  for (const path of ['docs/long.md', 'templates/office.rules.md', 'notes.txt', 'data/input.csv',
    'fixtures/payload.json', 'testdata/payload.json', 'data/export.json', 'logo.svg',
    'package-lock.json', 'vendor/third-party.js', 'node_modules/dependency/index.js',
    'dist/app.js', 'coverage/report.js', 'data/export.jsonl']) {
    assert.equal(isCode(path), false, path);
    repo.write(path, 'content\n'.repeat(1001));
  }
  // Even force-tracked dependency/build output is exempt.
  execFileSync('git', ['-C', repo.root, 'add', '.']);
  assert.equal(repo.run().status, 0);
});

test('discovers tracked and untracked files, honors ignores, handles deletions and links', t => {
  const repo = repository(t);
  repo.write('.gitignore', 'ignored/\n');
  repo.write('tracked.ts', 'ok\n');
  execFileSync('git', ['-C', repo.root, 'add', '.']);
  rmSync(join(repo.root, 'tracked.ts'));
  repo.write('ignored/long.js', 'x\n'.repeat(1001));
  repo.write('binary.bin', Buffer.from([0, ...Buffer.from('x\n'.repeat(1001))]));
  symlinkSync(checker, join(repo.root, 'link.js'));
  assert.equal(repo.run().status, 0);
  repo.write('fixtures/new generator.py', '# comment\n'.repeat(1001));
  assert.equal(repo.run().status, 1);
  execFileSync('git', ['-C', repo.root, 'add', 'fixtures/new generator.py']);
  const result = repo.run();
  assert.equal(result.status, 1);
  assert.match(result.output, /fixtures\/new generator.py/);
});

test('CLI fails closed outside a Git repository', t => {
  const root = mkdtempSync(join(tmpdir(), 'bizos-loc-no-git-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [checker, root], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /LOC check failed/);
});
