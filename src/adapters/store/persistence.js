// Where the JSON store's snapshot lives.
//  - file: data/db.json on disk. Right for the Replit workspace (Run button).
//  - replit-object-storage: one object in Replit App Storage. Right for
//    Autoscale deployments, whose disk is wiped whenever an instance stops.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export function filePersistence(path) {
  return {
    name: `file:${path}`,
    async load() {
      try {
        return JSON.parse(await readFile(path, 'utf8'));
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
    },
    async save(state) {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(state, null, 1));
      await rename(tmp, path); // atomic on the same filesystem
    },
  };
}

export async function objectStoragePersistence(key) {
  let Client;
  try {
    ({ Client } = await import('@replit/object-storage'));
  } catch {
    throw new Error('STORE_PERSISTENCE=replit-object-storage needs the @replit/object-storage package');
  }
  const client = new Client();
  return {
    name: `replit-object-storage:${key}`,
    async load() {
      const res = await client.downloadAsText(key);
      if (!res.ok) {
        const msg = String(res.error?.message || res.error || '');
        if (/not.?found|404|no such/i.test(msg)) return null;
        throw new Error(`Object storage read failed: ${msg}`);
      }
      return JSON.parse(res.value);
    },
    async save(state) {
      const res = await client.uploadFromText(key, JSON.stringify(state));
      if (!res.ok) throw new Error(`Object storage write failed: ${res.error?.message || res.error}`);
    },
  };
}
