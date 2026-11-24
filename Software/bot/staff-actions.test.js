const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { ApplicationCommand, ChannelType, Collection, PermissionFlagsBits: P, PermissionsBitField } = require('discord.js');
const postgres = require('../api/_lib/postgres');
const store = require('../api/_lib/discord-staff-action-store');
const { createStaffActions, staffCommands } = require('./staff-actions');

const GUILD = '849976422135103498';
const roles = { staff: 'staff', owner: 'owner' };
const control = { guildId: GUILD, infrastructure: { spec: { staffRemovalCommands: true },
    bindings: { role: roles, channel: { 'moderation-log': 'log' } } } };
const quietLogger = { error() {} };

function member(id, position, permissions = 0n, roleIds = []) {
    return { id, permissions: new PermissionsBitField(permissions), kickable: true, bannable: true,
        roles: { cache: new Map(roleIds.map(role => [role, {}])), highest: { position, comparePositionTo: peer => position - peer.position } } };
}

function fixture() {
    const actor = member('101', 5, P.ModerateMembers, [roles.staff]);
    const second = member('102', 5, P.ModerateMembers, [roles.staff]);
    const admin = member('103', 10, P.Administrator);
    const native = member('104', 5, P.ModerateMembers | P.KickMembers, [roles.staff]);
    const outsider = member('105', 4, P.ModerateMembers);
    const target = member('201', 1);
    const owner = member('202', 8, P.Administrator, [roles.owner]);
    const members = new Map([actor, second, admin, native, outsider, target, owner].map(item => [item.id, item]));
    const requests = [], delivered = [];
    const staffRole = { permissions: new PermissionsBitField(P.ModerateMembers) };
    const overwrites = new Collection([[GUILD, { deny: new PermissionsBitField(P.ViewChannel), allow: new PermissionsBitField() }]]);
    const logChannel = { type: ChannelType.GuildText, permissionOverwrites: { cache: overwrites }, async send(payload) {
        const id = String(delivered.length + 1);
        delivered.push(payload);
        return { id };
    } };
    const guild = { id: GUILD, ownerId: owner.id, client: { user: { id: 'bot' } },
        channels: { fetch: async () => logChannel }, roles: { fetch: async () => new Map([[roles.staff, staffRole]]) },
        members: { fetch: async ({ user }) => members.get(user) || null, fetchMe: async () => {} } };
    let nextId = 1000;
    function interaction(action, caller = actor, victim = target, reason = 'Repeated harassment') {
        return { id: String(nextId++), commandName: action, guild, user: caller, isChatInputCommand: () => true,
            options: { getUser: () => victim, getString: () => reason }, async deferReply(options) { assert.equal(options.ephemeral, true); },
            async editReply({ content }) { this.response = content; } };
    }
    const rest = { async put(path, options) { requests.push({ path, options }); }, async delete(path, options) { requests.push({ path, options }); } };
    return { actor, second, admin, native, outsider, target, owner, requests, delivered, staffRole, logChannel, overwrites, interaction, rest };
}

test('registered commands require a member, with a reason required only for kicks', () => {
    assert.deepEqual(staffCommands.map(command => command.name), ['ban', 'kick']);
    for (const data of staffCommands) {
        assert.equal(data.default_member_permissions, String(P.ModerateMembers));
        assert.deepEqual(data.options.map(option => [option.name, option.required]), [['member', true], ['reason', data.name === 'kick']]);
        const existing = new ApplicationCommand({}, { ...JSON.parse(JSON.stringify(data)), id: '1' }, { id: GUILD });
        assert.equal(existing.equals(data, true), true);
    }
});

test('staff removal commands enforce and audit a shared PostgreSQL-backed quota', async (t) => {
    const db = new PGlite();
    // PGlite has one SQL connection. Queue checkouts so independently running handlers use it like a pool.
    let idle = Promise.resolve();
    async function connect() {
        const previous = idle;
        let release;
        idle = new Promise(resolve => { release = resolve; });
        await previous;
        return { query: db.query.bind(db), release };
    }
    t.mock.method(postgres, 'getPostgresPool', () => ({ connect }));
    t.mock.method(postgres, 'postgresQuery', async (sql, params) => {
        const connection = await connect();
        try { return sql.startsWith('create table') ? await db.exec(sql) : await connection.query(sql, params); }
        finally { connection.release(); }
    });
    t.after(() => db.close());

    const f = fixture();
    let now = Date.now();
    const worker = () => createStaffActions(f.rest, { logger: quietLogger, now: () => now });
    const first = worker();

    await t.test('authorization is tied to the deployed Staff role and Discord hierarchy', async () => {
        const denied = [f.interaction('ban', f.outsider), f.interaction('kick', f.native),
            f.interaction('ban', f.actor, f.owner), f.interaction('kick', f.actor, f.second), f.interaction('ban', f.actor, f.actor)];
        for (const command of denied) await first.handleInteraction(command, control);
        assert.match(denied[0].response, /Only Staff/);
        assert.match(denied[1].response, /native Ban Members/);
        for (const command of denied.slice(2)) assert.match(command.response, /cannot take this action/);

        const blankReason = f.interaction('kick', f.actor, f.target, ' ');
        await first.handleInteraction(blankReason, control);
        assert.match(blankReason.response, /Enter a reason/);

        const legacy = f.interaction('ban');
        await first.handleInteraction(legacy, { guildId: GUILD });
        assert.match(legacy.response, /configuration is deployed/);
        f.staffRole.permissions.add(P.BanMembers);
        const drift = f.interaction('kick');
        await first.handleInteraction(drift, control);
        assert.match(drift.response, /native Ban Members/);
        f.staffRole.permissions.remove(P.BanMembers);
        assert.equal(f.requests.length, 0);
    });

    await t.test('concurrent mixed commands share five slots across workers and reject replays', async () => {
        const secondWorker = worker();
        const requests = Array.from({ length: 8 }, (_, index) => f.interaction(index % 2 ? 'kick' : 'ban'));
        await Promise.all(requests.map((request, index) => (index % 2 ? secondWorker : first).handleInteraction(request, control)));
        assert.equal(f.requests.length, 5);
        assert.ok(f.requests.some(request => request.path.includes('/bans/')));
        assert.ok(f.requests.some(request => request.path.includes('/members/')));
        assert.equal(requests.filter(request => request.response.includes('shared limit')).length, 3);
        const banRequest = f.requests.find(request => request.path.includes('/bans/'));
        assert.deepEqual(banRequest.options.body, { delete_message_seconds: 0 });
        assert.match(banRequest.options.reason, /\/ban by 101, interaction \d+/);

        const replay = requests.find(request => /was (banned|kicked)/.test(request.response));
        await worker().handleInteraction(replay, control);
        assert.match(replay.response, /already recorded/);
        const afterRestart = f.interaction('ban');
        await worker().handleInteraction(afterRestart, control);
        assert.match(afterRestart.response, /shared limit/);
        assert.equal(f.requests.length, 5);

        const otherStaff = f.interaction('kick', f.second);
        await first.handleInteraction(otherStaff, control);
        assert.match(otherStaff.response, /was kicked/);
        await db.query(`update discord_bot_staff_actions set quota_until = now() - interval '1 second' where interaction_id = $1`, [replay.id]);
        const afterExpiry = f.interaction('kick');
        await worker().handleInteraction(afterExpiry, control);
        assert.match(afterExpiry.response, /was kicked/);
    });

    await t.test('administrators bypass the limit and every completed action is published privately', async () => {
        const requests = [f.interaction('ban', f.admin, f.target, null),
            ...Array.from({ length: 5 }, () => f.interaction('ban', f.admin))];
        for (const request of requests) await first.handleInteraction(request, control);
        assert.ok(requests.every(request => request.response.includes('was banned')));
        assert.equal((await store.pendingLogs(GUILD)).length, 13);

        f.overwrites.get(GUILD).deny.remove(P.ViewChannel);
        await assert.rejects(first.publishLogs(requests[0].guild, control), /permissions changed/);
        assert.equal(f.delivered.length, 0);
        f.overwrites.get(GUILD).deny.add(P.ViewChannel);
        now += 15_000;
        await first.publishLogs(requests[0].guild, control);
        assert.equal(f.delivered.length, 13);
        assert.equal(f.delivered.filter(message => message.embeds[0].data.fields[0].value.includes('Administrator')).length, 6);
        const reasons = f.delivered.map(message => message.embeds[0].data.fields.find(field => field.name === 'Reason').value);
        assert.equal(reasons.filter(reason => reason === 'No reason provided').length, 1);
        assert.equal(reasons.filter(reason => reason === 'Repeated harassment').length, 12);
        assert.ok(f.delivered.every(message => message.enforceNonce && message.allowedMentions.parse.length === 0));
        assert.deepEqual(await store.pendingLogs(GUILD), []);
    });

    await t.test('a reject releases a slot, while an ambiguous response retains a slot and stays auditable', async () => {
        const { guild } = f.interaction('ban');
        const service = createStaffActions({ async put() { throw Object.assign(new Error('Permission denied'), { status: 403 }); },
            async delete() { throw new Error('Network interrupted'); } }, { logger: quietLogger });
        const failed = f.interaction('ban', f.second);
        await service.handleInteraction(failed, control);
        assert.match(failed.response, /Discord rejected/);
        const uncertain = f.interaction('kick', f.second);
        await service.handleInteraction(uncertain, control);
        assert.match(uncertain.response, /did not confirm/);
        const remaining = Array.from({ length: 4 }, () => f.interaction('ban', f.second));
        for (const request of remaining) await first.handleInteraction(request, control);
        assert.ok(remaining.slice(0, 3).every(request => request.response.includes('was banned')));
        assert.match(remaining[3].response, /shared limit/);
        const pending = await store.pendingLogs(guild.id);
        assert.equal(pending.find(row => row.interaction_id === failed.id).outcome, 'failed');
        assert.equal(pending.find(row => row.interaction_id === uncertain.id).outcome, 'unconfirmed');
    });
});
