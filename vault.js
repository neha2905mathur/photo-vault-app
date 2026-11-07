// Photo Vault - storage on a private GitHub repo (encrypted files only).
// Layout in the repo:
//   vault.json        plain: format, salt, PBKDF2 iterations (salt is not secret)
//   index.enc         encrypted JSON list of items (names, sizes, chunk paths)
//   data/<id>/0000.enc  encrypted chunks of each photo/video (default 20 MB each)
import { deriveKey, encryptBytes, decryptBytes, randBytes, b64, ITER } from './crypto.js';

export const CHUNK = 20 * 1024 * 1024; // 20 MB per file in the repo (limit is 50 MB)
const FORMAT = 'photo-vault-v1';
const enc = new TextEncoder();
const dec = new TextDecoder();

export function friendlyError(status, text) {
  if (status === 401) return 'GitHub token galat hai ya expire ho gaya. Token dobara daalo.';
  if (status === 403) return 'Token ke paas permission nahi hai. Token mein "Contents: Read and write" zaroori hai.';
  if (status === 404) return 'Repo ya file nahi mili. Owner/repo naam check karo.';
  if (status === 409 || status === 422) return 'Save mein conflict aaya. Ek baar phir try karo.';
  if (status >= 500) return 'GitHub abhi jawab nahi de raha. Thodi der baad try karo.';
  return 'GitHub ne error diya: ' + (text || status).slice(0, 160);
}

export class GitHubStore {
  constructor({ api = 'https://api.github.com', owner, repo, token }) {
    this.api = api.replace(/\/$/, '');
    this.owner = owner;
    this.repo = repo;
    this.token = token;
  }
  headers(extra = {}) {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...extra,
    };
  }
  repoUrl() { return `${this.api}/repos/${this.owner}/${this.repo}`; }
  fileUrl(path) {
    return `${this.repoUrl()}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
  }
  async fail(r, what) {
    let text = '';
    try { text = (await r.json()).message || ''; } catch (e) { /* no body */ }
    const err = new Error(friendlyError(r.status, text));
    err.status = r.status;
    err.what = what;
    throw err;
  }
  async repoInfo() {
    const r = await fetch(this.repoUrl(), { headers: this.headers() });
    if (!r.ok) await this.fail(r, 'repo');
    return r.json(); // includes size (KB) and permissions
  }
  // Metadata (sha, size) for a path; null when it does not exist.
  async meta(path) {
    const r = await fetch(this.fileUrl(path), { headers: this.headers() });
    if (r.status === 404) return null;
    if (!r.ok) await this.fail(r, path);
    return r.json();
  }
  // Raw bytes for a path; null when it does not exist. Works for files over 1 MB.
  async bytes(path) {
    const r = await fetch(this.fileUrl(path), {
      headers: this.headers({ Accept: 'application/vnd.github.raw+json' }),
    });
    if (r.status === 404) return null;
    if (!r.ok) await this.fail(r, path);
    return new Uint8Array(await r.arrayBuffer());
  }
  async put(path, data, message, sha) {
    const body = { message, content: b64.encode(data) };
    if (sha) body.sha = sha;
    const r = await fetch(this.fileUrl(path), {
      method: 'PUT',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    if (!r.ok) await this.fail(r, path);
    return (await r.json()).content.sha;
  }
  async remove(path, sha, message) {
    const r = await fetch(this.fileUrl(path), {
      method: 'DELETE',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ message, sha }),
    });
    if (!r.ok && r.status !== 404) await this.fail(r, path);
  }
}

const aadChunk = (id, i) => `${id}:${i}`;

export class Vault {
  constructor(store, { chunkSize = CHUNK } = {}) {
    this.s = store;
    this.chunkSize = chunkSize;
    this.key = null;
    this.index = { v: 1, items: [] };
    this.indexSha = null;
  }

  // Opens an existing vault, or creates a new one when the repo is empty.
  // Returns 'created' or 'opened'. Wrong passphrase throws.
  async open(passphrase, { create = false } = {}) {
    const raw = await this.s.bytes('vault.json');
    if (!raw) {
      if (!create) { const e = new Error('Is repo mein vault abhi bana nahi hai.'); e.code = 'no_vault'; throw e; }
      const salt = randBytes(16);
      this.key = await deriveKey(passphrase, salt, ITER);
      const info = { format: FORMAT, iter: ITER, salt: b64.encode(salt), created: new Date().toISOString() };
      await this.s.put('vault.json', enc.encode(JSON.stringify(info, null, 1)), 'vault setup');
      this.index = { v: 1, items: [] };
      await this.saveIndex('index setup');
      return 'created';
    }
    const info = JSON.parse(dec.decode(raw));
    if (info.format !== FORMAT) throw new Error('Vault ka format samajh nahi aaya.');
    this.key = await deriveKey(passphrase, b64.decode(info.salt), info.iter || ITER);
    const m = await this.s.meta('index.enc');
    if (!m) {
      this.index = { v: 1, items: [] };
      this.indexSha = null;
      return 'opened';
    }
    this.indexSha = m.sha;
    const blob = await this.s.bytes('index.enc');
    try {
      const plain = await decryptBytes(this.key, blob, 'index');
      this.index = JSON.parse(dec.decode(plain));
    } catch (e) {
      this.key = null;
      throw new Error('Passphrase galat hai. Dobara try karo.');
    }
    return 'opened';
  }

  lock() {
    this.key = null;
    this.index = { v: 1, items: [] };
    this.indexSha = null;
  }

  async saveIndex(message) {
    const blob = await encryptBytes(this.key, enc.encode(JSON.stringify(this.index)), 'index');
    // Re-read sha right before writing so a stale copy cannot overwrite newer work.
    const m = await this.s.meta('index.enc');
    this.indexSha = await this.s.put('index.enc', blob, message, m ? m.sha : undefined);
  }

  // Encrypts and uploads one file in chunks; the index is updated last (commit point).
  async upload(file, onProgress) {
    const id = Array.from(randBytes(8), (b) => b.toString(16).padStart(2, '0')).join('');
    const n = Math.max(1, Math.ceil(file.size / this.chunkSize));
    const chunks = [];
    for (let i = 0; i < n; i++) {
      const start = i * this.chunkSize;
      const part = new Uint8Array(await file.slice(start, Math.min(file.size, start + this.chunkSize)).arrayBuffer());
      const blob = await encryptBytes(this.key, part, aadChunk(id, i));
      const path = `data/${id}/${String(i).padStart(4, '0')}.enc`;
      await this.s.put(path, blob, 'add chunk');
      chunks.push({ path, plain: part.length, enc: blob.length });
      if (onProgress) onProgress(i + 1, n);
    }
    const item = {
      id,
      name: file.name || 'photo',
      mime: file.type || 'application/octet-stream',
      size: file.size,
      added: new Date().toISOString(),
      chunks,
    };
    this.index.items.push(item);
    await this.saveIndex('index update');
    return item;
  }

  async download(item) {
    const parts = [];
    for (let i = 0; i < item.chunks.length; i++) {
      const c = item.chunks[i];
      const blob = await this.s.bytes(c.path);
      if (!blob) throw new Error('Ek hissa (chunk) GitHub par nahi mila: ' + c.path);
      parts.push(await decryptBytes(this.key, blob, aadChunk(item.id, i)));
    }
    return new Blob(parts, { type: item.mime });
  }

  // Removes from the index first (so the item disappears even if a file delete fails),
  // then removes its chunk files.
  async remove(item) {
    this.index.items = this.index.items.filter((x) => x.id !== item.id);
    await this.saveIndex('index update');
    for (const c of item.chunks) {
      const m = await this.s.meta(c.path);
      if (m) await this.s.remove(c.path, m.sha, 'remove chunk');
    }
  }

  usage() {
    let plain = 0, encBytes = 0;
    for (const it of this.index.items) {
      plain += it.size;
      for (const c of it.chunks) encBytes += c.enc;
    }
    return { count: this.index.items.length, plain, encBytes };
  }
}
