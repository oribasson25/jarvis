import { Redis } from '@upstash/redis';
import { logger } from './logger.js';

let client;

const restUrl = () => process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const restToken = () => process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

export const hasPersistentStore = () => !!(restUrl() && restToken());

/**
 * Upstash Redis when configured (Vercel → Storage → Upstash sets the env vars), otherwise an
 * in-memory stand-in for local development and tests. Values are always plain strings.
 */
export function redis() {
  if (client) return client;
  if (hasPersistentStore()) {
    client = new Redis({ url: restUrl(), token: restToken(), automaticDeserialization: false });
    // Without deserialization Upstash returns HGETALL as a flat [field, value, …] array; callers
    // index it by field, as with MemoryRedis.
    const hgetall = client.hgetall;
    client.hgetall = async (...args) => toHash(await hgetall(...args));
  } else if (process.env.VERCEL) {
    throw new Error('לא מחובר מסד נתונים: הוסיפו Upstash Redis מ-Vercel ← Storage');
  } else {
    logger.warn('no Upstash Redis configured - using an in-memory store, nothing survives a restart');
    client = new MemoryRedis();
  }
  return client;
}

function toHash(value) {
  if (!Array.isArray(value)) return value;
  if (!value.length) return null;
  const hash = {};
  for (let i = 0; i < value.length; i += 2) hash[value[i]] = value[i + 1];
  return hash;
}

export function setRedis(c) {
  client = c;
}

/** The subset of Redis that this app uses, with Upstash's call signatures. */
export class MemoryRedis {
  #data = new Map(); // key -> { type, value, expireAt }

  #entry(key, type) {
    const e = this.#data.get(key);
    if (!e) return undefined;
    if (e.expireAt && e.expireAt <= Date.now()) {
      this.#data.delete(key);
      return undefined;
    }
    if (type && e.type !== type) throw new Error(`WRONGTYPE ${key}`);
    return e;
  }

  #container(key, type, empty) {
    let e = this.#entry(key, type);
    if (!e && empty !== undefined) {
      e = { type, value: empty, expireAt: null };
      this.#data.set(key, e);
    }
    return e?.value;
  }

  async get(key) {
    return this.#entry(key, 'string')?.value ?? null;
  }

  async set(key, value, opts = {}) {
    const exists = !!this.#entry(key);
    if ((opts.nx && exists) || (opts.xx && !exists)) return null;
    const expireAt = opts.ex ? Date.now() + opts.ex * 1000 : opts.px ? Date.now() + opts.px : null;
    this.#data.set(key, { type: 'string', value: String(value), expireAt });
    return 'OK';
  }

  async mget(...keys) {
    return keys.flat().map((k) => this.#entry(k, 'string')?.value ?? null);
  }

  async del(...keys) {
    let n = 0;
    for (const k of keys.flat()) if (this.#entry(k) && this.#data.delete(k)) n++;
    return n;
  }

  async exists(...keys) {
    return keys.flat().filter((k) => this.#entry(k)).length;
  }

  async incr(key) {
    const e = this.#entry(key, 'string');
    const value = Number(e?.value ?? 0) + 1;
    this.#data.set(key, { type: 'string', value: String(value), expireAt: e?.expireAt ?? null });
    return value;
  }

  async scan(cursor, { match = '*' } = {}) {
    const re = new RegExp(`^${match.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`);
    return ['0', [...this.#data.keys()].filter((k) => this.#entry(k) && re.test(k))];
  }

  async rpush(key, ...values) {
    const list = this.#container(key, 'list', []);
    list.push(...values.map(String));
    return list.length;
  }

  async lpush(key, ...values) {
    const list = this.#container(key, 'list', []);
    list.unshift(...values.map(String).reverse());
    return list.length;
  }

  async lpop(key) {
    const list = this.#container(key, 'list');
    return list?.length ? list.shift() : null;
  }

  async llen(key) {
    return this.#container(key, 'list')?.length ?? 0;
  }

  async lrange(key, start, stop) {
    const list = this.#container(key, 'list') || [];
    const n = list.length;
    const s = start < 0 ? Math.max(n + start, 0) : start;
    const e = stop < 0 ? n + stop : Math.min(stop, n - 1);
    return s > e ? [] : list.slice(s, e + 1);
  }

  async ltrim(key, start, stop) {
    const list = this.#container(key, 'list');
    if (list) list.splice(0, list.length, ...(await this.lrange(key, start, stop)));
    return 'OK';
  }

  async hset(key, kv) {
    const hash = this.#container(key, 'hash', {});
    let added = 0;
    for (const [field, value] of Object.entries(kv)) {
      if (!(field in hash)) added++;
      hash[field] = String(value);
    }
    return added;
  }

  async hget(key, field) {
    return this.#container(key, 'hash')?.[field] ?? null;
  }

  async hgetall(key) {
    const hash = this.#container(key, 'hash');
    return hash && Object.keys(hash).length ? { ...hash } : null;
  }

  async zadd(key, ...members) {
    const zset = this.#container(key, 'zset', []);
    for (const { score, member } of members) {
      const i = zset.findIndex((m) => m.member === member);
      if (i >= 0) zset.splice(i, 1);
      zset.push({ score: Number(score), member: String(member) });
    }
    return members.length;
  }

  async zcount(key, min, max) {
    const [lo, hi] = [bound(min), bound(max)];
    return (this.#container(key, 'zset') || []).filter((m) => m.score >= lo && m.score <= hi).length;
  }

  async zremrangebyscore(key, min, max) {
    const zset = this.#container(key, 'zset');
    if (!zset) return 0;
    const [lo, hi] = [bound(min), bound(max)];
    const kept = zset.filter((m) => m.score < lo || m.score > hi);
    const removed = zset.length - kept.length;
    zset.splice(0, zset.length, ...kept);
    return removed;
  }

  pipeline() {
    const ops = [];
    const pipe = new Proxy(
      {},
      {
        get: (_, name) => {
          if (name === 'exec') {
            return async () => {
              const out = [];
              for (const [op, args] of ops) out.push(await this[op](...args));
              return out;
            };
          }
          return (...args) => {
            ops.push([name, args]);
            return pipe;
          };
        },
      },
    );
    return pipe;
  }
}

const bound = (v) => (v === '-inf' ? -Infinity : v === '+inf' ? Infinity : Number(v));
