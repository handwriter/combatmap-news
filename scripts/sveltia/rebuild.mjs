// Rebuild the checked-in CMS; ordinary site builds only copy admin/vendor.
import { mkdtemp, readFile, writeFile, readdir, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const commit = '61d1f407d93d2c786d493c1a53a2a8c9fb7aa663';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
if (Number(process.versions.node.split('.')[0]) < 24) throw Error('Для пересборки CMS нужен Node.js 24 или новее. Сборка сайта по-прежнему поддерживает Node.js 20.');
const manager = process.env.COMBATMAP_PNPM || 'pnpm';
const version = (await exec(manager, ['--version'])).stdout.trim();
if (version !== '11.25.0') throw Error('Для воспроизводимой сборки используйте pnpm 11.25.0.');
const dir = await mkdtemp(path.join(tmpdir(), 'combatmap-sveltia-'));
try {
  const response = await fetch(`https://api.github.com/repos/sveltia/sveltia-cms/tarball/${commit}`);
  if (!response.ok) throw Error(`Не удалось загрузить исходники CMS: HTTP ${response.status}`);
  await writeFile(path.join(dir, 'source.tar.gz'), new Uint8Array(await response.arrayBuffer()));
  await exec('tar', ['-xzf', 'source.tar.gz', '--strip-components=1'], { cwd: dir });
  const patch = path.join(root, 'scripts/sveltia/combatmap.patch');
  await exec('git', ['apply', '--check', patch], { cwd: dir });
  await exec('git', ['apply', patch], { cwd: dir });
  await exec(manager, ['install', '--frozen-lockfile', '--ignore-scripts'], { cwd: dir, maxBuffer: 4 * 1024 * 1024 });
  await exec(manager, ['run', 'build'], { cwd: dir, maxBuffer: 4 * 1024 * 1024 });
  const target = path.join(root, 'admin/vendor/sveltia');
  // Prepare all bytes before replacing the checked-in distribution.
  const files = new Map([['LICENSE.txt', await readFile(path.join(dir, 'LICENSE.txt'))]]);
  for (const name of ['sveltia-cms.mjs', ...(await readdir(path.join(dir, 'package/dist/chunks'))).filter(n => n.endsWith('.js')).map(n => `chunks/${n}`)]) {
    const text = (await readFile(path.join(dir, 'package/dist', name), 'utf8')).replace(/\n\/\/# sourceMappingURL=.*\s*$/, '\n');
    files.set(name, Buffer.from(text));
  }
  await rm(target, { recursive: true, force: true });
  for (const [name, bytes] of files) {
    await mkdir(path.dirname(path.join(target, name)), { recursive: true });
    await writeFile(path.join(target, name), bytes);
  }
  await writeFile(path.join(target, 'build.json'), JSON.stringify({ version: '0.233.1', sourceCommit: commit, patchSha256: digest(await readFile(patch)), files: Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b)).map(([name, bytes]) => [name, digest(bytes)])) }, null, 2) + '\n');
  console.log('Sveltia CMS 0.233.1 rebuilt with the Combat Map history extension.');
} finally {
  await rm(dir, { recursive: true, force: true });
}
