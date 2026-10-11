/**
 * FEE-XMD — WhatsApp session (auth state) storage.
 *
 * Why this exists
 * ---------------
 * Baileys normally keeps the WhatsApp session in files (`useMultiFileAuthState`
 * -> the `Session/` folder). That works fine on a VPS, but a Render web service
 * has an **ephemeral filesystem**: every restart, redeploy or free-plan
 * spin-down wipes `Session/`, so the bot would have to be paired again by hand.
 *
 * This module keeps the same session inside **PostgreSQL** instead, which on
 * Render means **Neon** (the app already talks to Postgres through
 * `DATABASE_URL`, see `database/config.js`). The session then survives
 * restarts, deploys and free-plan sleep/wake cycles.
 *
 * Behaviour (no code changes needed anywhere else):
 *   - `DATABASE_URL` set  -> session lives in Postgres/Neon  (store = "postgres")
 *   - no `DATABASE_URL`   -> classic multi-file `Session/` folder (store = "file")
 *   - Postgres unreachable -> automatic fallback to the file store
 *   - `SESSION_STORE=file` forces files, `SESSION_STORE=db` forces Postgres
 *   - `SESSION_NAME=...`  namespaces the keys, so several bots can share one
 *     Neon database without overwriting each other's session.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BufferJSON, initAuthCreds, useMultiFileAuthState, proto } from '@whiskeysockets/baileys';
import { getBackend, initializeDatabase, pgPool } from '../database/config.js';

const TABLE = 'whatsapp_auth';
const CREDS_ID = 'creds';

/** current store in use: 'postgres' | 'file' | null */
let _store = null;

/** namespace so multiple bots can share one database */
const namespace = () => (process.env.SESSION_NAME || 'default').trim() || 'default';

/** same sanitiser baileys uses for file names, so ids stay safe as keys */
const safe = (value) => String(value ?? '').replace(/[\/:]/g, '_');
const keyFor = (type, id) => `${safe(type)}-${safe(id)}`;

const serialize = (value) => JSON.stringify(value, BufferJSON.replacer);
const deserialize = (text) => JSON.parse(text, BufferJSON.reviver);

async function ensureSchema(pool) {
    await pool.query(
        `CREATE TABLE IF NOT EXISTS ${TABLE} (
            namespace  TEXT        NOT NULL DEFAULT 'default',
            id         TEXT        NOT NULL,
            data       TEXT        NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (namespace, id)
        )`
    );
}

async function usePgAuthState(pool) {
    await ensureSchema(pool);
    const ns = namespace();

    const readMany = async (ids) => {
        if (!ids.length) return {};
        const { rows } = await pool.query(
            `SELECT id, data FROM ${TABLE} WHERE namespace = $1 AND id = ANY($2::text[])`,
            [ns, ids]
        );
        const out = {};
        for (const row of rows) {
            try {
                out[row.id] = deserialize(row.data);
            } catch {
                out[row.id] = null;
            }
        }
        return out;
    };

    const readOne = async (id) => (await readMany([id]))[id] ?? null;

    const creds = (await readOne(CREDS_ID)) || initAuthCreds();

    const state = {
        creds,
        keys: {
            async get(type, ids) {
                const list = ids || [];
                const found = await readMany(list.map((id) => keyFor(type, id)));
                const data = {};
                for (const id of list) {
                    let value = found[keyFor(type, id)] ?? null;
                    if (type === 'app-state-sync-key' && value) {
                        try {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        } catch { /* keep the raw object */ }
                    }
                    data[id] = value;
                }
                return data;
            },
            async set(data) {
                const writes = [];
                const removes = [];
                for (const type of Object.keys(data || {})) {
                    for (const id of Object.keys(data[type] || {})) {
                        const value = data[type][id];
                        const key = keyFor(type, id);
                        if (value === null || value === undefined) removes.push(key);
                        else writes.push([key, serialize(value)]);
                    }
                }
                if (removes.length) {
                    await pool.query(
                        `DELETE FROM ${TABLE} WHERE namespace = $1 AND id = ANY($2::text[])`,
                        [ns, removes]
                    );
                }
                if (writes.length) {
                    await pool.query(
                        `INSERT INTO ${TABLE} (namespace, id, data, updated_at)
                         SELECT $1::text, t.id, t.data, now()
                           FROM unnest($2::text[], $3::text[]) AS t(id, data)
                         ON CONFLICT (namespace, id)
                         DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
                        [ns, writes.map((w) => w[0]), writes.map((w) => w[1])]
                    );
                }
            },
            async clear() {
                await pool.query(`DELETE FROM ${TABLE} WHERE namespace = $1`, [ns]);
            }
        }
    };

    const saveCreds = async () => {
        await pool.query(
            `INSERT INTO ${TABLE} (namespace, id, data, updated_at)
             VALUES ($1, $2, $3, now())
             ON CONFLICT (namespace, id)
             DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
            [ns, CREDS_ID, serialize(creds)]
        );
    };

    return { state, saveCreds };
}

/**
 * Drop-in replacement for `useMultiFileAuthState(dir)`.
 * Also publishes `global.__feeSessionExists` (true when a linked account
 * already exists), which the bot uses to decide whether to ask for a pairing
 * code on start-up.
 */
export async function useAuthState(sessionDir) {
    const mode = (process.env.SESSION_STORE || 'auto').toLowerCase().trim();

    if (mode !== 'file') {
        try {
            await initializeDatabase();
            const pool = pgPool;
            if (pool && getBackend() === 'pg') {
                const result = await usePgAuthState(pool);
                _store = 'postgres';
                global.__feeSessionExists = !!result.state?.creds?.me?.id;
                console.log(
                    `[SESSION] store=postgres (Neon) namespace="${namespace()}" linked=${
                        global.__feeSessionExists ? 'yes' : 'no'
                    }`
                );
                return result;
            }
            if (mode === 'db') {
                console.log('[SESSION] SESSION_STORE=db but Postgres is not connected — using files');
            }
        } catch (err) {
            console.log(`[SESSION] Postgres auth state unavailable (${err?.message || err}) — using files`);
        }
    }

    const result = await useMultiFileAuthState(sessionDir);
    _store = 'file';
    global.__feeSessionExists = fs.existsSync(path.join(sessionDir, 'creds.json'));
    console.log(`[SESSION] store=file dir="${sessionDir}" linked=${global.__feeSessionExists ? 'yes' : 'no'}`);
    return result;
}

/** Wipe the stored session (used when WhatsApp reports the device was logged out). */
export async function clearSession(sessionDir) {
    try {
        await initializeDatabase();
        if (pgPool && getBackend() === 'pg') {
            await pgPool.query(`DELETE FROM ${TABLE} WHERE namespace = $1`, [namespace()]);
        }
    } catch (err) {
        console.log(`[SESSION] could not clear Postgres session (${err?.message || err})`);
    }
    if (sessionDir) {
        try {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        } catch { /* nothing to remove */ }
    }
    global.__feeSessionExists = false;
}

/** 'postgres' | 'file' | null — which store is currently in use. */
export function getSessionStore() {
    return _store;
}
