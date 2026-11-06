import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const number = '(0|[1-9][0-9]*)';
const identifier = '(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
const semver = new RegExp(`^${number}\\.${number}\\.${number}(?:-${identifier}(?:\\.${identifier})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);
export const validVersion = value => typeof value === 'string' && semver.test(value);
const json = path => JSON.parse(readFileSync(path, 'utf8'));

function metadata(root) {
  const files = [];
  for (const name of ['client', 'server']) {
    const manifest = join(root, name, 'package.json');
    const lock = join(root, name, 'package-lock.json');
    const packageData = json(manifest), lockData = json(lock);
    if (!lockData.packages?.['']) throw new Error(`Missing lockfile root: ${lock}`);
    files.push({ path: manifest, data: packageData }, { path: lock, data: lockData });
  }
  const path = join(root, 'server/src/product-version.json');
  files.push({ path, data: json(path) });
  return files;
}

export function checkVersion(root, tag) {
  const version = readFileSync(join(root, 'VERSION'), 'utf8').trim();
  if (!validVersion(version)) throw new Error(`Invalid VERSION: ${version}`);
  for (const file of metadata(root)) {
    if (file.data.version !== version || (file.data.packages && file.data.packages[''].version !== version)) {
      throw new Error(`Version mismatch in ${file.path}; run node scripts/version.mjs set ${version}`);
    }
  }
  if (tag && tag !== `v${version}`) throw new Error(`Release tag ${tag} does not match VERSION ${version}`);
  return version;
}

export function setVersion(root, version) {
  if (!validVersion(version)) throw new Error('Invalid version; use SemVer without the v prefix');
  // Read and validate every target before changing any file.
  const files = metadata(root).map(file => {
    file.data.version = version;
    if (file.data.packages) file.data.packages[''].version = version;
    return { path: file.path, content: JSON.stringify(file.data, null, 2) + '\n' };
  });
  files.push({ path: join(root, 'VERSION'), content: version + '\n' });
  const staged = [];
  try {
    for (const file of files) {
      const temporary = `${file.path}.version-${process.pid}.tmp`;
      writeFileSync(temporary, file.content, { flag: 'wx' });
      staged.push({ ...file, temporary });
    }
    for (const file of staged) renameSync(file.temporary, file.path);
  } finally {
    for (const file of staged) { try { unlinkSync(file.temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }
  return checkVersion(root);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const [command = 'check', value, tagValue] = process.argv.slice(2);
  try {
    if (command === 'set' && value && !tagValue) console.log(`Product version: ${setVersion(root, value)}`);
    else if (command === 'check' && (!value || (value === '--tag' && tagValue))) console.log(`Product version: ${checkVersion(root, tagValue)}`);
    else throw new Error('Usage: node scripts/version.mjs check [--tag vX.Y.Z] | set X.Y.Z');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
