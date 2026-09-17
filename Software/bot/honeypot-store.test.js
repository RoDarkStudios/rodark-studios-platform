const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const postgres = require('../api/_lib/postgres');

test('honeypot cleanup migrates existing bans and persists deduplicated jobs with fixed windows', async (t) => {
    const db = new PGlite();
    t.mock.method(postgres, 'postgresQuery', async (sql, params) => db.query(sql, params));
    const loadStore = () => {
        delete require.cache[require.resolve('../api/_lib/discord-honeypot-store')];
        return require('../api/_lib/discord-honeypot-store');
    };
    try {
        await db.exec(`
            create table discord_bot_honeypot_bans (
                message_id text primary key, guild_id text not null, channel_id text not null,
                user_id text not null, banned_at timestamptz not null default now()
            );
            insert into discord_bot_honeypot_bans (message_id, guild_id, channel_id, user_id)
            values ('legacy', 'guild', 'trap', 'old-member');
        `);
        let store = loadStore();
        await store.saveState('guild', 'trap', 'warning');
        assert.equal((await store.getState('guild')).banCount, 1);
        assert.deepEqual(await store.getDueCleanups(['guild'], new Date('2030-01-01')), [],
            'migration must not schedule old bans for retrospective deletion');

        const bannedAt = new Date('2026-09-17T12:00:00Z');
        const record = { id: 'new', guild: { id: 'guild' }, channelId: 'trap', author: { id: 'member' },
            bannedAt, cleanupFrom: new Date('2026-09-17T11:50:00Z'), cleanupUntil: new Date('2026-09-17T12:00:10Z') };
        await store.recordBan(record);
        await store.recordBan({ ...record, bannedAt: new Date(), cleanupFrom: new Date(), cleanupUntil: new Date() });
        assert.equal((await store.getState('guild')).banCount, 2);
        assert.deepEqual(await store.getDueCleanups(['guild'], bannedAt), []);
        assert.deepEqual(await store.getDueCleanups(['other'], new Date('2030-01-01')), []);

        let jobs = await store.getDueCleanups(['guild'], record.cleanupUntil);
        assert.equal(jobs.length, 1);
        assert.equal(jobs[0].banned_at.getTime(), bannedAt.getTime());
        assert.equal(jobs[0].cleanup_from.getTime(), record.cleanupFrom.getTime());
        assert.equal(jobs[0].cleanup_until.getTime(), record.cleanupUntil.getTime());

        const retryAt = new Date('2026-09-17T12:05:00Z');
        await store.updateCleanup('new', { dueAt: retryAt, passes: 1, attempts: 2, error: 'Missing Permissions' });
        store = loadStore(); // A new worker must recover exactly the saved job.
        assert.deepEqual(await store.getDueCleanups(['guild'], record.cleanupUntil), []);
        jobs = await store.getDueCleanups(['guild'], retryAt);
        assert.equal(jobs[0].cleanup_passes, 1);
        assert.equal(jobs[0].cleanup_attempts, 2);
        assert.equal(jobs[0].cleanup_error, 'Missing Permissions');
        assert.equal(jobs[0].cleanup_from.getTime(), record.cleanupFrom.getTime());
        await store.updateCleanup('new', { dueAt: null, passes: 2, attempts: 0, error: null });
        await store.recordBan(record);
        assert.deepEqual(await store.getDueCleanups(['guild'], new Date('2030-01-01')), []);
        assert.equal((await store.getState('guild')).banCount, 2);
    } finally {
        await db.close();
    }
});
