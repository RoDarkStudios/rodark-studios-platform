const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits: P } = require('discord.js');
const { compileBlueprint, buildPlan, clone, snapshotHash, channelBody, onboardingBody } = require('./server-blueprint');
const { captureSnapshot, applyPlan, createInfrastructureWorker, controlWithLayout } = require('./server-infrastructure');

const GUILD = '849976422135103498', BOT = '100000000000000001', OWNER = '100000000000000002', BLOXLINK = '100000000000000003';
const control = { guildId: GUILD, desiredEnabled: true, levelSystem: { enabled: true, attachmentUnlockLevel: 5 } };
const error404 = () => Object.assign(new Error('Unknown Discord object'), { status: 404 });

function fakeDiscord() {
    let sequence = 200000000000000000n;
    const id = () => String(++sequence);
    const role = (name, position, permissions = '0', extra = {}) => ({ id: id(), name, position, permissions, color: 0, hoist: false, mentionable: false, managed: false, ...extra });
    const everyone = role('@everyone', 0, '0', { id: GUILD });
    const owner = role('Owner', 30, '8', { color: 0xf97316, hoist: true });
    const bot = role('RoDark Studios Bot', 20, '8', { managed: true, tags: { bot_id: BOT } });
    const bloxlink = role('Bloxlink', 15, '8', { managed: true, tags: { bot_id: BLOXLINK } });
    const staff = role('Staff', 12), member = role('Member', 5), creator = role('Content Creator', 10);
    const booster = role('Server Booster', 9, '0', { managed: true, tags: { premium_subscriber: null } });
    const obsolete = role('Developer', 11);
    const server = {
        guild: { id: GUILD, name: 'Old server', owner_id: OWNER, features: ['COMMUNITY'], verification_level: 0, explicit_content_filter: 0,
            default_message_notifications: 0, rules_channel_id: null, public_updates_channel_id: null, safety_alerts_channel_id: null },
        roles: [everyone, owner, bot, bloxlink, staff, member, creator, booster, obsolete], channels: [],
        members: { [BOT]: { user: { id: BOT }, roles: [bot.id] }, [BLOXLINK]: { user: { id: BLOXLINK }, roles: [bloxlink.id] } },
        onboarding: { enabled: true, mode: 0, prompts: [], default_channel_ids: [] }, autoMod: [{ id: id(), name: 'Old swear filter' }],
        writes: [], messages: new Map(), failAfter: null
    };
    const addChannel = (data) => {
        const channel = { id: id(), guild_id: GUILD, type: 0, parent_id: null, position: server.channels.length, topic: '', nsfw: false,
            permission_overwrites: [], rate_limit_per_user: 0, ...clone(data) };
        if (channel.available_tags) channel.available_tags = channel.available_tags.map((tag) => ({ ...tag, id: tag.id || id() }));
        server.channels.push(channel); server.messages.set(channel.id, []); return channel;
    };
    const oldCategory = addChannel({ name: 'Old category', type: 4 });
    const oldRules = addChannel({ name: 'rules', parent_id: oldCategory.id });
    addChannel({ name: 'verify-with-bloxlink', parent_id: oldCategory.id });
    addChannel({ name: 'general-chat', parent_id: oldCategory.id });
    server.guild.rules_channel_id = oldRules.id;
    server.guild.public_updates_channel_id = oldRules.id;
    server.messages.get(oldRules.id).push('Old rules history');
    const get = async (path) => {
        if (path === `/guilds/${GUILD}`) return clone(server.guild);
        if (path === `/guilds/${GUILD}/roles`) return clone(server.roles);
        if (path === `/guilds/${GUILD}/channels`) return clone(server.channels);
        if (path === `/guilds/${GUILD}/onboarding`) return clone(server.onboarding);
        if (path === `/guilds/${GUILD}/auto-moderation/rules`) return clone(server.autoMod);
        if (path.startsWith(`/guilds/${GUILD}/members/`)) return clone(server.members[path.split('/').at(-1)] || (() => { throw error404(); })());
        if (path.startsWith('/channels/')) return clone(server.channels.find((channel) => channel.id === path.split('/')[2]) || (() => { throw error404(); })());
        throw new Error(`Unexpected read ${path}`);
    };
    const write = (method) => async (path, { body } = {}) => {
        server.writes.push({ method, path, body: clone(body || null) });
        if (server.failAfter === server.writes.length) throw new Error('Simulated Discord interruption');
        if (path === `/guilds/${GUILD}/roles` && method === 'post') {
            server.roles.forEach((item) => { if (item.position) item.position++; });
            const result = role(body.name, 1, body.permissions, body); server.roles.push(result); return clone(result);
        }
        if (path === `/guilds/${GUILD}/roles` && method === 'patch') {
            for (const entry of body) server.roles.find((item) => item.id === entry.id).position = entry.position;
            return clone(server.roles);
        }
        if (path.includes('/roles/')) {
            const roleId = path.split('/').at(-1), existing = server.roles.find((item) => item.id === roleId);
            if (!existing) throw error404();
            if (method === 'delete') { server.roles = server.roles.filter((item) => item.id !== roleId); return; }
            Object.assign(existing, clone(body)); return clone(existing);
        }
        if (path === `/guilds/${GUILD}/channels` && method === 'post') {
            if (body.parent_id && !server.channels.some((channel) => channel.id === body.parent_id && channel.type === 4)) throw new Error('Parent missing');
            if ([5, 15].includes(body.type) && !server.guild.features.includes('COMMUNITY')) throw new Error('Community must be enabled first');
            return clone(addChannel(body));
        }
        if (path === `/guilds/${GUILD}/channels` && method === 'patch') {
            for (const entry of body) Object.assign(server.channels.find((item) => item.id === entry.id), entry);
            return;
        }
        if (path.startsWith('/channels/')) {
            const channelId = path.split('/')[2], existing = server.channels.find((item) => item.id === channelId);
            if (!existing) throw error404();
            if (method === 'delete') {
                if ([server.guild.rules_channel_id, server.guild.public_updates_channel_id].includes(channelId)) throw new Error('Cannot delete configured Community channel');
                server.channels = server.channels.filter((item) => item.id !== channelId);
                server.messages.delete(channelId); return;
            }
            Object.assign(existing, clone(body));
            if (body.available_tags) existing.available_tags = body.available_tags.map((tag) => ({ ...tag, id: tag.id || id() }));
            return clone(existing);
        }
        if (path === `/guilds/${GUILD}` && method === 'patch') { Object.assign(server.guild, clone(body)); return clone(server.guild); }
        if (path === `/guilds/${GUILD}/onboarding` && method === 'put') {
            Object.assign(server.onboarding, clone(body));
            if (body.prompts) server.onboarding.prompts = body.prompts.map((prompt) => ({ ...prompt, id: prompt.id || id(), options: prompt.options.map((option) => ({ ...option, id: option.id || id() })) }));
            return clone(server.onboarding);
        }
        if (path.includes('/auto-moderation/rules/') && method === 'delete') { server.autoMod = server.autoMod.filter((rule) => rule.id !== path.split('/').at(-1)); return; }
        if (path.includes('/members/') && method === 'delete') {
            const memberId = path.split('/').at(-1); delete server.members[memberId]; server.roles = server.roles.filter((item) => item.tags?.bot_id !== memberId); return;
        }
        throw new Error(`Unexpected write ${method} ${path}`);
    };
    return { server, addChannel, ids: { owner: owner.id, bot: bot.id, staff: staff.id, member: member.id, creator: creator.id },
        rest: { get, post: write('post'), patch: write('patch'), put: write('put'), delete: write('delete') } };
}

async function deploy(fake, state = {}, blueprint = compileBlueprint(control), tickets = []) {
    const snapshot = await captureSnapshot(fake.rest, GUILD, BOT, blueprint.spec);
    const plan = buildPlan(blueprint, snapshot, state, tickets);
    assert.deepEqual(plan.errors, []);
    const bindings = await applyPlan({ blueprint, plan, snapshot, rest: fake.rest, saveResources: async () => {}, finishContent: async () => {},
        closeTicket: async () => {}, progress: async () => {}, guard: () => {} });
    return { plan, state: { initialized: true, resources: bindings, active: { version: blueprint.version, spec: blueprint.spec, bindings } } };
}

function effective(blueprint, channelKey, keys) {
    const roleIds = Object.fromEntries(blueprint.roles.map((role) => [role.key, role.key]));
    let bits = BigInt(blueprint.everyonePermissions);
    for (const key of keys) bits |= BigInt(blueprint.roles.find((role) => role.key === key).permissions);
    const channel = channelBody(blueprint.channels.find((channel) => channel.key === channelKey), { role: roleIds, channel: Object.fromEntries(blueprint.channels.map((channel) => [channel.key, channel.key])) });
    const everyone = channel.permission_overwrites.find((entry) => entry.id === GUILD);
    if (everyone) bits = (bits & ~BigInt(everyone.deny)) | BigInt(everyone.allow);
    let allow = 0n, deny = 0n;
    for (const entry of channel.permission_overwrites.filter((item) => keys.includes(item.id))) { allow |= BigInt(entry.allow); deny |= BigInt(entry.deny); }
    return (bits & ~deny) | allow;
}

test('the agreed layout has 10 categories, 42 channels, all three game sets, exact separator and ticket help', () => {
    const blueprint = compileBlueprint(control);
    assert.equal(blueprint.channels.filter((channel) => channel.type === 4).length, 10);
    assert.equal(blueprint.channels.filter((channel) => channel.type !== 4).length, 42);
    assert.equal(blueprint.channels.find((channel) => channel.key === 'help').name, '🎫・help');
    for (const game of blueprint.spec.games) assert.equal(blueprint.channels.filter((channel) => channel.game === game.key).length, 7);
    assert.equal(blueprint.channels.find((channel) => channel.key === 'category:ignore').position, 0);
    assert.equal(blueprint.roles.filter((role) => role.key.startsWith('level-')).length, 7);
});

test('Staff can moderate members and messages but cannot change infrastructure or owner-only forum status tags', () => {
    const blueprint = compileBlueprint(control), staff = BigInt(blueprint.roles.find((role) => role.key === 'staff').permissions);
    for (const permission of [P.KickMembers, P.BanMembers, P.ModerateMembers, P.ManageMessages, P.MoveMembers]) assert.ok(staff & permission);
    for (const permission of [P.Administrator, P.ManageChannels, P.ManageGuild, P.ManageRoles, P.ManageWebhooks, P.ManageThreads]) assert.equal(staff & permission, 0n);
    for (const key of ['staff-info', 'rules', 'level-ups', 'moderation-log']) {
        const value = effective(blueprint, key, ['staff']);
        assert.ok(value & P.ViewChannel);
        assert.equal(value & (P.SendMessages | P.ManageMessages), 0n);
    }
    assert.equal(effective(blueprint, 'animal-tag/bug-reports', ['staff']) & P.ManageThreads, 0n);
    assert.equal(effective(blueprint, 'staff-chat', ['member']) & P.ViewChannel, 0n);
});

test('creator-only posting, owner-started discussions, media uploads and the existing level preview gate compose correctly', () => {
    const blueprint = compileBlueprint(control);
    assert.equal(effective(blueprint, 'animal-tag/youtube-videos', ['member']) & P.SendMessages, 0n);
    assert.ok(effective(blueprint, 'animal-tag/youtube-videos', ['creator']) & P.SendMessages);
    assert.equal(effective(blueprint, 'animal-tag/chat', ['level-100']) & P.AttachFiles, 0n);
    assert.ok(effective(blueprint, 'animal-tag/media', ['member']) & P.AttachFiles);
    assert.equal(effective(blueprint, 'animal-tag/chat', ['member']) & P.EmbedLinks, 0n);
    assert.ok(effective(blueprint, 'animal-tag/chat', ['level-5']) & P.EmbedLinks);
    assert.equal(effective(blueprint, 'animal-tag/dev-discussions', ['staff']) & P.SendMessages, 0n);
    assert.ok(effective(blueprint, 'animal-tag/dev-discussions', ['member']) & P.SendMessagesInThreads);
    const changed = compileBlueprint({ ...control, levelSystem: { attachmentUnlockLevel: 25 } });
    assert.equal(BigInt(changed.roles.find((role) => role.key === 'level-15').permissions) & P.EmbedLinks, 0n);
    assert.ok(BigInt(changed.roles.find((role) => role.key === 'level-25').permissions) & P.EmbedLinks);
});

test('native onboarding selects games without access locks, meets public-channel requirements and never offers the honeypot', () => {
    const blueprint = compileBlueprint(control), bindings = { role: {}, channel: {} };
    blueprint.roles.forEach((role) => { bindings.role[role.key] = role.key; });
    blueprint.channels.forEach((channel) => { bindings.channel[channel.key] = channel.key; });
    const body = onboardingBody(blueprint, bindings);
    assert.equal(body.mode, 1);
    assert.ok(body.default_channel_ids.length >= 7);
    assert.equal(body.prompts[0].single_select, false);
    assert.equal(body.prompts[1].required, false);
    const offered = [...body.default_channel_ids, ...body.prompts.flatMap((prompt) => prompt.options.flatMap((option) => option.channel_ids))];
    assert.ok(!offered.includes('honeypot'));
    assert.ok(new Set(offered.filter((key) => {
        const bits = effective(blueprint, key, []);
        return (bits & (P.ViewChannel | P.SendMessages)) === (P.ViewChannel | P.SendMessages);
    })).size >= 5);
    for (const option of body.prompts[0].options) assert.ok(option.role_ids.includes('member'));
});

test('initial deployment removes every old channel and unlisted role, removes Bloxlink, and preserves member/creator/staff role identities', async () => {
    const fake = fakeDiscord(), oldChannels = fake.server.channels.map((channel) => channel.id);
    const { state, plan } = await deploy(fake);
    assert.equal(plan.initial, true);
    assert.ok(oldChannels.every((id) => !fake.server.channels.some((channel) => channel.id === id) && !fake.server.messages.has(id)));
    assert.ok(!fake.server.roles.some((role) => role.name === 'Developer' || role.name === 'Bloxlink'));
    assert.equal(fake.server.members[BLOXLINK], undefined);
    for (const key of ['owner', 'bot', 'staff', 'member', 'creator']) assert.equal(state.resources.role[key], fake.ids[key]);
    assert.equal(fake.server.channels.length, compileBlueprint(control).channels.length);
    const trapCreate = fake.server.writes.find((entry) => entry.method === 'post' && entry.body?.name === 'ignore│do-not-type');
    assert.ok(BigInt(trapCreate.body.permission_overwrites[0].deny) & P.SendMessages);
});

test('a completed deployment is idempotent and later channel edits preserve channel IDs and messages', async () => {
    const fake = fakeDiscord();
    const first = await deploy(fake);
    const baseline = compileBlueprint(control);
    const snapshot = await captureSnapshot(fake.rest, GUILD, BOT, baseline.spec);
    const noChanges = buildPlan(baseline, snapshot, first.state);
    assert.deepEqual(noChanges.operations, []);
    const retainedId = first.state.resources.channel['general-chat'];
    fake.server.messages.get(retainedId).push('Keep this conversation');
    const spec = clone(baseline.spec);
    spec.categories.find((category) => category.key === 'general').channels[0].name = '💬・community-chat';
    const next = await deploy(fake, first.state, compileBlueprint(control, spec));
    assert.equal(next.plan.initial, false);
    assert.equal(next.state.resources.channel['general-chat'], retainedId);
    assert.deepEqual(fake.server.messages.get(retainedId), ['Keep this conversation']);
    assert.ok(!next.plan.operations.some((op) => op.kind === 'delete_channel'));
});

test('removing a channel and role from the file removes previously managed resources without touching retained history', async () => {
    const fake = fakeDiscord(), first = await deploy(fake), spec = clone(first.state.active.spec);
    const oldMeme = first.state.resources.channel.memes, oldCreator = first.state.resources.role.creator;
    spec.categories.find((category) => category.key === 'general').channels = spec.categories.find((category) => category.key === 'general').channels.filter((channel) => channel.key !== 'memes');
    spec.onboarding.defaultChannels = spec.onboarding.defaultChannels.filter((key) => key !== 'memes');
    // Retiring a notification role exercises deletion without breaking a channel's required creator role.
    const retired = first.state.resources.role['ping-polls']; spec.notifications = spec.notifications.filter((notice) => notice.key !== 'polls');
    const next = await deploy(fake, first.state, compileBlueprint(control, spec));
    assert.ok(next.plan.operations.some((op) => op.kind === 'delete_channel' && op.id === oldMeme));
    assert.ok(next.plan.operations.some((op) => op.kind === 'delete_role' && op.id === retired));
    assert.ok(fake.server.roles.some((role) => role.id === oldCreator));
    assert.ok(!fake.server.channels.some((channel) => channel.id === oldMeme));
});

test('registered open tickets survive later deployments; arbitrary manual channels are removed', async () => {
    const fake = fakeDiscord(), first = await deploy(fake), blueprint = compileBlueprint(control);
    const ticket = fake.addChannel({ name: '🎫・ticket-1', parent_id: first.state.resources.channel['category:tickets'] });
    const extra = fake.addChannel({ name: 'unlisted', parent_id: first.state.resources.channel['category:tickets'] });
    fake.server.messages.get(ticket.id).push('Private support conversation');
    const next = await deploy(fake, first.state, blueprint, [ticket.id]);
    assert.ok(!next.plan.operations.some((op) => op.id === ticket.id));
    assert.ok(next.plan.operations.some((op) => op.kind === 'delete_channel' && op.id === extra.id));
    assert.deepEqual(fake.server.messages.get(ticket.id), ['Private support conversation']);
});

test('forum tag and onboarding question renames preserve their identities', async () => {
    const fake = fakeDiscord(), first = await deploy(fake), spec = clone(first.state.active.spec);
    const tagId = first.state.resources.tag['animal-tag/bug-reports/fixed'];
    const questionId = first.state.resources.prompt.games;
    spec.gameChannels.find((channel) => channel.key === 'bug-reports').tags.find((tag) => tag.key === 'fixed').name = 'Resolved';
    spec.onboarding.gamesQuestion = 'Pick your games';
    const next = await deploy(fake, first.state, compileBlueprint(control, spec));
    assert.equal(next.state.resources.tag['animal-tag/bug-reports/fixed'], tagId);
    assert.equal(next.state.resources.prompt.games, questionId);
});

test('preflight blocks owner hierarchy problems and unremovable Bloxlink before any mutation', async () => {
    const fake = fakeDiscord(), blueprint = compileBlueprint(control);
    fake.server.roles.find((role) => role.name === 'Bloxlink').position = 99;
    fake.server.roles.find((role) => role.name === 'Owner').permissions = '0';
    const plan = buildPlan(blueprint, await captureSnapshot(fake.rest, GUILD, BOT, blueprint.spec));
    assert.ok(plan.errors.some((error) => error.includes('Owner')));
    assert.ok(plan.errors.some((error) => error.includes('Bloxlink')));
    assert.equal(fake.server.writes.length, 0);
});

test('snapshot refresh detects permission drift but ignores messages and legitimate ticket creation after initial rebuild', async () => {
    const fake = fakeDiscord(), first = await deploy(fake), blueprint = compileBlueprint(control);
    const before = await captureSnapshot(fake.rest, GUILD, BOT, blueprint.spec);
    const beforeHash = snapshotHash(before);
    const ticket = fake.addChannel({ name: '🎫・ticket-2', parent_id: first.state.resources.channel['category:tickets'] });
    const after = await captureSnapshot(fake.rest, GUILD, BOT, blueprint.spec);
    assert.equal(snapshotHash(after, [ticket.id]), beforeHash);
    fake.server.channels.find((channel) => channel.id === first.state.resources.channel['staff-info']).permission_overwrites = [];
    const drift = await captureSnapshot(fake.rest, GUILD, BOT, blueprint.spec);
    assert.notEqual(snapshotHash(drift, [ticket.id]), beforeHash);
    assert.ok(buildPlan(blueprint, drift, first.state, [ticket.id]).operations.some((op) => op.key === 'staff-info'));
});

function memoryStore() {
    const state = { initialized: false, maintenance: false, resources: { role: {}, channel: {} }, active: null };
    const jobs = [];
    return { state, jobs, getState: async () => clone(state), withGuildLock: async (_id, callback) => { await callback({ assertHeld() {} }); return true; },
        recoverInterrupted: async () => { for (const job of jobs) if (['previewing', 'applying'].includes(job.status)) job.status = 'failed'; },
        claimJob: async () => { const job = jobs.find((item) => ['preview_queued', 'deploy_queued'].includes(item.status)); if (!job) return null;
            job.status = job.status === 'preview_queued' ? 'previewing' : 'applying'; return clone(job); },
        openTicketIds: async () => [], ready: async (id, plan, autoApply = false) => Object.assign(jobs.find((job) => job.id === id), { status: autoApply ? 'deploy_queued' : 'ready', plan, expires_at: new Date(Date.now() + 60_000).toISOString() }),
        finish: async (id, status, error) => Object.assign(jobs.find((job) => job.id === id), { status, error }),
        progress: async () => {}, beginApply: async (_guild, resources) => Object.assign(state, { maintenance: true, resources: clone(resources) }),
        saveResources: async (_guild, resources) => { state.resources = clone(resources); },
        activate: async (_guild, active, resources) => Object.assign(state, { initialized: true, maintenance: false, active: clone(active), resources: clone(resources) }),
        setDrift: async (_guild, drift) => { state.drift = drift; }
    };
}
function workerFor(fake, store) {
    const client = { rest: fake.rest, isReady: () => true, user: { id: BOT }, guilds: { cache: new Map([[GUILD, {}]]) } };
    return createInfrastructureWorker(client, { store, finishContent: async () => {}, closeTicket: async () => {}, logger: { error() {} } });
}
function queue(store, name) { const job = { id: name, version: compileBlueprint(control).version, status: 'preview_queued', actor: { id: 'owner' } }; store.jobs.push(job); return job; }

test('worker previews make no Discord writes and a stale approved preview never deploys', async () => {
    const fake = fakeDiscord(), store = memoryStore(), worker = workerFor(fake, store), job = queue(store, 'preview');
    await worker.tick(control);
    assert.equal(job.status, 'ready'); assert.equal(fake.server.writes.length, 0);
    fake.server.channels[0].name = 'Changed after preview'; job.status = 'deploy_queued';
    await worker.tick(control);
    assert.equal(job.status, 'stale'); assert.equal(fake.server.writes.length, 0); assert.equal(store.state.maintenance, false);
});

test('one deploy request prepares and applies without another browser request; blockers cause no writes', async () => {
    const fake = fakeDiscord(), store = memoryStore(), worker = workerFor(fake, store), job = queue(store, 'single-click');
    job.auto_apply = true;
    await worker.tick(control);
    assert.equal(job.status, 'deploy_queued'); assert.equal(fake.server.writes.length, 0);
    await worker.tick(control);
    assert.equal(job.status, 'succeeded', job.error); assert.equal(store.state.initialized, true);
    const retained = clone(store.state.resources.channel);
    const again = queue(store, 'unchanged'); again.auto_apply = true;
    const writes = fake.server.writes.length;
    await worker.tick(control);
    assert.equal(again.status, 'succeeded'); assert.equal(fake.server.writes.length, writes);
    assert.deepEqual(store.state.resources.channel, retained);

    const blocked = fakeDiscord(), blockedStore = memoryStore(), blockedJob = queue(blockedStore, 'blocked');
    blockedJob.auto_apply = true;
    blocked.server.roles.find((role) => role.name === 'Owner').permissions = '0';
    await workerFor(blocked, blockedStore).tick(control);
    assert.equal(blockedJob.status, 'failed'); assert.match(blockedJob.error, /Owner/);
    assert.equal(blocked.server.writes.length, 0);
});

test('interrupted rebuilds checkpoint new IDs; a fresh preview finishes without wiping newly retained channels', async () => {
    const fake = fakeDiscord(), store = memoryStore(), worker = workerFor(fake, store), first = queue(store, 'first');
    await worker.tick(control); first.status = 'deploy_queued'; fake.server.failAfter = 22;
    await worker.tick(control);
    assert.equal(first.status, 'failed'); assert.equal(store.state.maintenance, true);
    const checkpoint = clone(store.state.resources.channel);
    assert.ok(Object.keys(checkpoint).length);
    fake.server.failAfter = null;
    const retry = queue(store, 'retry'); await worker.tick(control); retry.status = 'deploy_queued'; await worker.tick(control);
    assert.equal(retry.status, 'succeeded', retry.error);
    assert.equal(store.state.maintenance, false); assert.equal(store.state.initialized, true);
    for (const [key, id] of Object.entries(checkpoint)) assert.equal(store.state.resources.channel[key], id);
    assert.equal(fake.server.channels.length, compileBlueprint(control).channels.length);
});

test('runtime uses the last deployed blueprint and bindings, keeping pending file edits out of live helpers', async () => {
    const fake = fakeDiscord(), { state } = await deploy(fake);
    const runtime = controlWithLayout(control, state.active);
    assert.equal(runtime.ticketSystem.panelChannelId, state.resources.channel.help);
    assert.equal(runtime.levelSystem.announcementChannelId, state.resources.channel['level-ups']);
    assert.equal(runtime.infrastructure.spec.separator, '・');
    assert.equal(runtime.gameUpdates.pingEveryoneEnabled, false);
});

module.exports = { fakeDiscord, memoryStore, workerFor };
