#!/usr/bin/env node
// Root skills are the only source; package-local skills are disposable prepack output.
import { cpSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../../', import.meta.url));

export function preparePackageSkill(name, root = repository) {
  if (!['little-harness', 'little-workflow'].includes(name)) {
    throw new Error('Expected little-harness or little-workflow.');
  }
  const source = join(root, 'skills', name);
  const destination = join(root, 'packages', name, 'skills');
  // Refuse symlinks and special files rather than following them into a release.
  function validate(path) {
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) if (entry !== '.DS_Store') validate(join(path, entry));
    } else if (!stat.isFile()) {
      throw new Error('Package skill sources must contain only regular files and directories.');
    }
  }
  validate(source);
  // Clear stale generated files so a removed source cannot survive into the tarball.
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  cpSync(source, join(destination, name), { recursive: true, dereference: false, filter: path => basename(path) !== '.DS_Store' });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Usage: prepare-package-skill.mjs little-harness|little-workflow');
  preparePackageSkill(process.argv[2]);
}
