import { BufferJSON, initAuthCreds, proto } from 'baileys';
import { redis } from './redis.js';

// WhatsApp linked-device credentials and Signal keys, kept in Redis so any worker session can resume them.
const CREDS = 'auth:creds';
const keyName = (type, id) => `auth:${type}:${id}`;
const encode = (value) => JSON.stringify(value, BufferJSON.replacer);
const decode = (raw) => (raw == null ? null : JSON.parse(raw, BufferJSON.reviver));

/** True when a phone has linked this account (not just a QR waiting to be scanned). */
export async function isLinked() {
  return !!decode(await redis().get(CREDS))?.me;
}

/** Same contract as Baileys' useMultiFileAuthState, plus flush() to await outstanding writes. */
export async function useRedisAuthState() {
  const r = redis();
  const pending = new Set();
  const track = (promise) => {
    pending.add(promise);
    promise.finally(() => pending.delete(promise)).catch(() => {});
    return promise;
  };
  const creds = decode(await r.get(CREDS)) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        async get(type, ids) {
          if (!ids.length) return {};
          const values = await r.mget(...ids.map((id) => keyName(type, id)));
          const data = {};
          ids.forEach((id, i) => {
            let value = decode(values[i]);
            if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
            data[id] = value;
          });
          return data;
        },
        async set(data) {
          const pipe = r.pipeline();
          let ops = 0;
          for (const type in data) {
            for (const id in data[type]) {
              const value = data[type][id];
              if (value) pipe.set(keyName(type, id), encode(value));
              else pipe.del(keyName(type, id));
              ops++;
            }
          }
          if (ops) await track(pipe.exec());
        },
      },
    },
    saveCreds: () => track(r.set(CREDS, encode(creds))),
    flush: () => Promise.allSettled([...pending]),
  };
}

export async function clearAuth() {
  const r = redis();
  let cursor = '0';
  do {
    const [next, keys] = await r.scan(cursor, { match: 'auth:*', count: 500 });
    if (keys.length) await r.del(...keys);
    cursor = String(next);
  } while (cursor !== '0');
}
