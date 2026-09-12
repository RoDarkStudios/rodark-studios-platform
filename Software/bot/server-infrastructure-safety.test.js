const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { Collection, ChannelType } = require('discord.js');
const postgres = require('../api/_lib/postgres');
const { compileBlueprint } = require('./server-blueprint');
const { createHandler } = require('../api/admin/discord-infrastructure');
const { runStartupSync } = require('./discord-startup-sync');
const { controlWithLayout } = require('./server-infrastructure');
const { handleCommunityInteraction } = require('./server-community');
const GUILD = '849976422135103498';

test('deployment persistence uses PostgreSQL constraints, scopes previews to their server/version, expires previews and checkpoints recovery', async (t) => {
    const db = new PGlite();
    const query = async (sql, params) => {
        const result = sql.includes('create table') ? (await db.exec(sql)).at(-1) : await db.query(sql, params);
        return { ...result, rowCount: result.affectedRows || result.rows?.length || 0 };
    };
    t.mock.method(postgres, 'postgresQuery', query);
    delete require.cache[require.resolve('../api/_lib/discord-infrastructure-store')];
    const store = require('../api/_lib/discord-infrastructure-store');
    try {
        await store.ensureSchema();
        const state = await store.getState(GUILD);
        assert.equal(state.initialized, false);
        const first = await store.queuePreview(GUILD, 'release-1', { id: 'owner' });
        await assert.rejects(store.queuePreview(GUILD, 'release-1', { id: 'other-owner' }), /already queued/);
        assert.equal((await store.claimJob(GUILD)).status, 'previewing');
        const plan = { errors: [], operations: [{ kind: 'channel', key: 'help' }], fingerprint: 'fingerprint' };
        await store.ready(first.id, plan);
        await assert.rejects(store.queueDeploy('another-guild', first.id, 'release-1', { id: 'owner' }), /preview expired/);
        await assert.rejects(store.queueDeploy(GUILD, first.id, 'release-2', { id: 'owner' }), /preview expired/);
        const queued = await store.queueDeploy(GUILD, first.id, 'release-1', { id: 'second-owner' });
        assert.equal(queued.actor.id, 'second-owner');
        await assert.rejects(store.queueDeploy(GUILD, first.id, 'release-1', { id: 'owner' }));
        assert.equal((await store.claimJob(GUILD)).status, 'applying');
        const bindings = { role: { staff: 'staff-id' }, channel: { help: 'new-channel-id' } };
        await store.beginApply(GUILD, bindings);
        await store.progress(first.id, { label: 'Created help' });
        await store.recoverInterrupted(GUILD);
        assert.equal((await store.latestJobs(GUILD))[0].status, 'failed');
        assert.equal((await store.getState(GUILD)).maintenance, true);
        assert.deepEqual((await store.getState(GUILD)).resources, bindings);
        const retry = await store.queuePreview(GUILD, 'release-1', { id: 'owner' });
        await store.claimJob(GUILD); await store.ready(retry.id, { ...plan, errors: ['Missing permissions'] });
        await assert.rejects(store.queueDeploy(GUILD, retry.id, 'release-1', { id: 'owner' }), /preview expired/);
        await store.ready(retry.id, plan);
        await query("update discord_infrastructure_jobs set expires_at = now() - interval '1 minute' where id = $1", [retry.id]);
        await assert.rejects(store.queueDeploy(GUILD, retry.id, 'release-1', { id: 'owner' }), /preview expired/);
        await store.ready(retry.id, plan); await store.queueDeploy(GUILD, retry.id, 'release-1', { id: 'owner' }); await store.claimJob(GUILD);
        await store.activate(GUILD, { version: 'release-1', bindings }, bindings); await store.finish(retry.id, 'succeeded');
        assert.equal((await store.getState(GUILD)).initialized, true);
        assert.equal((await store.getState(GUILD)).maintenance, false);
        await store.setDrift(GUILD, { changes: ['Channel moved'] });
        assert.deepEqual((await store.getState(GUILD)).drift.changes, ['Channel moved']);
        assert.ok((await store.latestJobs(GUILD)).some((job) => job.progress[0]?.label === 'Created help'));
    } finally { await db.close(); }
});

function response() {
    return { headers: {}, code: null, body: null, setHeader(key, value) { this.headers[key] = value; },
        status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
}
test('only authenticated studio owners can queue work, cross-site requests are rejected and browser-supplied plans cannot execute', async () => {
    const version = compileBlueprint().version;
    let calls = 0, auth = { user: null, isAdmin: false, rank: null };
    const handler = createHandler({ authorize: async () => auth, getControl: async () => ({ guildId: GUILD }), store: {
        queuePreview: async (_guild, _version, actor) => { calls++; return { actor }; }, queueDeploy: async () => { calls++; return {}; }
    } });
    const request = { method: 'POST', headers: { host: 'www.rodarkstudios.com', 'x-forwarded-proto': 'https', origin: 'https://www.rodarkstudios.com', 'content-type': 'application/json' }, body: { action: 'preview', version } };
    let res = response(); await handler(request, res); assert.equal(res.code, 401);
    auth = { user: { id: 'staff' }, isAdmin: false, rank: 200 };
    res = response(); await handler(request, res); assert.equal(res.code, 403);
    auth = { user: { id: 'owner', username: 'Studio owner' }, isAdmin: true, rank: 254 };
    res = response(); await handler({ ...request, headers: { ...request.headers, origin: 'https://attacker.example' } }, res); assert.equal(res.code, 403);
    res = response(); await handler({ ...request, body: { ...request.body, plan: { deleteEverything: true } } }, res); assert.equal(res.code, 400);
    res = response(); await handler({ ...request, body: { ...request.body, version: 'stale' } }, res); assert.equal(res.code, 409);
    assert.equal(calls, 0);
    res = response(); await handler(request, res); assert.equal(res.code, 202); assert.equal(calls, 1); assert.equal(res.body.job.actor.id, 'owner');
    assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('information messages fit Discord limits and use deployed game/help/forum identities with no obsolete verification guidance', async () => {
    const blueprint = compileBlueprint(), messages = [], guild = { id: GUILD, roles: { cache: new Collection() }, emojis: { cache: new Collection() } };
    let id = 300000000000000000n;
    const bindings = { role: {}, channel: {} };
    for (const role of [{ key: 'owner', name: 'Owner' }, { key: 'bot', name: 'RoDark Studios Bot' }, ...blueprint.roles]) {
        const roleId = String(++id); bindings.role[role.key] = roleId;
        guild.roles.cache.set(roleId, { id: roleId, name: role.name, toString: () => `<@&${roleId}>` });
    }
    for (const channel of blueprint.channels) bindings.channel[channel.key] = String(++id);
    guild.emojis.create = async ({ name }) => ({ name, toString: () => `:${name}:` });
    const client = { user: { id: 'our-bot' }, channels: { fetch: async (channelId) => {
        const channel = { id: channelId, type: ChannelType.GuildText, guild, client, messages: { fetch: async () => new Collection() },
            send: async () => ({ author: { id: client.user.id }, edit: async (payload) => {
                const embeds = payload.embeds.map((embed) => embed.toJSON());
                for (const embed of embeds) {
                    assert.ok((embed.description || '').length <= 4096);
                    assert.ok((embed.fields || []).every((field) => field.value.length <= 1024));
                }
                messages.push(...embeds);
            } }) };
        return channel;
    } } };
    const active = { version: blueprint.version, spec: blueprint.spec, bindings };
    await runStartupSync(client, controlWithLayout({ levelSystem: { attachmentUnlockLevel: 5 } }, active));
    assert.equal(messages.length, 4);
    const text = JSON.stringify(messages);
    for (const game of blueprint.spec.games) assert.ok(text.includes(game.name));
    assert.ok(text.includes(bindings.channel.help));
    assert.ok(!text.includes('Coding Simulator 2'));
    assert.ok(!text.includes('1208767046184345610'));
    assert.ok(text.includes('Ordinary swearing'));
});

test('forum moderation delegates post operations to Staff without allowing status-tag changes or moderation of Owner posts', async () => {
    const blueprint = compileBlueprint(), bindings = { role: { staff: 'staff', owner: 'owner' }, channel: {} };
    for (const channel of blueprint.channels) bindings.channel[channel.key] = channel.key;
    let memberRoles = ['staff'], ownerPost = false, edited = null;
    const user = { id: 'moderator', roles: { cache: new Map() } };
    const guild = { ownerId: 'server-owner', members: { fetch: async ({ user: id }) => id === 'moderator'
        ? { ...user, roles: { cache: new Map(memberRoles.map((role) => [role, {}])) } }
        : { roles: { cache: new Map(ownerPost ? [['owner', {}]] : []) }, user: { bot: false } } },
        channels: { fetch: async () => ({ isThread: () => true, parentId: 'animal-tag/bug-reports', ownerId: 'author', edit: async (value) => { edited = value; } }) } };
    let reply = '';
    const interaction = { isChatInputCommand: () => true, commandName: 'forum-moderate', guildId: GUILD, guild,
        user: { id: 'moderator' }, channelId: 'post', deferReply: async () => {}, editReply: async (text) => { reply = text; },
        options: { getString: (name) => name === 'action' ? 'lock' : 'Abusive thread' } };
    const control = { infrastructure: { spec: blueprint.spec, bindings } };
    await handleCommunityInteraction(interaction, control);
    assert.equal(edited.locked, true); assert.ok(!Object.hasOwn(edited, 'appliedTags'));
    edited = null; ownerPost = true; await handleCommunityInteraction(interaction, control);
    assert.equal(edited, null); assert.match(reply, /Ask an Owner/);
    ownerPost = false; memberRoles = []; await handleCommunityInteraction(interaction, control);
    assert.equal(edited, null); assert.match(reply, /Only Staff/);
});
