/** Validate generated resources before they enter an application package. */
import { readdir, readlink, realpath } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

export async function fileHash(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function inventory(directory) {
  const root = await realpath(directory);
  const result = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const name = path.relative(root, full).split(path.sep).join('/');
      if (entry.isSymbolicLink()) {
        const resolved = await realpath(full);
        if (!resolved.startsWith(root+path.sep)) throw new Error('Resource symlink escapes bundle: '+name);
        result.push({ name, symlink: await readlink(full) });
      } else if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) result.push({ name, sha256: await fileHash(full) });
      else throw new Error('Unsupported resource type: '+name);
    }
  }
  await visit(root);
  return result.sort((a,b) => a.name.localeCompare(b.name));
}

export async function verifyEngineArtifact(directory, receipt) {
  if (!Array.isArray(receipt.artifact_files) || !receipt.artifact_files.length) throw new Error('Missing engine artifact inventory');
  const expected = new Map();
  for (const entry of receipt.artifact_files) {
    if (typeof entry.name !== 'string' || entry.name.includes('\\') || entry.name.startsWith('/')
        || entry.name.split('/').some(part => !part || part === '..' || part === '.') || expected.has(entry.name)) throw new Error('Invalid engine artifact inventory');
    if (entry.name === 'build-receipt.json') throw new Error('Receipt cannot inventory itself');
    expected.set(entry.name, entry);
  }
  const actual = (await inventory(directory)).filter(entry => entry.name !== 'build-receipt.json');
  if (actual.length !== expected.size) throw new Error('Engine artifact file set changed');
  for (const entry of actual) {
    const other = expected.get(entry.name);
    if (!other || other.sha256 !== entry.sha256 || other.symlink !== entry.symlink) throw new Error('Engine artifact changed: '+entry.name);
  }
}

export async function verifyWebAssets(directory) {
  const allowedExtensions = new Set(['.html','.js','.css','.svg','.png','.jpg','.jpeg','.webp','.ico','.woff','.woff2','.ttf','.otf','.avif']);
  for (const entry of await inventory(directory)) {
    if (entry.symlink || (!allowedExtensions.has(path.extname(entry.name)) && entry.name !== 'robots.txt')) throw new Error('Unexpected web asset: '+entry.name);
    if (entry.name.split('/').some(part => part.startsWith('.'))) throw new Error('Hidden web asset: '+entry.name);
  }
}
