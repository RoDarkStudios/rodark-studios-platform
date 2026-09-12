const { createHash } = require('node:crypto');
const { PermissionFlagsBits: P, SnowflakeUtil } = require('discord.js');
const manifest = require('../discord/server.json');

// Increment when the interpretation of server.json changes. Web and worker must agree.
const ENGINE_VERSION = 9;
const TYPES = { text: 0, voice: 2, category: 4, announcement: 5, forum: 15 };
const bit = (name) => name === 'BypassSlowmode' ? 1n << 52n : name === 'PinMessages' ? 1n << 51n : P[name];
function permissions(names) {
    return names.reduce((value, name) => {
        if (bit(name) === undefined) throw new Error(`Unknown Discord permission: ${name}`);
        return value | bit(name);
    }, 0n).toString();
}
function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
    return value;
}
const hash = (value) => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const clone = (value) => JSON.parse(JSON.stringify(value));
const reference = (kind, key) => `$${kind}:${key}`;

const COMMON = ['ViewChannel', 'SendMessages', 'SendMessagesInThreads', 'ReadMessageHistory', 'AddReactions',
    'AttachFiles', 'UseExternalEmojis', 'UseExternalStickers', 'Connect', 'Speak', 'Stream', 'UseVAD', 'UseApplicationCommands'];
const STAFF = ['KickMembers', 'BanMembers', 'ModerateMembers', 'ManageMessages', 'ViewAuditLog', 'MuteMembers',
    'DeafenMembers', 'MoveMembers', 'ManageNicknames', 'EmbedLinks', 'BypassSlowmode'];
const WRITE = ['SendMessages', 'SendMessagesInThreads', 'CreatePublicThreads', 'CreatePrivateThreads', 'SendVoiceMessages', 'SendPolls'];
const MODERATE_CONTENT = ['ManageMessages', 'ManageThreads', 'PinMessages'];

function overwrites(profile, guildId) {
    const entries = [];
    const add = (id, allow = [], deny = []) => entries.push({ id, type: 0, allow: permissions(allow), deny: permissions(deny) });
    if (['staff', 'staff-readonly', 'moderation-log'].includes(profile)) {
        add(guildId, [], ['ViewChannel']);
        add(reference('role', 'staff'), ['ViewChannel', 'ReadMessageHistory', 'Connect', 'Speak',
            ...(profile === 'staff' ? ['SendMessages', 'AttachFiles', 'EmbedLinks'] : [])],
        profile === 'staff' ? [] : [...WRITE, ...MODERATE_CONTENT]);
    } else if (profile === 'readonly') {
        add(guildId, ['ViewChannel', 'ReadMessageHistory', 'AddReactions'], [...WRITE, ...MODERATE_CONTENT]);
    } else if (profile === 'creators') {
        add(guildId, ['ViewChannel', 'ReadMessageHistory', 'AddReactions'], WRITE);
        for (const role of ['creator', 'staff']) add(reference('role', role), ['SendMessages', 'AttachFiles', 'EmbedLinks']);
    } else if (profile === 'honeypot') {
        // The honeypot system opens this only after publishing its warning.
        add(guildId, ['ViewChannel', 'ReadMessageHistory'], [...WRITE, 'MentionEveryone']);
    } else {
        add(guildId, ['ViewChannel', 'ReadMessageHistory', 'SendMessagesInThreads', 'AddReactions',
            ...(profile === 'owner-forum' ? [] : ['SendMessages']),
            ...(['media', 'forum', 'owner-forum'].includes(profile) ? ['AttachFiles'] : [])],
        [...(profile === 'chat' ? ['AttachFiles'] : []), ...(profile === 'owner-forum' ? ['SendMessages'] : [])]);
        if (profile === 'forum' || profile === 'owner-forum') add(reference('role', 'staff'), [], ['ManageThreads']);
    }
    return entries;
}

function validateManifest(spec) {
    if (spec.schemaVersion !== 1 || !/^\d{17,20}$/.test(spec.guildId)) throw new Error('Invalid server blueprint version or guild ID.');
    if (spec.separator !== '・') throw new Error('Channel names must use the agreed ・ separator.');
    for (const collection of [spec.roles, spec.games, spec.notifications, spec.gameChannels]) {
        if (!Array.isArray(collection)) throw new Error('Blueprint collections must be arrays.');
        const keys = collection.map((item) => item.key);
        if (new Set(keys).size !== keys.length || keys.some((key) => !/^[a-z0-9-]+$/.test(key))) throw new Error('Blueprint keys must be unique, stable identifiers.');
    }
    if (!spec.games.length || spec.games.length > 20) throw new Error('Onboarding requires between 1 and 20 game options.');
    if (!Array.isArray(spec.autoModerationRules) || spec.autoModerationRules.length > 1 ||
        spec.autoModerationRules.some(rule => !same(rule, { triggerType: 5, enabled: false }))) {
        throw new Error('Only the disabled Community Mention Spam rule is supported. Use contextual moderation for active filtering.');
    }
    if (!same(spec.levels.milestones, [5, 10, 15, 25, 50, 75, 100]) || !spec.levels.preservePermissions) throw new Error('Existing level milestones and permission behaviour must be preserved.');
}

function compileBlueprint(control = {}, spec = manifest) {
    validateManifest(spec);
    const threshold = Number(spec.levels.attachmentUnlockLevel ?? 5);
    if (!spec.levels.milestones.includes(threshold)) throw new Error('Invalid existing level permission threshold.');
    const roles = spec.roles.map((role) => ({ ...role,
        color: Number.parseInt(role.color.replace('#', ''), 16), mentionable: false, hoist: Boolean(role.hoist),
        permissions: permissions(role.profile === 'staff' ? STAFF : [])
    }));
    for (const level of [...spec.levels.milestones].reverse()) roles.push({ key: `level-${level}`, name: `Level ${level}`,
        color: level >= 50 ? 0x22d3ee : 0xf97316, hoist: false, mentionable: false,
        permissions: permissions(level >= threshold ? ['EmbedLinks'] : []) });
    for (const game of spec.games) roles.push({ key: `game-${game.key}`, name: game.name, color: 0, hoist: false, mentionable: false, permissions: '0' });
    for (const notice of spec.notifications) roles.push({ key: `ping-${notice.key}`, name: notice.name, color: 0, hoist: false, mentionable: false, permissions: '0' });
    if (new Set(roles.map((role) => role.name.toLowerCase())).size !== roles.length || roles.some((role) => !Number.isInteger(role.color) || role.color < 0 || role.color > 0xffffff)) throw new Error('Role names must be unique and colors must be valid RGB values.');
    const categories = spec.categories.flatMap((category) => category.games ? spec.games.map((game) => ({
        key: `game-${game.key}`, name: game.name,
        channels: spec.gameChannels.map((channel) => ({ ...clone(channel), key: `${game.key}/${channel.key}`, game: game.key }))
    })) : [clone(category)]);
    const channels = [];
    for (const [position, category] of categories.entries()) {
        channels.push({ key: `category:${category.key}`, name: category.name, type: 4, parentKey: null, position,
            profile: category.profile || 'public', permission_overwrites: overwrites(category.profile || 'public', spec.guildId) });
        for (const [childPosition, channel] of category.channels.entries()) {
            if (TYPES[channel.type] === undefined || !channel.name || channel.name.length > 100 || /\s/.test(channel.name)) throw new Error(`Invalid channel ${channel.key}.`);
            if (channel.key !== 'honeypot' && !channel.name.includes(spec.separator)) throw new Error(`Missing ・ separator in ${channel.key}.`);
            const tags = channel.tags || [];
            if (tags.length > 20 || new Set(tags.map((tag) => tag.key)).size !== tags.length || tags.some((tag) => !tag.name || tag.name.length > 20)) throw new Error(`Invalid forum tags in ${channel.key}.`);
            if ((channel.slowmode || 0) < 0 || (channel.slowmode || 0) > 21600) throw new Error(`Invalid slowmode in ${channel.key}.`);
            channels.push({ ...channel, type: TYPES[channel.type], parentKey: `category:${category.key}`, position: childPosition,
                profile: channel.profile || category.profile || 'public',
                permission_overwrites: overwrites(channel.profile || category.profile || 'public', spec.guildId) });
        }
    }
    if (channels.length > 500 || new Set(channels.map((channel) => channel.key)).size !== channels.length) throw new Error('Channel keys must be unique and fit Discord limits.');
    for (const required of ['honeypot', 'staff-info', 'moderation-log', 'rules', 'info', 'roles', 'help', 'category:tickets', 'category:ignore', 'game-updates', 'level-ups']) {
        if (!channels.some((channel) => channel.key === required)) throw new Error(`Required bot integration channel is missing: ${required}`);
    }
    const defaults = spec.onboarding.defaultChannels;
    if (defaults.includes('honeypot') || defaults.some((key) => !channels.some((channel) => channel.key === key))) throw new Error('Invalid onboarding defaults; the honeypot must never be an onboarding destination.');
    const result = { spec: clone(spec), guildId: spec.guildId, roles, channels, levelUnlock: threshold, everyonePermissions: permissions(COMMON) };
    result.version = hash({ engine: ENGINE_VERSION, spec, threshold });
    return result;
}

function resolve(value, bindings) {
    if (typeof value === 'string' && /^\$(role|channel):/.test(value)) {
        const [, kind, key] = value.match(/^\$(role|channel):(.*)$/);
        const id = bindings[kind]?.[key];
        if (!id) throw new Error(`Missing deployed ${kind}: ${key}`);
        return id;
    }
    if (Array.isArray(value)) return value.map((item) => resolve(item, bindings));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item, bindings)]));
    return value;
}
function channelBody(channel, bindings, existing) {
    const payload = { name: channel.name, type: channel.type, permission_overwrites: resolve(channel.permission_overwrites, bindings) };
    if (channel.parentKey) payload.parent_id = bindings.channel[channel.parentKey];
    if (channel.type === 2) Object.assign(payload, { bitrate: 64000, user_limit: channel.userLimit || 0 });
    if ([0, 5, 15].includes(channel.type)) Object.assign(payload, { topic: channel.topic || '', nsfw: false, rate_limit_per_user: channel.slowmode || 0 });
    if (channel.type === 15) Object.assign(payload, {
        default_auto_archive_duration: 10080, default_thread_rate_limit_per_user: 0,
        default_sort_order: 0, default_forum_layout: channel.layout === 'gallery' ? 2 : 1,
        default_reaction_emoji: { emoji_name: '👍', emoji_id: null }, flags: channel.requireTag ? 16 : 0,
        available_tags: (channel.tags || []).map((tag) => ({
            ...((existing?.available_tags || []).find((item) => item.id === bindings.tag?.[`${channel.key}/${tag.key}`] || item.name === tag.name)?.id
                ? { id: existing.available_tags.find((item) => item.id === bindings.tag?.[`${channel.key}/${tag.key}`] || item.name === tag.name).id } : {}),
            name: tag.name, moderated: Boolean(tag.moderated), emoji_name: tag.emoji || null, emoji_id: null
        }))
    });
    return payload;
}
function normalizeOverwrites(entries = []) {
    return entries.map((entry) => ({ id: entry.id, type: entry.type, allow: String(entry.allow || '0'), deny: String(entry.deny || '0') }))
        .sort((a, b) => a.id.localeCompare(b.id));
}
function comparableChannel(channel, keys) {
    return Object.fromEntries(keys.map((key) => {
        let value = channel[key];
        if (key === 'permission_overwrites') value = normalizeOverwrites(value);
        if (key === 'topic') value = value || '';
        if (key === 'parent_id') value = value || null;
        if (key === 'flags') value = (value || 0) & 16;
        if (key === 'available_tags') value = (value || []).map(({ name, moderated, emoji_name, emoji_id }) => ({ name, moderated: Boolean(moderated), emoji_name: emoji_name || null, emoji_id: emoji_id || null }));
        if (key === 'nsfw') value = Boolean(value);
        if (key === 'rate_limit_per_user' || key === 'default_thread_rate_limit_per_user') value = value || 0;
        return [key, value];
    }));
}
function roleBody(role) {
    return { name: role.name, permissions: role.permissions, colors: { primary_color: role.color, secondary_color: null, tertiary_color: null }, hoist: role.hoist, mentionable: false };
}
function roleMatches(actual, desired) {
    return actual.name === desired.name && String(actual.permissions) === desired.permissions &&
        (actual.colors?.primary_color ?? actual.color ?? 0) === desired.color &&
        !(actual.colors?.secondary_color || actual.colors?.tertiary_color) && Boolean(actual.hoist) === desired.hoist && !actual.mentionable;
}
function onboardingBody(blueprint, bindings, previous = {}) {
    const { spec } = blueprint;
    const prompt = (key, title, options, required) => {
        const old = previous.prompts?.find((item) => item.id === bindings.prompt?.[key] || item.title === title);
        // Discord requires an ID even for new prompts, then returns its canonical
        // IDs. Existing prompt IDs are reused; applyPlan checkpoints the response.
        return { id: old?.id || SnowflakeUtil.generate().toString(), type: 0, title, single_select: false, required, in_onboarding: true,
            options: options.map(({ key: optionKey, ...option }) => {
                const existing = old?.options?.find((item) => item.id === bindings.option?.[`${key}/${optionKey}`] || item.title === option.title);
                return { ...(existing?.id ? { id: existing.id } : {}), ...option };
            }) };
    };
    return { enabled: true, mode: 1, default_channel_ids: spec.onboarding.defaultChannels.map((key) => bindings.channel[key]), prompts: [
        prompt('games', spec.onboarding.gamesQuestion, spec.games.map((game) => ({ key: game.key, title: game.name, description: `Channels for ${game.name}`, emoji_name: game.emoji,
            role_ids: [bindings.role[`game-${game.key}`], bindings.role.member],
            channel_ids: blueprint.channels.filter((channel) => channel.game === game.key).map((channel) => bindings.channel[channel.key])
        })), Boolean(spec.onboarding.gamesRequired)),
        prompt('notifications', spec.onboarding.notificationsQuestion, spec.notifications.map((notice) => ({ key: notice.key, title: notice.name, description: notice.description, emoji_name: notice.emoji,
            role_ids: [bindings.role[`ping-${notice.key}`]], channel_ids: []
        })), false)
    ] };
}
function normalizeOnboarding(value = {}) {
    // Discord returns the default channel selection in its own order. Membership
    // matters here; display order is managed separately by channel positions.
    return { enabled: Boolean(value.enabled), mode: value.mode || 0, default_channel_ids: [...(value.default_channel_ids || [])].sort(),
        prompts: (value.prompts || []).map((prompt) => ({ title: prompt.title, type: prompt.type, single_select: Boolean(prompt.single_select),
            required: Boolean(prompt.required), in_onboarding: Boolean(prompt.in_onboarding), options: prompt.options.map((option) => ({
                title: option.title, description: option.description || '', emoji_name: option.emoji_name || option.emoji?.name || null,
                role_ids: [...(option.role_ids || [])].sort(), channel_ids: [...(option.channel_ids || [])].sort()
            })) })) };
}

function snapshotHash(snapshot, ticketIds = [], initial = false) {
    const channels = snapshot.channels.filter((channel) => initial || !ticketIds.includes(channel.id));
    const groupOrder = (channel) => channels.filter((item) => (item.parent_id || null) === (channel.parent_id || null) && (item.type === 4) === (channel.type === 4))
        .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)).findIndex((item) => item.id === channel.id);
    return hash({ guild: snapshot.guild, roles: snapshot.roles, self: snapshot.self, autoMod: snapshot.autoMod,
        onboarding: normalizeOnboarding(snapshot.onboarding),
        channels: channels.map((channel) => ({ ...comparableChannel(channel, ['name', 'type', 'topic', 'parent_id', 'permission_overwrites', 'nsfw', 'rate_limit_per_user', 'user_limit', 'bitrate', 'available_tags', 'flags', 'default_auto_archive_duration', 'default_thread_rate_limit_per_user', 'default_sort_order', 'default_forum_layout', 'default_reaction_emoji']), id: channel.id, position: groupOrder(channel) }))
            .sort((a, b) => a.id.localeCompare(b.id)) });
}

function buildPlan(blueprint, snapshot, state = {}, ticketIds = []) {
    const initial = !state.initialized;
    const bindings = clone(state.resources || { role: {}, channel: {} });
    bindings.role ||= {}; bindings.channel ||= {};
    bindings.role = Object.fromEntries(Object.entries(bindings.role).filter(([key]) => ['owner', 'bot'].includes(key) || blueprint.roles.some((role) => role.key === key)));
    bindings.channel = Object.fromEntries(Object.entries(bindings.channel).filter(([key]) => blueprint.channels.some((channel) => channel.key === key)));
    const errors = [], notes = [], operations = [];
    const rolesById = new Map(snapshot.roles.map((role) => [role.id, role]));
    const channelsById = new Map(snapshot.channels.map((channel) => [channel.id, channel]));
    if (snapshot.guild.id !== blueprint.guildId) throw new Error('The live server does not match the blueprint.');
    const highest = snapshot.roles.filter((role) => snapshot.self.roles.includes(role.id)).sort((a, b) => b.position - a.position)[0];
    if (!highest || !snapshot.roles.some((role) => snapshot.self.roles.includes(role.id) && (BigInt(role.permissions) & 8n))) errors.push('The bot needs Administrator before deploying.');
    const owners = snapshot.roles.filter((role) => role.name.toLowerCase() === blueprint.spec.bootstrap.ownerRoleName.toLowerCase());
    if (owners.length !== 1 || !highest || owners[0].position <= highest.position || !(BigInt(owners[0].permissions) & 8n)) {
        errors.push('Keep one Owner role with Administrator above the bot. Only a server owner can configure that part of the hierarchy.');
    } else bindings.role.owner = owners[0].id;
    if (highest) bindings.role.bot = highest.id;
    notes.push('The Owner role, the bot’s own roles and Discord-managed booster role are retained. Existing role assignments and XP are preserved.');
    const removedBots = snapshot.roles.filter((role) => role.tags?.bot_id && blueprint.spec.bootstrap.removeBotRoleNames.some((name) => name.toLowerCase() === role.name.toLowerCase()));
    for (const role of removedBots) {
        const member = snapshot.removableBots?.[role.tags.bot_id];
        if (role.tags.bot_id === snapshot.self.user.id) errors.push('The blueprint cannot remove its own bot.');
        else if (!member || member.roles.some((id) => (rolesById.get(id)?.position || 0) >= (highest?.position || 0))) errors.push(`Move ${role.name} below the RoDark bot so it can be removed.`);
        else operations.push({ kind: 'remove_bot', id: role.tags.bot_id, label: `Remove ${role.name} from the server` });
    }
    for (const role of blueprint.roles) {
        let actual = rolesById.get(bindings.role[role.key]);
        if (!actual) {
            const matches = snapshot.roles.filter((item) => role.managedBooster ? Object.hasOwn(item.tags || {}, 'premium_subscriber') : !item.managed && item.name.toLowerCase() === role.name.toLowerCase());
            if (matches.length > 1) errors.push(`Multiple roles match ${role.name}; resolve the duplicate roles before deploying.`);
            actual = matches.length === 1 ? matches[0] : null;
        }
        if (actual) bindings.role[role.key] = actual.id;
        else delete bindings.role[role.key];
        if (role.managedBooster && !actual) { notes.push('Discord will create the Server Booster role when the server receives a boost.'); continue; }
        if (actual && highest && actual.position >= highest.position) { errors.push(`${role.name} must be below the bot.`); continue; }
        if (!actual || !roleMatches(actual, role)) operations.push({ kind: 'role', key: role.key, id: actual?.id || null, label: `${actual ? 'Update' : 'Create'} role: ${role.name}` });
    }
    const ownRoles = new Set(snapshot.self.roles);
    const retainedRoles = new Set(Object.values(bindings.role));
    for (const role of snapshot.roles) {
        if (role.id === blueprint.guildId || role.managed || ownRoles.has(role.id) || retainedRoles.has(role.id)) continue;
        if (highest && role.position >= highest.position) errors.push(`Unlisted role ${role.name} is above the bot; remove or move it manually.`);
        else operations.push({ kind: 'delete_role', id: role.id, label: `Delete unlisted role: ${role.name}` });
    }
    const everyone = rolesById.get(blueprint.guildId);
    if (everyone?.permissions !== blueprint.everyonePermissions) operations.push({ kind: 'everyone', label: 'Set ordinary member permissions and preserve the level link-preview gate' });
    // Placeholder references let a preview describe resources whose Discord IDs do not exist yet.
    const previewBindings = clone(bindings);
    for (const role of blueprint.roles) previewBindings.role[role.key] ||= reference('role', role.key);
    for (const channel of blueprint.channels) previewBindings.channel[channel.key] ||= reference('channel', channel.key);
    for (const channel of blueprint.channels) {
        let actual = channelsById.get(bindings.channel[channel.key]);
        if (actual && actual.type !== channel.type) {
            // A type change is a replacement; the old channel is included in deletion below.
            delete bindings.channel[channel.key]; actual = null;
        }
        if (!actual) delete bindings.channel[channel.key];
        previewBindings.channel[channel.key] = actual?.id || reference('channel', channel.key);
        const desired = channelBody(channel, previewBindings, actual);
        // The armed trap has its own exact permission repair/warning lifecycle.
        const keys = Object.keys(desired).filter((key) => channel.profile !== 'honeypot' || key !== 'permission_overwrites');
        if (!actual || !same(comparableChannel(actual, keys), comparableChannel(desired, keys))) operations.push({ kind: 'channel', key: channel.key, id: actual?.id || null,
            label: `${actual ? 'Update' : 'Create'} ${channel.type === 4 ? 'category' : 'channel'}: ${channel.name}` });
    }
    const retainedChannels = new Set(Object.values(bindings.channel));
    const ticketParent = bindings.channel['category:tickets'];
    for (const channel of [...snapshot.channels].sort((a, b) => (a.type === 4) - (b.type === 4))) {
        if (retainedChannels.has(channel.id)) continue;
        if (!initial && ticketIds.includes(channel.id) && channel.parent_id === ticketParent) continue;
        operations.push({ kind: 'delete_channel', id: channel.id, label: `Delete ${channel.type === 4 ? 'category' : 'channel and history'}: ${channel.name}` });
    }
    const desiredRoleIds = blueprint.roles.map((role) => bindings.role[role.key]).filter(Boolean);
    const actualRoleIds = [...snapshot.roles].filter((role) => desiredRoleIds.includes(role.id)).sort((a, b) => b.position - a.position).map((role) => role.id);
    if (operations.some((op) => op.kind === 'role' && !op.id) || !same(actualRoleIds, desiredRoleIds)) operations.push({ kind: 'sort_roles', label: 'Arrange the role hierarchy below Owner and the bot' });
    let orderDiffers = operations.some((op) => op.kind === 'channel' && !op.id);
    for (const parentKey of [null, ...blueprint.channels.filter((channel) => channel.type === 4).map((channel) => channel.key)]) {
        const desired = blueprint.channels.filter((channel) => channel.parentKey === parentKey).map((channel) => bindings.channel[channel.key]).filter(Boolean);
        const actual = snapshot.channels.filter((channel) => desired.includes(channel.id)).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)).map((channel) => channel.id);
        if (!same(desired, actual)) orderDiffers = true;
    }
    if (orderDiffers) operations.push({ kind: 'sort_channels', label: 'Arrange categories and their channels from top to bottom' });
    const guildDesired = { ...blueprint.spec.settings, name: blueprint.spec.name,
        rules_channel_id: previewBindings.channel.rules, public_updates_channel_id: previewBindings.channel['staff-info'], safety_alerts_channel_id: previewBindings.channel['moderation-log'] };
    if (!snapshot.guild.features.includes('COMMUNITY') || Object.keys(guildDesired).some((key) => snapshot.guild[key] !== guildDesired[key])) operations.push({ kind: 'guild', label: 'Configure Community, rules, moderation alerts and server defaults' });
    const onboarding = onboardingBody(blueprint, previewBindings, snapshot.onboarding);
    if (!same(normalizeOnboarding(onboarding), normalizeOnboarding(snapshot.onboarding))) operations.push({ kind: 'onboarding', label: 'Publish game selection and optional notification questions' });
    for (const rule of snapshot.autoMod) {
        // Community servers cannot delete their Mention Spam rule. The definition
        // retains it disabled; an absent disabled rule does not need creating.
        const desired = blueprint.spec.autoModerationRules.find(item => item.triggerType === rule.trigger_type);
        if (desired) {
            if (rule.enabled !== desired.enabled) operations.push({ kind: 'disable_automod', id: rule.id, label: `Disable native AutoMod rule: ${rule.name}` });
        } else operations.push({ kind: 'delete_automod', id: rule.id, label: `Remove unlisted native AutoMod rule: ${rule.name}` });
    }
    if (state.active?.version !== blueprint.version || initial || operations.length) operations.push({ kind: 'content', label: 'Connect tickets, levels, honeypot and AI moderation; publish server information' });
    if (snapshot.channels.length + operations.filter((op) => op.kind === 'channel' && !op.id).length > 500) errors.push('Discord’s 500-channel limit leaves insufficient room to stage this rebuild. Reduce the old channel count before deploying.');
    if (snapshot.roles.length + operations.filter((op) => op.kind === 'role' && !op.id).length > 250) errors.push('Discord’s role limit leaves insufficient room to create the required roles.');
    // Retire bindings for resources removed from the file, preventing accidental adoption on re-add.
    bindings.role = Object.fromEntries(Object.entries(bindings.role).filter(([key]) => ['owner', 'bot'].includes(key) || blueprint.roles.some((role) => role.key === key)));
    bindings.channel = Object.fromEntries(Object.entries(bindings.channel).filter(([key]) => blueprint.channels.some((channel) => channel.key === key)));
    return { initial, version: blueprint.version, fingerprint: snapshotHash(snapshot, ticketIds, initial), operations, errors, notes, bindings,
        counts: { create: operations.filter((op) => ['role', 'channel'].includes(op.kind) && !op.id).length,
            remove: operations.filter((op) => op.kind.startsWith('delete_') || op.kind === 'remove_bot').length,
            update: operations.filter((op) => !op.kind.startsWith('delete_') && op.kind !== 'remove_bot' && !(['role', 'channel'].includes(op.kind) && !op.id)).length } };
}

module.exports = { ENGINE_VERSION, manifest, compileBlueprint, validateManifest, buildPlan, hash, same, clone, permissions,
    snapshotHash, channelBody, roleBody, onboardingBody, normalizeOnboarding, normalizeOverwrites, roleMatches };
