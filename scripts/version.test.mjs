import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkVersion, setVersion, validVersion } from './version.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'b2b-version-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'VERSION'), '1.0.0\n');
  for (const component of ['client', 'server']) {
    mkdirSync(join(root, component));
    writeFileSync(join(root, component, 'package.json'), JSON.stringify({ name: component, version: '1.0.0', dependencies: { example: '^3.0.0' } }));
    writeFileSync(join(root, component, 'package-lock.json'), JSON.stringify({ version: '1.0.0', packages: { '': { version: '1.0.0' }, 'node_modules/example': { version: '3.0.0' } } }));
  }
  mkdirSync(join(root, 'server/src'));
  writeFileSync(join(root, 'server/src/product-version.json'), '{"version":"1.0.0"}\n');
  return root;
}

test('accepts SemVer including prereleases and build metadata', () => {
  for (const value of ['0.1.0', '2.0.0-dev.0', '2.0.0-rc.1', '2.1.0', '2.1.1+build.001']) assert.equal(validVersion(value), true);
  for (const value of ['v1.0.0', '01.0.0', '1.0', '1.0.0-01', '1.0.0-', '1.0.0+']) assert.equal(validVersion(value), false);
});

test('updates product and package metadata while preserving dependencies', t => {
  const root = fixture(t);
  setVersion(root, '2.0.0-dev.0');
  assert.equal(checkVersion(root), '2.0.0-dev.0');
  assert.equal(JSON.parse(readFileSync(join(root, 'client/package-lock.json'))).packages['node_modules/example'].version, '3.0.0');
  assert.equal(JSON.parse(readFileSync(join(root, 'server/package.json'))).dependencies.example, '^3.0.0');
});

test('detects drift and mismatched Git release tags', t => {
  const root = fixture(t);
  assert.throws(() => checkVersion(root, 'v2.0.0'), /tag/);
  assert.equal(checkVersion(root, 'v1.0.0'), '1.0.0');
  writeFileSync(join(root, 'server/src/product-version.json'), '{"version":"9.0.0"}');
  assert.throws(() => checkVersion(root), /product-version/);
});

test('invalid versions or incomplete metadata fail before writing', t => {
  const root = fixture(t);
  assert.throws(() => setVersion(root, 'v2.0.0'), /Invalid/);
  rmSync(join(root, 'client/package-lock.json'));
  assert.throws(() => setVersion(root, '2.0.0'));
  assert.equal(readFileSync(join(root, 'VERSION'), 'utf8'), '1.0.0\n');
  assert.equal(JSON.parse(readFileSync(join(root, 'server/package.json'))).version, '1.0.0');
});
