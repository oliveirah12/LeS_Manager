import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';

const keyFormat = /^[0-9a-f]{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The internal name never comes from the person. Two levels keep folders small. */
export function newStorageKey() {
  const id = randomUUID();
  return id.slice(0, 2) + '/' + id;
}

/** There is no default: a folder inside the release would be erased by the next update. */
export function storageRoot() {
  const folder = process.env.FILE_STORAGE_DIR?.trim();
  if (!folder) throw new ServiceUnavailableException('O armazenamento de arquivos não está configurado.');
  return resolve(folder);
}

/** Inside the root so that moving a finished upload is an atomic rename on the same disk. */
export const temporaryFolder = () => join(storageRoot(), '.tmp');

/** Where file contents live. The rest of the system only knows these operations. */
export abstract class FileStorage {
  abstract inspect(temporaryPath: string): Promise<{ sha256: string; head: Buffer }>;
  abstract save(temporaryPath: string, key: string): Promise<void>;
  abstract open(key: string): Promise<Readable | null>;
  abstract remove(key: string): Promise<void>;
  abstract discard(temporaryPath: string): Promise<void>;
  abstract removeTemporaries(olderThanMs: number): Promise<void>;
}

@Injectable()
export class DiskFileStorage extends FileStorage {
  private path(key: string) {
    if (!keyFormat.test(key)) throw new Error('Chave de arquivo inválida.');
    return join(storageRoot(), key);
  }

  async inspect(temporaryPath: string) {
    const hash = createHash('sha256');
    let head = Buffer.alloc(0);
    for await (const chunk of createReadStream(temporaryPath)) {
      hash.update(chunk as Buffer);
      // Enough to pass a byte order mark and blank lines before the first XML tag.
      if (head.length < 64) head = Buffer.concat([head, chunk as Buffer]).subarray(0, 64);
    }
    return { sha256: hash.digest('hex'), head };
  }

  async save(temporaryPath: string, key: string) {
    const target = this.path(key);
    await mkdir(dirname(target), { recursive: true });
    await rename(temporaryPath, target);
  }

  async open(key: string) {
    const path = this.path(key);
    try {
      if (!(await stat(path)).isFile()) return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    return createReadStream(path);
  }

  remove(key: string) { return rm(this.path(key), { force: true }); }

  /** Only accepts files directly inside the temporary folder. */
  async discard(temporaryPath: string) {
    const folder = temporaryFolder();
    if (dirname(resolve(temporaryPath)) === folder) await rm(temporaryPath, { force: true });
  }

  async removeTemporaries(olderThanMs: number) {
    const folder = temporaryFolder();
    const limit = Date.now() - olderThanMs;
    const names = await readdir(folder).catch(() => [] as string[]);
    for (const name of names) {
      const path = join(folder, name);
      const info = await stat(path).catch(() => null);
      if (info?.isFile() && info.mtimeMs < limit) await rm(path, { force: true });
    }
  }
}
