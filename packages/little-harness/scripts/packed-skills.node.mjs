import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { preparePackageSkill } from '../../littledb-client/scripts/prepare-package-skill.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const names = ['little-harness', 'little-workflow'];

function files(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === '.DS_Store') return [];
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    assert(!entry.isSymbolicLink(), `skill source must be a regular file or directory: ${path}`);
    return entry.isDirectory() ? files(join(directory, entry.name), path) : [path];
  }).sort();
}

function pack(directory, destination) {
  // Generation is exercised explicitly; full prepack builds are a
  // separate release gate. Keep these tarball regressions dependency-free and
  // runnable unchanged in the public export, including temporary broken fixtures.
  const result = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', destination], {
    cwd: directory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, npm_config_update_notifier: 'false' },
  }));
  assert.equal(result.length, 1);
  return { files: new Set(result[0].files.map(file => file.path)), tarball: join(destination, result[0].filename) };
}

function assertPackedSkill(directory, source, name) {
  const destination = mkdtempSync(join(tmpdir(), 'packed-skill-tarball-'));
  try {
    const { files: packed, tarball } = pack(directory, destination);
    const readPacked = path => execFileSync('tar', ['-xOf', tarball, `package/${path}`]);
    const prefix = `skills/${name}/`;
    const expected = files(source);
    assert(expected.includes('SKILL.md'));
    for (const path of expected) {
      assert(packed.has(prefix + path), `missing packed skill file: ${prefix + path}`);
      assert.deepEqual(readPacked(prefix + path), readFileSync(join(source, path)),
        `packed skill bytes differ: ${prefix + path}`);
    }
    assert.deepEqual([...packed].filter(path => path.startsWith(prefix)).sort(),
      expected.map(path => prefix + path), 'packed skill must contain exactly the root source files');
    const pkg = JSON.parse(readPacked('package.json').toString('utf8'));
    const skill = readPacked(prefix + 'SKILL.md').toString('utf8');
    assert.deepEqual([...skill.matchAll(/^This release: `([^`]+)`/gm)].map(match => match[1]),
      [`${pkg.name}@${pkg.version}`], 'packed skill release marker must match the package version');
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
}

for (const name of names) {
  test(`${name}: real npm pack list includes byte-identical, version-matched skill`, () => {
    const directory = join(repo, 'packages', name);
    execFileSync(process.execPath, [join(repo, 'packages/littledb-client/scripts/prepare-package-skill.mjs'), name]);
    assertPackedSkill(directory, join(repo, 'skills', name), name);
  });

  for (const corruption of ['missing file', 'different bytes', 'wrong release version']) {
    test(`${name}: pack assertion rejects ${corruption} in a temporary fixture`, () => {
      const directory = mkdtempSync(join(tmpdir(), 'packed-skill-proof-'));
      try {
        const source = join(repo, 'skills', name);
        const manifest = JSON.parse(readFileSync(join(repo, 'packages', name, 'package.json'), 'utf8'));
        writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest));
        mkdirSync(join(directory, 'skills'), { recursive: true });
        cpSync(source, join(directory, 'skills', name), { recursive: true });
        // Prove the same assertion accepts the untouched fixture before corrupting it.
        assertPackedSkill(directory, source, name);
        const path = files(source).find(path => path !== 'SKILL.md');
        assert(path, 'fixture must include a reference or agent file');
        let message;
        if (corruption === 'missing file') {
          rmSync(join(directory, 'skills', name, path));
          message = /missing packed skill file/;
        } else if (corruption === 'different bytes') {
          writeFileSync(join(directory, 'skills', name, path), 'deliberately different bytes\n');
          message = /packed skill bytes differ/;
        } else {
          // Leave source/copy bytes identical: only the declared package version
          // differs, so this must fail the release assertion rather than the byte check.
          manifest.version = '0.0.0-packed-skill-negative-proof';
          writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest));
          message = /packed skill release marker must match the package version/;
        }
        assert.throws(() => assertPackedSkill(directory, source, name), message);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
}

test('package skill generation ignores only .DS_Store, including nested folders', () => {
  const root = mkdtempSync(join(tmpdir(), 'packed-skill-finder-'));
  try {
    const name = 'little-harness';
    const source = join(root, 'skills', name);
    mkdirSync(join(source, 'references'), { recursive: true });
    writeFileSync(join(source, 'SKILL.md'), 'skill');
    writeFileSync(join(source, '.DS_Store'), 'Finder');
    writeFileSync(join(source, 'references', '.DS_Store'), 'Finder');
    writeFileSync(join(source, 'references', '.keep'), 'retained');
    preparePackageSkill(name, root);
    assert.deepEqual(files(source), ['SKILL.md', 'references/.keep']);
    const destination = join(root, 'packages', name, 'skills', name);
    assert.deepEqual(readdirSync(destination).sort(), ['SKILL.md', 'references']);
    assert.deepEqual(readdirSync(join(destination, 'references')), ['.keep']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
