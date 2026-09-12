const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits: P } = require('discord.js');
const { compileBlueprint, buildPlan, clone, snapshotHash, channelBody, onboardingBody, autoModBody } = require('./server-blueprint');
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
        rulesScreening: { description: 'Our existing welcome description', version: 'old', form_fields: [
            { field_type: 'TERMS', label: 'Read and agree to the server rules', required: true, values: ['Be nice'] }
        ] },
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
        if (path === `/guilds/${GUILD}/member-verification`) return clone(server.rulesScreening);
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
        if (path === `/guilds/${GUILD}` && method === 'patch') {
            const applied = clone(body);
            // Observed on the live Community guild: Discord returns 200 but ignores
            // these two assignments unless COMMUNITY is also in the request.
            if (!body.features?.includes('COMMUNITY')) {
                delete applied.rules_channel_id; delete applied.public_updates_channel_id;
            }
            Object.assign(server.guild, applied); return clone(server.guild);
        }
        if (path === `/guilds/${GUILD}/onboarding` && method === 'put') {
            if (body.prompts?.some(prompt => !/^\d{17,20}$/.test(prompt.id || ''))) {
                throw Object.assign(new Error('Invalid Form Body: prompts[].id is required'), { status: 400, code: 50035 });
            }
            const previousIds = new Set(server.onboarding.prompts.map(prompt => prompt.id));
            Object.assign(server.onboarding, clone(body));
            if (body.prompts) server.onboarding.prompts = body.prompts.map((prompt) => ({ ...prompt,
                // Discord requires an ID in the request but assigns its own ID to new prompts.
                id: previousIds.has(prompt.id) ? prompt.id : id(),
                options: prompt.options.map((option) => ({ ...option, id: option.id || id() })) }));
            return clone(server.onboarding);
        }
        if (path === `/guilds/${GUILD}/member-verification` && method === 'patch') {
            assert.deepEqual(Object.keys(body), ['form_fields'], 'Do not change unrelated screening settings');
            server.rulesScreening.form_fields = clone(body.form_fields);
            server.rulesScreening.version = 'updated';
            return clone(server.rulesScreening);
        }
        if (path === `/guilds/${GUILD}/auto-moderation/rules` && method === 'post') {
            const rule = { id: id(), ...clone(body) }; server.autoMod.push(rule); return clone(rule);
        }
        if (path.includes('/auto-moderation/rules/')) {
            const rule = server.autoMod.find(item => item.id === path.split('/').at(-1));
            if (!rule) throw error404();
            if (method === 'delete') {
                if (rule.trigger_type === 5 && server.guild.features.includes('COMMUNITY')) {
                    throw Object.assign(new Error('Community Mention Spam rules cannot be deleted'), { status: 404, code: 0 });
                }
                server.autoMod = server.autoMod.filter(item => item.id !== rule.id); return;
            }
            if (method === 'patch') { Object.assign(rule, clone(body)); return clone(rule); }
        }
        if (path.includes('/members/') && method === 'delete') {
            const memberId = path.split('/').at(-1); delete server.members[memberId]; server.roles = server.roles.filter((item) => item.tags?.bot_id !== memberId); return;
        }
        throw new Error(`Unexpected write ${method} ${path}`);
    };
    return { server, addChannel, ids: { owner: owner.id, bot: bot.id, staff: staff.id, member: member.id, creator: creator.id },
        rest: { get, post: write('post'), patch: write('patch'), put: write('put'), delete: write('delete') } };
}

async function deploy(fake, state = {}, blueprint = compileBlueprint(control), tickets = [], options = {}) {
    const snapshot = await captureSnapshot(fake.rest, GUILD, BOT, blueprint.spec);
    const plan = buildPlan(blueprint, snapshot, state, tickets);
    assert.deepEqual(plan.errors, []);
    const bindings = await applyPlan({ blueprint, plan, snapshot, rest: fake.rest, saveResources: async () => {}, finishContent: async () => {},
        closeTicket: async () => {}, progress: async () => {}, guard: () => {}, ...options });
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
    for (const game of blueprint.spec.games) {
        assert.equal(blueprint.channels.filter((channel) => channel.game === game.key).length, 7);
        assert.equal(blueprint.channels.find(channel => channel.key === `category:game-${game.key}`).name, game.name);
    }
    assert.deepEqual(blueprint.channels.filter(channel => channel.type === 4).map(channel => channel.name),
        ['Staff', 'Info', 'IGNORE', 'Tickets', 'Announcements', 'Dig for Eggs', 'Animal Tag', 'My Coding Company', 'General', 'Voice']);
    assert.equal(blueprint.channels.find((channel) => channel.key === 'category:ignore').position, 2);
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
    assert.equal(effective(blueprint, 'staff-chat', []) & P.ViewChannel, 0n);
});

test('creator-only posting, owner-started discussions, media uploads and the existing level preview gate compose correctly', () => {
    const blueprint = compileBlueprint(control);
    assert.equal(effective(blueprint, 'animal-tag/youtube-videos', []) & P.SendMessages, 0n);
    assert.ok(effective(blueprint, 'animal-tag/youtube-videos', ['creator']) & P.SendMessages);
    assert.equal(effective(blueprint, 'animal-tag/chat', ['level-100']) & P.AttachFiles, 0n);
    assert.ok(effective(blueprint, 'animal-tag/media', []) & P.AttachFiles);
    assert.equal(effective(blueprint, 'animal-tag/chat', []) & P.EmbedLinks, 0n);
    assert.ok(effective(blueprint, 'animal-tag/chat', ['level-5']) & P.EmbedLinks);
    assert.equal(effective(blueprint, 'animal-tag/dev-discussions', ['staff']) & P.SendMessages, 0n);
    assert.ok(effective(blueprint, 'animal-tag/dev-discussions', []) & P.SendMessagesInThreads);
    const staleDashboardSetting = compileBlueprint({ ...control, levelSystem: { attachmentUnlockLevel: 25 } });
    assert.equal(staleDashboardSetting.levelUnlock, 5);
    const spec = clone(blueprint.spec);
    spec.levels.attachmentUnlockLevel = 25;
    const changed = compileBlueprint(control, spec);
    assert.equal(BigInt(changed.roles.find((role) => role.key === 'level-15').permissions) & P.EmbedLinks, 0n);
    assert.ok(BigInt(changed.roles.find((role) => role.key === 'level-25').permissions) & P.EmbedLinks);
});

test('onboarding shows all public non-game channels by default and keeps games and notification choices separate', () => {
    const blueprint = compileBlueprint(control), bindings = { role: {}, channel: {} };
    blueprint.roles.forEach((role) => { bindings.role[role.key] = role.key; });
    blueprint.channels.forEach((channel) => { bindings.channel[channel.key] = channel.key; });
    const body = onboardingBody(blueprint, bindings);
    assert.equal(body.mode, 1);
    assert.deepEqual(body.default_channel_ids, ['rules', 'info', 'roles', 'help', 'honeypot', 'announcements', 'game-updates',
        'codes', 'polls-feedback', 'general-chat', 'memes', 'level-ups', 'lounge-1', 'lounge-2', 'duo', 'squad', 'party']);
    assert.equal(body.prompts[0].single_select, false);
    assert.equal(body.prompts[0].required, true);
    assert.equal(body.prompts[1].required, false);
    const offered = [...body.default_channel_ids, ...body.prompts.flatMap((prompt) => prompt.options.flatMap((option) => option.channel_ids))];
    const publicChannels = blueprint.channels.filter(channel => channel.type !== 4 && (effective(blueprint, channel.key, []) & P.ViewChannel));
    assert.deepEqual([...new Set(offered)].sort(), publicChannels.map(channel => channel.key).sort());
    for (const key of ['staff-info', 'staff-chat', 'staff-vc', 'moderation-log', 'category:tickets']) {
        assert.ok(!offered.includes(key));
        assert.equal(effective(blueprint, key, []) & P.ViewChannel, 0n);
    }
    for (const key of ['lounge-1', 'lounge-2', 'duo', 'squad', 'party']) {
        assert.equal(effective(blueprint, key, []) & (P.ViewChannel | P.Connect | P.Speak), P.ViewChannel | P.Connect | P.Speak);
    }
    assert.ok(new Set(offered.filter((key) => {
        const bits = effective(blueprint, key, []);
        return (bits & (P.ViewChannel | P.SendMessages)) === (P.ViewChannel | P.SendMessages);
    })).size >= 5);
    for (const [index, option] of body.prompts[0].options.entries()) {
        const gameKey = blueprint.spec.games[index].key;
        assert.deepEqual(option.role_ids, [`game-${gameKey}`]);
        assert.deepEqual(option.channel_ids, blueprint.channels.filter(channel => channel.game === gameKey).map(channel => channel.key));
        assert.ok(option.channel_ids.every(key => !body.default_channel_ids.includes(key)));
    }
    for (const [index, option] of body.prompts[1].options.entries()) {
        assert.deepEqual(option.role_ids, [`ping-${blueprint.spec.notifications[index].key}`]);
        assert.deepEqual(option.channel_ids, []);
    }
});

test('new shared channels enter onboarding defaults automatically while private channels remain excluded', () => {
    const spec = clone(compileBlueprint(control).spec);
    spec.categories.find(category => category.key === 'general').channels.push(
        { key: 'new-public', name: '💬・new-public', type: 'text', profile: 'readonly' },
        { key: 'new-private', name: '🔒・new-private', type: 'text', profile: 'staff' }
    );
    spec.categories.find(category => category.key === 'voice').channels.push({ key: 'new-voice', name: '🔊・new-voice', type: 'voice' });
    const blueprint = compileBlueprint(control, spec);
    assert.ok(blueprint.defaultChannelKeys.includes('new-public'));
    assert.ok(blueprint.defaultChannelKeys.includes('new-voice'));
    assert.ok(!blueprint.defaultChannelKeys.includes('new-private'));
});

test('legacy onboarding defaults reject private channels, categories, missing channels and duplicates', () => {
    for (const defaults of [['staff-vc'], ['moderation-log'], ['category:info'], ['missing'], ['rules', 'rules'], 'unknown-mode']) {
        const spec = clone(compileBlueprint(control).spec);
        spec.onboarding.defaultChannels = defaults;
        assert.throws(() => compileBlueprint(control, spec), /distinct public channel keys/);
    }
});

test('expanding onboarding defaults preserves channel history and question identities without changing permissions', async () => {
    const fake = fakeDiscord(), blueprint = compileBlueprint(control), oldSpec = clone(blueprint.spec);
    oldSpec.onboarding.defaultChannels = ['rules', 'info', 'roles', 'help', 'announcements', 'game-updates', 'general-chat', 'memes', 'level-ups'];
    const oldBlueprint = compileBlueprint(control, oldSpec);
    const first = await deploy(fake, {}, oldBlueprint);
    assert.deepEqual(oldBlueprint.defaultChannelKeys, oldSpec.onboarding.defaultChannels);
    const channels = clone(fake.server.channels), roles = clone(fake.server.roles), prompts = clone(fake.server.onboarding.prompts);
    const channelId = first.state.resources.channel['general-chat'];
    fake.server.messages.get(channelId).push('Keep this conversation');
    fake.server.writes = [];
    let contentReady = false;
    const put = fake.rest.put;
    fake.rest.put = async (path, options) => {
        if (path.endsWith('/onboarding') && options.body.enabled) assert.equal(contentReady, true, 'Publish the trap warning before exposing it through onboarding');
        return put(path, options);
    };
    const next = await deploy(fake, first.state, blueprint, [], { finishContent: async () => { contentReady = true; } });
    assert.equal(next.plan.initial, false);
    assert.deepEqual(next.plan.operations.map(op => op.kind), ['onboarding', 'content']);
    assert.deepEqual(next.state.resources, first.state.resources);
    assert.deepEqual(fake.server.channels, channels);
    assert.deepEqual(fake.server.roles, roles);
    assert.deepEqual(fake.server.messages.get(channelId), ['Keep this conversation']);
    assert.equal(fake.server.onboarding.enabled, true);
    assert.deepEqual(fake.server.onboarding.prompts, prompts);
    assert.deepEqual(fake.server.onboarding.default_channel_ids, blueprint.defaultChannelKeys.map(key => next.state.resources.channel[key]));
    assert.ok(fake.server.writes.every(write => write.path === `/guilds/${GUILD}/onboarding`));
    const snapshot = await captureSnapshot(fake.rest, GUILD, BOT, blueprint.spec);
    assert.deepEqual(buildPlan(blueprint, snapshot, next.state).operations, []);
});

test('new onboarding prompts have request IDs and persist Discord returned IDs for subsequent updates', async () => {
    const fake = fakeDiscord(), blueprint = compileBlueprint(control);
    const first = await deploy(fake);
    const request = fake.server.writes.find(write => write.body?.prompts)?.body;
    assert.equal(new Set(request.prompts.map(prompt => prompt.id)).size, 2);
    for (const prompt of request.prompts) assert.match(prompt.id, /^\d{17,20}$/);
    const returned = fake.server.onboarding;
    assert.equal(returned.enabled, true);
    assert.equal(returned.prompts[0].required, true);
    assert.equal(returned.prompts[1].required, false);
    for (const [index, key] of ['games', 'notifications'].entries()) {
        assert.notEqual(request.prompts[index].id, returned.prompts[index].id);
        assert.equal(first.state.resources.prompt[key], returned.prompts[index].id);
    }
    const next = onboardingBody(blueprint, first.state.resources, returned);
    assert.deepEqual(next.prompts.map(prompt => prompt.id), returned.prompts.map(prompt => prompt.id));
    assert.deepEqual(next.prompts.map(prompt => prompt.options.map(option => option.id)),
        returned.prompts.map(prompt => prompt.options.map(option => option.id)));
    const snapshot = await captureSnapshot(fake.rest, GUILD, BOT, blueprint.spec);
    assert.deepEqual(buildPlan(blueprint, snapshot, first.state).operations, []);
});

test('Discord reordering default onboarding channels does not trigger another deployment or invalidate its snapshot', async () => {
    const fake = fakeDiscord(), first = await deploy(fake), blueprint = compileBlueprint(control);
    const before = await captureSnapshot(fake.rest, GUILD, BOT, blueprint.spec);
    fake.server.onboarding.default_channel_ids.reverse();
    const after = await captureSnapshot(fake.rest, GUILD, BOT, blueprint.spec);
    assert.equal(snapshotHash(after), snapshotHash(before));
    assert.deepEqual(buildPlan(blueprint, after, first.state).operations, []);
    fake.server.onboarding.default_channel_ids.pop();
    const missingChannel = await captureSnapshot(fake.rest, GUILD, BOT, blueprint.spec);
    assert.ok(buildPlan(blueprint, missingChannel, first.state).operations.some(op => op.kind === 'onboarding'));
});

test('adding Rules Screening sync to a deployed server changes only acceptance text and bot content, preserving history and questions', async () => {
    const fake = fakeDiscord(), spec = clone(compileBlueprint(control).spec);
    delete spec.onboarding.syncRulesScreening;
    const first = await deploy(fake, {}, compileBlueprint(control, spec));
    const beforeScreening = clone(fake.server.rulesScreening), beforeOnboarding = clone(fake.server.onboarding);
    const channelId = first.state.resources.channel['general-chat'];
    fake.server.messages.get(channelId).push('Keep this conversation');
    fake.server.writes.length = 0;
    const blueprint = compileBlueprint(control);
    let published = false;
    const next = await deploy(fake, first.state, blueprint, [], { finishContent: async active => {
        assert.deepEqual(fake.server.rulesScreening.form_fields[0].values, active.spec.content.rules);
        published = true;
    } });
    assert.deepEqual(next.plan.operations.map(op => op.kind), ['rules_screening', 'content']);
    assert.equal(published, true);
    assert.equal(fake.server.writes.length, 1);
    assert.equal(fake.server.writes[0].path, `/guilds/${GUILD}/member-verification`);
    assert.equal(fake.server.rulesScreening.description, beforeScreening.description);
    assert.deepEqual(fake.server.onboarding, beforeOnboarding);
    assert.deepEqual(next.state.resources, first.state.resources);
    assert.deepEqual(fake.server.messages.get(channelId), ['Keep this conversation']);
    const snapshot = await captureSnapshot(fake.rest, GUILD, BOT, blueprint.spec);
    assert.deepEqual(buildPlan(blueprint, snapshot, next.state).operations, []);

    const changed = clone(blueprint.spec); changed.content.rules = ['A revised first rule.', 'Listen to staff.'];
    await deploy(fake, next.state, compileBlueprint(control, changed), [], { finishContent: async active => {
        assert.deepEqual(fake.server.rulesScreening.form_fields[0].values, active.spec.content.rules);
    } });
    assert.deepEqual(fake.server.rulesScreening.form_fields[0].values, changed.content.rules);
});

test('screening drift detects changed or optional acceptance rules but ignores server-owned version and description', async () => {
    const fake = fakeDiscord(), first = await deploy(fake), blueprint = compileBlueprint(control);
    const before = await captureSnapshot(fake.rest, GUILD, BOT, blueprint.spec);
    fake.server.rulesScreening.version = 'another Discord timestamp';
    fake.server.rulesScreening.description = 'An owner edited this description';
    const after = await captureSnapshot(fake.rest, GUILD, BOT, blueprint.spec);
    assert.equal(snapshotHash(before), snapshotHash(after));
    assert.deepEqual(buildPlan(blueprint, after, first.state).operations, []);
    for (const update of [{ values: ['A manual rule edit'] }, { values: blueprint.spec.content.rules, required: false }]) {
        Object.assign(fake.server.rulesScreening.form_fields[0], update);
        const drift = await captureSnapshot(fake.rest, GUILD, BOT, blueprint.spec);
        assert.notEqual(snapshotHash(before), snapshotHash(drift));
        assert.ok(buildPlan(blueprint, drift, first.state).operations.some(op => op.kind === 'rules_screening'));
    }
});

test('legacy deployed definitions do not read or modify Rules Screening before the new definition is deployed', async () => {
    const fake = fakeDiscord(), spec = clone(compileBlueprint(control).spec), before = clone(fake.server.rulesScreening);
    delete spec.onboarding.syncRulesScreening;
    const get = fake.rest.get;
    fake.rest.get = async path => {
        assert.ok(!path.endsWith('/member-verification'), 'Do not depend on screening for a legacy definition');
        return get(path);
    };
    await deploy(fake, {}, compileBlueprint(control, spec));
    assert.deepEqual(fake.server.rulesScreening, before);
    assert.ok(fake.server.writes.every(write => !write.path.endsWith('/member-verification')));
});

test('a generic Discord 404 does not count as a successfully deleted AutoMod rule', async () => {
    const fake = fakeDiscord(), remove = fake.rest.delete;
    const rule = fake.server.autoMod[0]; rule.enabled = true;
    fake.rest.delete = async (path, options) => {
        if (path.endsWith(`/auto-moderation/rules/${rule.id}`)) throw Object.assign(new Error('404: Not Found'), { status: 404, code: 0 });
        return remove(path, options);
    };
    await assert.rejects(deploy(fake), /Remove unlisted native AutoMod rule: Old swear filter failed/);
    assert.ok(fake.server.autoMod.some(item => item.id === rule.id));
});

test('deployment enables mention protection, deletes word filters and finishes idempotently', async () => {
    const fake = fakeDiscord(), blueprint = compileBlueprint(control);
    const rule = { id: '1030554520465440818', name: 'Block Mention Spam', trigger_type: 5, enabled: false };
    fake.server.autoMod.push(rule);
    const first = await deploy(fake);
    assert.ok(first.plan.operations.some(op => op.kind === 'automod' && op.id === rule.id));
    assert.ok(!fake.server.writes.some(write => write.method === 'delete' && write.path.endsWith(`/rules/${rule.id}`)));
    assert.deepEqual(fake.server.autoMod, [{ id: rule.id, ...autoModBody(blueprint.spec.autoModerationRules[0]) }]);
    const snapshot = await captureSnapshot(fake.rest, GUILD, BOT, blueprint.spec);
    assert.deepEqual(buildPlan(blueprint, snapshot, first.state).operations, []);
    rule.trigger_metadata.mention_total_limit = 1;
    const changed = await captureSnapshot(fake.rest, GUILD, BOT, blueprint.spec);
    assert.ok(buildPlan(blueprint, changed, first.state).operations.some(op => op.kind === 'automod'));
});

test('an already disabled Community rule is retained without any rule writes', async () => {
    const fake = fakeDiscord();
    const spec = clone(compileBlueprint(control).spec); spec.autoModerationRules = [{ triggerType: 5, enabled: false }];
    fake.server.autoMod = [{ id: '1030554520465440818', name: 'Renamed mention rule', trigger_type: 5, enabled: false }];
    await deploy(fake, {}, compileBlueprint(control, spec));
    assert.ok(!fake.server.writes.some(write => write.path.includes('/auto-moderation/')));
    assert.equal(fake.server.autoMod[0].enabled, false);
});

test('a refused native protection update still blocks deployment instead of claiming success', async () => {
    const fake = fakeDiscord(), patch = fake.rest.patch;
    fake.server.autoMod = [{ id: '1030554520465440818', name: 'Block Mention Spam', trigger_type: 5, enabled: true }];
    fake.rest.patch = async (path, options) => {
        if (path.includes('/auto-moderation/rules/')) throw Object.assign(new Error('404: Not Found'), { status: 404, code: 0 });
        return patch(path, options);
    };
    await assert.rejects(deploy(fake), /Check this rule in Discord Server Settings/);
    assert.equal(fake.server.autoMod[0].enabled, true);
});

test('missing mention protection is created with only blocking and raid protection, then retained without writes', async () => {
    const fake = fakeDiscord(), blueprint = compileBlueprint(control);
    fake.server.autoMod = [];
    const first = await deploy(fake);
    const rule = fake.server.autoMod[0];
    assert.equal(rule.enabled, true);
    assert.deepEqual(rule.trigger_metadata, { mention_total_limit: 20, mention_raid_protection_enabled: true });
    assert.deepEqual(rule.actions, [{ type: 1 }]);
    // Discord may return empty metadata on actions even when the request omitted it.
    rule.actions[0].metadata = {};
    const snapshot = await captureSnapshot(fake.rest, GUILD, BOT, blueprint.spec);
    assert.deepEqual(buildPlan(blueprint, snapshot, first.state).operations, []);
    fake.server.writes = [];
    await deploy(fake, first.state);
    assert.deepEqual(fake.server.writes, []);
});

test('initial deployment removes every old channel and unlisted role, removes Bloxlink, and preserves creator/staff role identities', async () => {
    const fake = fakeDiscord(), oldChannels = fake.server.channels.map((channel) => channel.id);
    const { state, plan } = await deploy(fake);
    assert.equal(plan.initial, true);
    assert.ok(oldChannels.every((id) => !fake.server.channels.some((channel) => channel.id === id) && !fake.server.messages.has(id)));
    assert.ok(!fake.server.roles.some((role) => role.name === 'Developer' || role.name === 'Bloxlink'));
    assert.equal(fake.server.members[BLOXLINK], undefined);
    for (const key of ['owner', 'bot', 'staff', 'creator']) assert.equal(state.resources.role[key], fake.ids[key]);
    assert.ok(!fake.server.roles.some(role => role.id === fake.ids.member));
    assert.equal(state.resources.role.member, undefined);
    assert.equal(fake.server.channels.length, compileBlueprint(control).channels.length);
    const trapCreate = fake.server.writes.find((entry) => entry.method === 'post' && entry.body?.name === 'ignore│do-not-type');
    assert.ok(BigInt(trapCreate.body.permission_overwrites[0].deny) & P.SendMessages);
});

test('retiring Member removes the role and onboarding references while preserving other roles and channel history', async () => {
    const fake = fakeDiscord(), blueprint = compileBlueprint(control), legacySpec = clone(blueprint.spec);
    legacySpec.roles.push({ key: 'member', name: 'Member', color: '#000000', profile: 'member' });
    const first = await deploy(fake, {}, compileBlueprint(control, legacySpec));
    const memberId = first.state.resources.role.member;
    // Reproduce the previous deployment's onboarding assignments.
    for (const option of fake.server.onboarding.prompts[0].options) option.role_ids.push(memberId);
    const channelId = first.state.resources.channel['general-chat'];
    fake.server.messages.get(channelId).push('Keep this conversation');
    const next = await deploy(fake, first.state, blueprint);
    assert.equal(next.plan.initial, false);
    assert.deepEqual(next.plan.operations.filter(op => op.kind.startsWith('delete_')).map(op => [op.kind, op.id]), [['delete_role', memberId]]);
    assert.ok(!fake.server.roles.some(role => role.id === memberId));
    assert.equal(next.state.resources.role.member, undefined);
    assert.equal(next.state.active.spec.roles.some(role => role.key === 'member'), false);
    for (const [key, id] of Object.entries(first.state.resources.role)) {
        if (key !== 'member') assert.equal(next.state.resources.role[key], id);
    }
    assert.deepEqual(next.state.resources.channel, first.state.resources.channel);
    assert.deepEqual(fake.server.messages.get(channelId), ['Keep this conversation']);
    assert.equal(fake.server.onboarding.enabled, true);
    assert.deepEqual(next.state.resources.prompt, first.state.resources.prompt);
    for (const [index, option] of fake.server.onboarding.prompts[0].options.entries()) {
        assert.deepEqual(option.role_ids, [next.state.resources.role[`game-${blueprint.spec.games[index].key}`]]);
    }
    const snapshot = await captureSnapshot(fake.rest, GUILD, BOT, blueprint.spec);
    assert.deepEqual(buildPlan(blueprint, snapshot, next.state).operations, []);
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

test('an acceptance form edited after preview invalidates deployment before any writes', async () => {
    const fake = fakeDiscord(), store = memoryStore(), worker = workerFor(fake, store), job = queue(store, 'screening-stale');
    await worker.tick(control);
    fake.server.rulesScreening.form_fields[0].values = ['A rule edited in Discord'];
    job.status = 'deploy_queued';
    await worker.tick(control);
    assert.equal(job.status, 'stale');
    assert.equal(fake.server.writes.length, 0);
});

test('screening access errors fail preflight without writes; rejected edits never activate or publish new channel rules', async () => {
    const fake = fakeDiscord(), store = memoryStore();
    const client = { rest: fake.rest, isReady: () => true, user: { id: BOT }, guilds: { cache: new Map([[GUILD, {}]]) } };
    let published = false;
    const worker = createInfrastructureWorker(client, { store, closeTicket: async () => {}, logger: { error() {} },
        finishContent: async () => { published = true; } });
    const get = fake.rest.get;
    fake.rest.get = async path => { if (path.endsWith('/member-verification')) throw new Error('Forbidden'); return get(path); };
    const failedRead = queue(store, 'screening-read'); failedRead.auto_apply = true;
    await worker.tick(control);
    assert.equal(failedRead.status, 'failed'); assert.match(failedRead.error, /Could not read Discord Rules Screening/);
    assert.equal(fake.server.writes.length, 0); assert.equal(store.state.maintenance, false);
    fake.rest.get = get;
    const patch = fake.rest.patch;
    fake.rest.patch = async (path, options) => {
        if (path.endsWith('/member-verification')) throw new Error('Bots cannot use this endpoint');
        return patch(path, options);
    };
    const failedEdit = queue(store, 'screening-edit'); failedEdit.auto_apply = true;
    await worker.tick(control); await worker.tick(control);
    assert.equal(failedEdit.status, 'failed'); assert.match(failedEdit.error, /Could not update Discord Rules Screening/);
    assert.equal(published, false); assert.equal(store.state.active, null); assert.equal(store.state.maintenance, true);
    fake.rest.patch = patch;
    const retry = queue(store, 'screening-retry'); retry.auto_apply = true;
    await worker.tick(control); await worker.tick(control);
    assert.equal(retry.status, 'succeeded', retry.error);
    assert.equal(published, true); assert.equal(store.state.maintenance, false);
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
    assert.deepEqual(runtime.ticketSystem.helperRoleIds, [state.resources.role.staff, state.resources.role.owner]);
    assert.equal(runtime.levelSystem.announcementChannelId, state.resources.channel['level-ups']);
    assert.equal(runtime.levelSystem.enabled, true);
    assert.equal(runtime.levelSystem.attachmentUnlockLevel, 5);
    assert.equal(runtime.levelSystem.mentionLevelUps, false);
    assert.equal(runtime.infrastructure.spec.separator, '・');
    assert.equal(runtime.gameUpdates, undefined);
});

module.exports = { fakeDiscord, memoryStore, workerFor };

test('Community reassignment includes features and preserves live features added after planning', async () => {
    const fake = fakeDiscord(), patch = fake.rest.patch;
    fake.server.guild.features.push('DISCOVERABLE', 'NEWS');
    // A feature can change after the snapshot while roles/channels are being applied.
    fake.rest.patch = async (path, options) => {
        if (path.includes('/roles/')) fake.server.guild.features = [...new Set([...fake.server.guild.features, 'RAID_ALERTS_DISABLED'])];
        return patch(path, options);
    };
    const result = await deploy(fake, {}, compileBlueprint(control), [], { wait: async () => {} });
    const guildWrite = fake.server.writes.find(write => write.path === `/guilds/${GUILD}`);
    assert.deepEqual([...guildWrite.body.features].sort(), ['COMMUNITY', 'DISCOVERABLE', 'NEWS', 'RAID_ALERTS_DISABLED']);
    assert.equal(fake.server.guild.rules_channel_id, result.state.resources.channel.rules);
    assert.equal(fake.server.guild.public_updates_channel_id, result.state.resources.channel['staff-info']);
    assert.ok(fake.server.guild.features.includes('RAID_ALERTS_DISABLED'));
});

test('enabling Community preserves the server existing features', async () => {
    const fake = fakeDiscord();
    fake.server.guild.features = ['INVITES_DISABLED'];
    await deploy(fake, {}, compileBlueprint(control), [], { wait: async () => {} });
    assert.deepEqual([...fake.server.guild.features].sort(), ['COMMUNITY', 'INVITES_DISABLED']);
});

test('Community assignments are read back and repaired before any old channel is deleted', async () => {
    const fake = fakeDiscord(), patch = fake.rest.patch, pauses = [];
    let guildWrites = 0;
    fake.rest.patch = async (path, options) => {
        if (path === `/guilds/${GUILD}` && ++guildWrites === 1) {
            // Reproduce a settings response that has not applied the channel handoff.
            const body = { ...options.body };
            delete body.rules_channel_id; delete body.public_updates_channel_id; delete body.safety_alerts_channel_id;
            return patch(path, { ...options, body });
        }
        return patch(path, options);
    };
    const result = await deploy(fake, {}, compileBlueprint(control), [], { wait: async ms => pauses.push(ms) });
    assert.equal(guildWrites, 2);
    assert.equal(fake.server.guild.rules_channel_id, result.state.resources.channel.rules);
    assert.ok(pauses.length > 0);
    const handoffIndex = fake.server.writes.findIndex(write => write.path === `/guilds/${GUILD}` && Object.keys(write.body).length === 4);
    const firstDelete = fake.server.writes.findIndex(write => write.method === 'delete' && write.path.startsWith('/channels/'));
    assert.ok(handoffIndex >= 0 && firstDelete > handoffIndex);
    assert.equal(fake.server.channels.length, compileBlueprint(control).channels.length);
    const positions = fake.server.writes.find(write => write.method === 'patch' && write.path === `/guilds/${GUILD}/channels`);
    assert.ok(positions.body.every(entry => !Object.hasOwn(entry, 'parent_id')));
});

test('unconfirmed Community assignments stop the rebuild before deletion or information publishing', async () => {
    const fake = fakeDiscord(), patch = fake.rest.patch, originalIds = fake.server.channels.map(channel => channel.id);
    let published = false;
    fake.rest.patch = async (path, options) => {
        if (path !== `/guilds/${GUILD}`) return patch(path, options);
        const body = { ...options.body };
        delete body.rules_channel_id; delete body.public_updates_channel_id; delete body.safety_alerts_channel_id;
        return patch(path, { ...options, body });
    };
    await assert.rejects(deploy(fake, {}, compileBlueprint(control), [], { wait: async () => {}, finishContent: async () => { published = true; } }), /not confirmed/);
    assert.equal(published, false);
    assert.ok(originalIds.every(id => fake.server.channels.some(channel => channel.id === id)));
    assert.ok(!fake.server.writes.some(write => write.method === 'delete' && write.path.startsWith('/channels/')));
});

test('a transient Discord 50074 after the handoff is retried and cleanup completes', async () => {
    const fake = fakeDiscord(), remove = fake.rest.delete, oldRules = fake.server.guild.rules_channel_id, pauses = [];
    let attempts = 0;
    fake.rest.delete = async (path, options) => {
        if (path === `/channels/${oldRules}` && ++attempts <= 2) throw Object.assign(new Error('Cannot delete a channel required for community servers'), { code: 50074, status: 400 });
        return remove(path, options);
    };
    await deploy(fake, {}, compileBlueprint(control), [], { wait: async ms => pauses.push(ms) });
    assert.equal(attempts, 3);
    assert.deepEqual(pauses, [1000, 2000]);
    assert.ok(!fake.server.channels.some(channel => channel.id === oldRules));
});

test('retrying a failed Community cleanup keeps checkpointed channels and then publishes rules, info and roles', async () => {
    const fake = fakeDiscord(), remove = fake.rest.delete, oldRules = fake.server.guild.rules_channel_id;
    const blueprint = compileBlueprint(control), state = { initialized: false, resources: { role: {}, channel: {} } };
    const published = [];
    const options = { wait: async () => {}, saveResources: async bindings => { state.resources = clone(bindings); }, finishContent: async active => published.push(active) };
    fake.rest.delete = async (path, options) => {
        if (path === `/channels/${oldRules}`) throw Object.assign(new Error('Cannot delete a channel required for community servers'), { code: 50074, status: 400 });
        return remove(path, options);
    };
    await assert.rejects(deploy(fake, state, blueprint, [], options), /Delete channel and history: rules failed/);
    assert.equal(published.length, 0);
    const checkpoint = clone(state.resources.channel);
    const categoryId = checkpoint['category:game-animal-tag'];
    fake.server.channels.find(channel => channel.id === categoryId).name = '🐾・animal-tag';
    fake.server.messages.get(checkpoint['general-chat']).push('Keep messages posted during the partial deployment');
    fake.rest.delete = remove;
    const result = await deploy(fake, state, blueprint, [], options);
    assert.deepEqual(result.state.resources.channel, checkpoint);
    assert.ok(!fake.server.channels.some(channel => channel.id === oldRules));
    assert.equal(fake.server.channels.length, blueprint.channels.length);
    assert.equal(fake.server.channels.find(channel => channel.id === categoryId).name, 'Animal Tag');
    assert.equal(published.length, 1);
    for (const key of ['rules', 'info', 'roles', 'staff-info', 'help']) assert.equal(published[0].bindings.channel[key], checkpoint[key]);
    assert.deepEqual(fake.server.messages.get(checkpoint['general-chat']), ['Keep messages posted during the partial deployment']);
    const snapshot = await captureSnapshot(fake.rest, GUILD, BOT, blueprint.spec);
    assert.deepEqual(buildPlan(blueprint, snapshot, result.state).operations, []);
});
