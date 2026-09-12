const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const postgres = require('../api/_lib/postgres');
const { guildId } = require('../discord/server.json');

test('repository settings override stale dashboard values while status changes preserve channel bindings and audit data', async (t) => {
    const db = new PGlite();
    t.mock.method(postgres, 'postgresQuery', (sql, params) => db.query(sql, params));
    const store = require('../api/_lib/discord-bot-control-store');
    try {
        await store.ensureDiscordBotControlSchema();
        await db.query("update discord_bot_control set guild_id = '111111111111111111', content_rules_channel_id = '222222222222222222', level_system_enabled = false, level_attachment_unlock_level = 25, level_mention_enabled = true where id = 1");
        const initial = await store.getDiscordBotControl();
        assert.equal(initial.guildId, guildId);
        assert.equal(initial.levelSystem.enabled, true);
        assert.equal(initial.levelSystem.attachmentUnlockLevel, 5);
        assert.equal(initial.levelSystem.mentionLevelUps, false);
        await assert.rejects(store.updateDiscordBotControl({ guildId: '111111111111111111' }), /fixed in the repository/);
        const updated = await store.updateDiscordBotControl({ desiredEnabled: true }, { id: 'owner-id', username: 'Owner' });
        assert.equal(updated.guildId, guildId);
        assert.equal(updated.startupContentSync.rulesChannelId, '222222222222222222');
        assert.equal(updated.desiredEnabled, true);
        assert.equal(updated.updatedByUserId, 'owner-id');
        assert.equal(updated.updatedByUsername, 'Owner');
        assert.equal(updated.gameUpdates, undefined);
        assert.deepEqual((await db.query('select guild_id, level_system_enabled, level_attachment_unlock_level, level_mention_enabled from discord_bot_control')).rows[0], {
            guild_id: guildId, level_system_enabled: true, level_attachment_unlock_level: 5, level_mention_enabled: false
        });
    } finally { await db.close(); }
});

test('retired website controls reject writes; status and authenticated transcript reads stay available without Discord API calls', async (t) => {
    const auth = require('../api/_lib/admin-auth');
    const controlStore = require('../api/_lib/discord-bot-control-store');
    const infrastructure = require('../api/_lib/discord-infrastructure-store');
    const tickets = require('../api/_lib/discord-ticket-store');
    let isAdmin = true, maintenance = false;
    const control = { guildId, desiredEnabled: true };
    const writes = [], transcriptReads = [], transcript = { ticketId: 42, messages: [{ content: 'Preserved conversation' }] };
    t.mock.method(auth, 'requireAdmin', async () => ({ user: { id: 'owner' }, isAdmin }));
    t.mock.method(controlStore, 'getDiscordBotControl', async () => ({ ...control }));
    t.mock.method(controlStore, 'updateDiscordBotControl', async (patch, user) => { writes.push({ patch, user }); Object.assign(control, patch); });
    t.mock.method(infrastructure, 'getState', async () => ({ active: null, initialized: false, maintenance }));
    t.mock.method(tickets, 'listDiscordTicketTranscripts', async (limit, offset) => { transcriptReads.push({ limit, offset }); return [transcript]; });
    t.mock.method(tickets, 'getDiscordTicketTranscript', async id => id === '42' ? transcript : null);
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('Dashboard controls must not make external requests'); });
    delete require.cache[require.resolve('../api/admin/discord-bot-control')];
    const handler = require('../api/admin/discord-bot-control');
    const response = () => ({ code: null, body: null, setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; } });
    for (const body of [
        { operation: 'game-update:send', gameUpdateAnnouncement: { title: 'Old client', body: 'Must not post' } },
        { gameUpdates: { channelId: '333333333333333333' } },
        { guildId: '111111111111111111' },
        { startupContentSync: { rulesChannelId: '333333333333333333' } },
        { ticketSystem: { helperRoleIds: [] } }, { levelSystem: { enabled: false, mentionLevelUps: true } },
        { desiredEnabled: true, guildId }, { desiredEnabled: 'false' }, {}
    ]) {
        const res = response(); await handler({ method: 'POST', body }, res);
        assert.equal(res.code, 400);
    }
    assert.equal(writes.length, 0);
    let res = response(); await handler({ method: 'GET', query: {} }, res);
    assert.equal(res.code, 200); assert.equal(res.body.control.guildId, guildId);
    res = response(); await handler({ method: 'POST', body: { desiredEnabled: false } }, res);
    assert.equal(res.code, 200); assert.equal(res.body.control.desiredEnabled, false);
    assert.deepEqual(writes, [{ patch: { desiredEnabled: false }, user: { id: 'owner' } }]);
    maintenance = true;
    res = response(); await handler({ method: 'POST', body: { desiredEnabled: true } }, res);
    assert.equal(res.code, 409); assert.equal(writes.length, 1);
    res = response(); await handler({ method: 'GET', query: { ticketTranscripts: '1', limit: '30', offset: '30' } }, res);
    assert.equal(res.code, 200); assert.deepEqual(res.body.transcripts, [transcript]);
    assert.deepEqual(transcriptReads, [{ limit: '30', offset: '30' }]);
    res = response(); await handler({ method: 'GET', query: { ticketTranscriptId: '42' } }, res);
    assert.equal(res.code, 200); assert.deepEqual(res.body.transcript, transcript);
    res = response(); await handler({ method: 'GET', query: { ticketTranscriptId: '404' } }, res); assert.equal(res.code, 404);
    isAdmin = false;
    res = response(); await handler({ method: 'GET', query: { ticketTranscripts: '1' } }, res); assert.equal(res.code, 403);
    assert.equal(transcriptReads.length, 1); assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test('a level-up still posts the level 5 embed without pinging the member', async (t) => {
    t.mock.method(postgres, 'postgresQuery', async sql => ({ rows: sql.includes('returning message_count') ? [{ message_count: 50 }] : [] }));
    delete require.cache[require.resolve('./levels')];
    const { handleLevelMessage } = require('./levels');
    const { controlWithLayout } = require('./server-infrastructure');
    const { manifest } = require('./server-blueprint');
    const sent = [];
    const control = controlWithLayout({}, { spec: manifest, bindings: { role: {}, channel: { 'level-ups': 'level-channel' } } });
    const guild = { id: guildId, members: { fetch: async () => null } };
    const message = { guild, author: { id: 'member', username: 'Member' }, client: { channels: { fetch: async id => {
        assert.equal(id, 'level-channel');
        return { type: 0, guild, send: async payload => sent.push(payload) };
    } } } };
    assert.equal(await handleLevelMessage(message, control), true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].content, '');
    assert.deepEqual(sent[0].allowedMentions, { parse: [] });
    assert.match(sent[0].embeds[0].toJSON().description, /Level 5/);
    assert.match(sent[0].embeds[0].toJSON().description, /embed links/);
});
