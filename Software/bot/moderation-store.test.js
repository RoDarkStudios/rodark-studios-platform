const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const postgres = require('../api/_lib/postgres');

test('moderation persistence executes against PostgreSQL, including transactions and recovery', async (t) => {
    const db = new PGlite();
    let released = 0;
    const query = async (sql, params) => {
        const result = sql.includes('create table') ? (await db.exec(sql)).at(-1) : await db.query(sql, params);
        return { ...result, rowCount: result.affectedRows || result.rows?.length || 0 };
    };
    t.mock.method(postgres, 'postgresQuery', query);
    t.mock.method(postgres, 'getPostgresPool', () => ({ connect: async () => ({ query, release() { released++; } }) }));
    delete require.cache[require.resolve('../api/_lib/discord-moderation-store')];
    const store = require('../api/_lib/discord-moderation-store');
    const message = { id: 'message-1', guild_id: 'guild', channel_id: 'chat', user_id: 'alice', content: 'Hello', timestamp: new Date().toISOString(), version: 'v1' };
    const entry = { id: 'case-1', guild_id: 'guild', channel_id: 'chat', user_id: 'alice', category: 'personal_attack', reason: 'Abuse', outcome: 'pending', evidence: [message], log_message_id: null };
    try {
        await store.ensureSchema();
        await t.test('queue deduplicates messages, survives retries, and scopes guilds', async () => {
            await store.enqueue(message); await store.enqueue(message);
            assert.equal((await store.pendingChannels(['other'])).length, 0);
            assert.equal((await store.pendingChannels(['guild']))[0].pending_count, 1);
            await store.failBatch([message]); await store.failBatch([message]);
            assert.equal((await store.loadPending('chat')).length, 1);
            await store.failBatch([message]); assert.equal((await store.loadPending('chat')).length, 0);
            await store.enqueue({ ...message, version: 'v2', content: 'Edited' });
            assert.equal((await store.loadPending('chat')).length, 1);
        });
        await t.test('stale results do not acknowledge an edit or create a punishment', async () => {
            await store.commitReview([message], [entry]);
            assert.equal((await store.loadPending('chat'))[0].version, 'v2');
            assert.equal(await store.getCase(entry.id), null);
        });
        await t.test('cases and acknowledgements commit atomically, then are recovered for action', async () => {
            const current = (await store.loadPending('chat'))[0];
            await assert.rejects(store.commitReview([current], [{ ...entry, user_id: null, evidence: [current] }]));
            assert.equal((await store.loadPending('chat')).length, 1);
            await store.commitReview([current], [{ ...entry, evidence: [current] }]);
            assert.equal((await store.loadPending('chat')).length, 0);
            assert.equal((await store.getContext('chat'))[0].content, 'Edited');
            assert.equal((await store.unfinishedCases('guild'))[0].outcome, 'pending');
            await store.updateCase(entry.id, { outcome: 'timed_out' });
            assert.equal((await store.recentCases('guild', ['alice'])).length, 1);
            await store.updateCase(entry.id, { log_message_id: 'log-1', dismissed_by: 'mod' });
            assert.equal((await store.unfinishedCases('guild')).length, 0);
            assert.equal((await store.recentCases('guild', ['alice'])).length, 0);
        });
        await t.test('deletions cannot be resurrected by late gateway events', async () => {
            const deleted = { ...message, id: 'deleted' }; await store.enqueue(deleted);
            await store.markDeleted(['deleted']); await store.enqueue({ ...deleted, version: 'v3' });
            assert.equal((await store.loadPending('chat')).length, 0);
        });
        await t.test('persistent scheduling permits at most one request per minute', async () => {
            assert.equal(await store.claimInterval('chat'), true);
            assert.equal(await store.claimInterval('chat'), false);
            await db.query("update discord_bot_moderation_channels set next_review_at = now() - interval '1 second'");
            assert.equal(await store.claimInterval('chat'), true);
        });
        await t.test('usage includes failed and reasoning tokens without double-counting them as output', async () => {
            await store.recordUsage('guild', 'gpt-5.6-luna', { input_tokens: 1000, input_tokens_details: { cached_tokens: 200 }, output_tokens: 500, output_tokens_details: { reasoning_tokens: 450 } });
            await store.recordUsage('guild', 'gpt-5.6-luna', { output_tokens: 8192 }, true);
            const row = (await db.query('select * from discord_bot_moderation_usage')).rows[0];
            assert.equal(Number(row.requests), 2); assert.equal(Number(row.failures), 1);
            assert.equal(Number(row.output_tokens), 8692); assert.equal(Number(row.reasoning_tokens), 450);
        });
        await t.test('advisory lock SQL works and releases a connection when the callback throws', async () => {
            const before = released;
            await assert.rejects(store.withLock('test-lock', async () => { throw new Error('Test failure'); }), /Test failure/);
            assert.equal(released, before + 1);
            assert.equal(await store.withLock('test-lock', async () => {}), true);
        });
        await t.test('retention removes old raw messages, cases and usage', async () => {
            await db.exec("update discord_bot_moderation_messages set updated_at = now() - interval '2 days'; update discord_bot_moderation_cases set created_at = now() - interval '31 days'; update discord_bot_moderation_usage set usage_date = current_date - 91;");
            await store.cleanup();
            for (const table of ['messages', 'cases', 'usage']) assert.equal((await db.query(`select count(*)::int as count from discord_bot_moderation_${table}`)).rows[0].count, 0);
        });
    } finally { await db.close(); }
});
