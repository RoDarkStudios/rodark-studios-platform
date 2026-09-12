const { createHash } = require('node:crypto');
const {
    ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder,
    OverwriteType, PermissionFlagsBits: P, escapeMarkdown
} = require('discord.js');
const defaultStore = require('../api/_lib/discord-moderation-store');
const {
    MODEL, INTERVAL_MS, snapshotMessage, selectBatch, buildReviewInput, validateCases, reviewConversation
} = require('./moderation-policy');

const LOG_NAME = 'ai-moderation-log';
const LOG_TOPIC = 'RoDark Studios contextual moderation • Private evidence and human ban reviews';
const SUPPORTED_CHANNELS = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread, ChannelType.AnnouncementThread]);
const ids = (text) => String(text || '').split(',').map((id) => id.trim()).filter(Boolean);

function readConfig(env = process.env) {
    return {
        enabled: env.DISCORD_AI_MODERATION_ENABLED !== 'false',
        apiKey: String(env.OPENAI_API_KEY || '').trim(),
        logChannelId: String(env.DISCORD_MODERATION_LOG_CHANNEL_ID || '').trim(),
        moderatorRoleIds: ids(env.DISCORD_MODERATOR_ROLE_IDS),
        excludedChannelIds: ids(env.DISCORD_MODERATION_EXCLUDED_CHANNEL_IDS)
    };
}

function privilegedRole(role) {
    return /^(owner|owners|admin|admins|administrator|moderator|moderators|staff)$/i.test(role.name)
        || role.permissions?.has(P.Administrator) || role.permissions?.has(P.ModerateMembers);
}

function resolveModeratorRoles(guild, configuredIds) {
    if (configuredIds.length) {
        const roles = configuredIds.map((id) => guild.roles.cache.get(id));
        if (roles.some((role) => !role || role.id === guild.id || role.managed)) {
            throw new Error('DISCORD_MODERATOR_ROLE_IDS must identify existing human moderator roles');
        }
        return roles;
    }
    const humanRoles = [...guild.roles.cache.values()].filter((role) => role.id !== guild.id && !role.managed);
    const named = humanRoles.filter((role) => /^(moderator|moderators|staff)$/i.test(role.name));
    const roles = named.length ? named : humanRoles.filter((role) => role.permissions.has(P.ModerateMembers));
    if (!roles.length) throw new Error('No moderator/Staff role found; configure DISCORD_MODERATOR_ROLE_IDS');
    return roles;
}

function eligibleChannel(channel, control, config, state) {
    if (!channel?.guild || !SUPPORTED_CHANNELS.has(channel.type)) return false;
    if (control?.guildId && channel.guild.id !== control.guildId) return false;
    const base = channel.isThread?.() ? channel.parent : channel;
    if (!base) return false;
    const lineage = [channel.id, base.id, base.parentId].filter(Boolean);
    const exclusions = [config.logChannelId, state?.logChannel.id, control?.ticketSystem?.categoryChannelId,
        control?.ticketSystem?.panelChannelId, control?.startupContentSync?.staffInfoChannelId, ...config.excludedChannelIds].filter(Boolean);
    if (lineage.some((id) => exclusions.includes(id))) return false;
    if ([channel.name, base.name].some((name) => String(name || '').toLowerCase().replace(/[\s_|│┃｜︱-]/g, '') === 'ignoredonottype')) return false;
    // Include community channels gated by ordinary member roles, but exclude staff-only spaces.
    return [...channel.guild.roles.cache.values()].some((role) => !role.managed && !privilegedRole(role)
        && !state?.roleIds.includes(role.id) && base.permissionsFor(role)?.has(P.ViewChannel));
}

function isProtected(member, guild, roleIds) {
    return member.id === guild.ownerId || member.user?.bot || member.permissions.has(P.Administrator)
        || member.permissions.has(P.ModerateMembers)
        || [...member.roles.cache.values()].some((role) => roleIds.includes(role.id) || /^(owner|owners)$/i.test(role.name));
}

function makeCase(item, batch, recent, now) {
    const evidence = batch.filter((message) => item.message_ids.includes(message.id));
    const first = evidence[0];
    const caseId = createHash('sha256').update(`${first.guild_id}:${item.user_id}:${evidence.map((m) => `${m.id}:${m.version}`).sort().join(',')}`).digest('hex').slice(0, 24);
    const repeats = recent.filter((entry) => entry.user_id === item.user_id).length;
    const needsReview = item.action !== 'timeout' || item.severity === 'severe' || repeats >= 2;
    const banReview = item.action === 'timeout_and_review' || item.severity === 'severe' || repeats >= 2;
    const timeoutMinutes = item.action === 'review' ? 0 : item.severity === 'severe' ? 60 : repeats ? 30 : 10;
    return {
        ...item, id: caseId, guild_id: first.guild_id, channel_id: first.channel_id, evidence,
        created_at: new Date(now).toISOString(), outcome: 'pending', needs_review: needsReview, ban_review: banReview,
        timeout_minutes: timeoutMinutes,
        timeout_until: timeoutMinutes ? new Date(now + timeoutMinutes * 60_000).toISOString() : null,
        log_message_id: null
    };
}

function buildCasePayload(entry, roleIds) {
    const dismissed = Boolean(entry.dismissed_by);
    const reviewPending = entry.needs_review && !dismissed && !entry.reviewed_by;
    const evidenceFields = entry.evidence.slice(0, 5).map((message, index) => {
        const link = `https://discord.com/channels/${entry.guild_id}/${entry.channel_id}/${message.id}`;
        return { name: `Evidence ${index + 1}`, value: `[Message](${link}) · ${message.timestamp}\n> ${escapeMarkdown(message.content.slice(0, 300)).replace(/\n/g, '\n> ').slice(0, 450) || '(no text)'}` };
    });
    const embed = new EmbedBuilder().setTitle(dismissed ? 'Moderation case dismissed' : reviewPending ? (entry.ban_review ? 'Ban review requested' : 'Moderator review needed') : 'Contextual moderation')
        .setColor(dismissed ? 0x64748b : reviewPending ? 0xf59e0b : 0xf97316)
        .setDescription(escapeMarkdown(entry.reason).slice(0, 900))
        .addFields(
            { name: 'Member', value: `<@${entry.user_id}> (${entry.user_id})` },
            { name: 'Decision', value: `${entry.category} · ${entry.confidence} confidence\n${entry.result || entry.outcome}`.slice(0, 650) },
            ...evidenceFields
        ).setFooter({ text: `Case ${entry.id} · ${MODEL} / high · ${entry.evidence.length} evidence message(s)` });
    if (entry.timeout_until && entry.outcome === 'timed_out') embed.addFields({ name: 'Bot timeout ends', value: entry.timeout_until });
    if (entry.reviewed_by) embed.addFields({ name: 'Reviewed by', value: `<@${entry.reviewed_by}>` });
    if (dismissed) embed.addFields({ name: 'Dismissed by', value: `<@${entry.dismissed_by}>\n${entry.dismissal_note || ''}` });
    return {
        content: reviewPending ? roleIds.map((id) => `<@&${id}>`).join(' ') : '',
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`ai_mod:reviewed:${entry.id}`).setLabel('Mark reviewed').setStyle(ButtonStyle.Secondary).setDisabled(dismissed || Boolean(entry.reviewed_by)),
            new ButtonBuilder().setCustomId(`ai_mod:dismiss:${entry.id}`).setLabel('Dismiss / undo bot timeout').setStyle(ButtonStyle.Secondary).setDisabled(dismissed)
        )],
        allowedMentions: { parse: [], users: [], roles: reviewPending ? roleIds : [] }
    };
}

function assertPrivateLog(state, botId) {
    const overwrites = state.logChannel.permissionOverwrites.cache;
    const everyone = overwrites.get(state.guild.id);
    if (!everyone?.deny.has(P.ViewChannel) || everyone.allow.has(P.ViewChannel)
        || [...overwrites.values()].some((entry) => entry.allow.has(P.ViewChannel)
            && entry.id !== botId && !state.readerIds.includes(entry.id))) {
        throw new Error('Moderation log permissions changed; refusing to publish private evidence until repaired');
    }
}

function createModerationSystem(client, {
    store = defaultStore, config = readConfig(), review = reviewConversation,
    now = Date.now, setIntervalFn = setInterval, clearIntervalFn = clearInterval, logger = console
} = {}) {
    const states = new Map();
    const controllers = new Set();
    const notices = new Map();
    let timer, running, ensuring, getControl;
    let stopped = false;
    let lastEnsure = 0;
    let ensureKey = '';
    let nextApiAt = 0;
    let failures = 0;
    let lastCleanup = 0;
    let lastControl = null;
    let healthError = null;

    async function report(key, error, state) {
        if ((notices.get(key) || 0) > now()) return;
        notices.set(key, now() + 60 * 60_000);
        const message = String(error.message || error).slice(0, 700);
        logger.error(`[ai-moderation] ${key}: ${message}`);
        if (state && !stopped) {
            try { assertPrivateLog(state, client.user.id); } catch { return; }
            await state.logChannel.send({ content: `${state.roleIds.map((id) => `<@&${id}>`).join(' ')}\nModeration needs attention: ${escapeMarkdown(message)}`,
                allowedMentions: { parse: [], users: [], roles: state.roleIds } }).catch((sendError) => logger.error('[ai-moderation] Could not notify moderators:', sendError.message));
        }
    }

    async function ensureGuild(guild) {
        await guild.roles.fetch();
        const roles = resolveModeratorRoles(guild, config.moderatorRoleIds);
        const me = await guild.members.fetchMe();
        if (!me.permissions.has(P.ModerateMembers)) throw new Error('The bot requires Moderate Members for contextual moderation');
        await guild.channels.fetch();
        let logChannel = config.logChannelId ? guild.channels.cache.get(config.logChannelId)
            : guild.channels.cache.find((channel) => channel.type === ChannelType.GuildText && channel.topic === LOG_TOPIC);
        if (config.logChannelId && !logChannel) throw new Error('Configured moderation log channel is not in the target server');
        if (logChannel && logChannel.type !== ChannelType.GuildText) throw new Error('Moderation log must be a text channel');
        const readers = [...new Set([...roles.map((role) => role.id), ...[...guild.roles.cache.values()].filter((role) => /^(owner|owners)$/i.test(role.name) && !role.managed).map((role) => role.id)])];
        const overwrites = [
            { id: guild.id, type: OverwriteType.Role, allow: [], deny: [P.ViewChannel] },
            ...readers.map((id) => ({ id, type: OverwriteType.Role, allow: [P.ViewChannel, P.ReadMessageHistory, P.SendMessages], deny: [] })),
            { id: client.user.id, type: OverwriteType.Member, allow: [P.ViewChannel, P.ReadMessageHistory, P.SendMessages, P.EmbedLinks, P.MentionEveryone], deny: [] }
        ];
        if (!logChannel) {
            logChannel = await guild.channels.create({ name: LOG_NAME, type: ChannelType.GuildText, topic: LOG_TOPIC,
                permissionOverwrites: overwrites, reason: 'Private contextual moderation log and human review' });
        } else {
            const bits = (values) => values.reduce((sum, bit) => sum | bit, 0n);
            if (logChannel.permissionOverwrites.cache.size !== overwrites.length || overwrites.some((entry) => {
                const current = logChannel.permissionOverwrites.cache.get(entry.id);
                return !current || current.type !== entry.type || current.allow.bitfield !== bits(entry.allow) || current.deny.bitfield !== bits(entry.deny);
            })) await logChannel.permissionOverwrites.set(overwrites, 'Keep moderation evidence private');
        }
        if (!logChannel.permissionsFor(me)?.has([P.ViewChannel, P.SendMessages, P.EmbedLinks, P.ReadMessageHistory, P.MentionEveryone])) {
            throw new Error('The bot cannot read, write, embed or ping moderator roles in the moderation log');
        }
        states.set(guild.id, { guild, logChannel, roleIds: roles.map((role) => role.id), readerIds: readers });
    }

    async function ensure(control, { force = false } = {}) {
        lastControl = control;
        if (stopped || !config.enabled || !client.isReady()) return;
        if (!config.apiKey) {
            healthError = 'OPENAI_API_KEY is missing; contextual moderation is unavailable';
            await report('configuration', healthError);
            return;
        }
        if (ensuring) return ensuring;
        const guilds = [...client.guilds.cache.values()].filter((guild) => !control?.guildId || guild.id === control.guildId);
        const key = guilds.map((guild) => guild.id).sort().join(',');
        if (!force && key === ensureKey && now() - lastEnsure < 5 * 60_000) return;
        ensuring = (async () => {
            await store.ensureSchema();
            for (const id of states.keys()) if (!guilds.some((guild) => guild.id === id)) states.delete(id);
            healthError = null;
            for (const guild of guilds) {
                // Do not race two worker replicas creating the log channel.
                await store.withLock(`setup:${guild.id}`, async () => {
                    try { await ensureGuild(guild); }
                    catch (error) { healthError = error.message; const previous = states.get(guild.id); states.delete(guild.id); await report(`setup:${guild.id}`, error, previous); }
                });
            }
            lastEnsure = now();
            ensureKey = key;
        })().catch((error) => { healthError = error.message; throw error; }).finally(() => { ensuring = null; });
        return ensuring;
    }

    async function handleMessage(message, control) {
        if (stopped || !config.enabled || !config.apiKey || control?.desiredEnabled === false) return false;
        if (message?.partial) message = await message.fetch();
        if (!message?.guild || !message.author || message.author.bot || message.webhookId || message.system) return false;
        const state = states.get(message.guild.id);
        if (!eligibleChannel(message.channel, control, config, state)) return false;
        // Images and audio are not sent to the model. Text captions and all non-empty edits are reviewed.
        const snapshot = snapshotMessage(message);
        if (!snapshot.content.trim()) {
            // A text message edited to empty must invalidate its older queued version.
            if (message.editedTimestamp) await store.enqueue(snapshot);
            return false;
        }
        await store.enqueue(snapshot);
        return true;
    }

    async function handleDelete(messages) {
        if (stopped || !config.enabled || !config.apiKey) return;
        await store.markDeleted(messages.map((message) => message.id));
    }

    async function contextFor(channel, batch) {
        let context = await store.getContext(channel.id);
        if (!context.length) {
            const previous = await channel.messages.fetch({ limit: 30, before: batch[0].id });
            context = [...previous.values()].filter((message) => message.author && !message.author.bot && !message.system && !message.webhookId)
                .map(snapshotMessage).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        }
        const known = new Set([...context, ...batch].map((message) => message.id));
        const replyIds = [...new Set(batch.map((message) => message.reply_to).filter((id) => id && !known.has(id)))].slice(0, 5);
        for (const id of replyIds) {
            try {
                const reply = await channel.messages.fetch({ message: id, force: true });
                if (reply.author && !reply.system && !reply.webhookId) context.push(snapshotMessage(reply));
            } catch (error) { if (error.code !== 10008) throw error; }
        }
        return context.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    }

    async function reviewChannel(pending, control) {
        const state = states.get(pending.guild_id);
        if (!state || stopped || now() < nextApiAt) return;
        await store.withLock(`channel:${pending.channel_id}`, async () => {
            if (stopped || now() < nextApiAt) return;
            let channel;
            try { channel = await state.guild.channels.fetch(pending.channel_id); }
            catch (error) { if (error.code !== 10003) throw error; }
            const batch = selectBatch(await store.loadPending(pending.channel_id));
            if (!batch.length) return;
            if (!channel || !eligibleChannel(channel, control, config, state)) {
                await store.commitReview(batch, []);
                return;
            }
            if (pending.pending_count > 100 || now() - new Date(pending.oldest).getTime() > 5 * 60_000) {
                await report(`backlog:${channel.id}`, 'Conversation reviews are more than a few minutes behind. Messages remain queued; please monitor this channel manually.', state);
            }
            const controller = new AbortController();
            controllers.add(controller);
            const timeout = setTimeout(() => controller.abort(), 55_000);
            let called = false;
            let usage = {};
            let failed = false;
            const failuresAtStart = failures;
            try {
                const context = await contextFor(channel, batch);
                const recent = await store.recentCases(state.guild.id, [...new Set(batch.map((message) => message.user_id))]);
                if (stopped || now() < nextApiAt || !await store.claimInterval(pending.channel_id)) return;
                called = true;
                const result = await review(buildReviewInput(batch, context, recent), { apiKey: config.apiKey, signal: controller.signal });
                usage = result.usage || {};
                const decisions = validateCases({ cases: result.cases }, batch);
                if (stopped) return;
                await store.commitReview(batch, decisions.map((decision) => makeCase(decision, batch, recent, now())));
                if (failures === failuresAtStart) { failures = 0; nextApiAt = 0; }
            } catch (error) {
                failed = true;
                usage = error.usage || usage;
                if (!stopped) {
                    if (called) {
                        failures++;
                        nextApiAt = now() + Math.min(15, 2 ** Math.min(failures - 1, 4)) * INTERVAL_MS;
                    }
                    await store.failBatch(batch);
                    await report(`review:${state.guild.id}`, 'A conversation review failed. No punishment was made from that response. Reviews back off and retry up to three times; please check recent chat. ' + error.message, state);
                }
            } finally {
                clearTimeout(timeout);
                controllers.delete(controller);
                if (called) {
                    await store.recordUsage(state.guild.id, MODEL, usage, failed).catch((error) => report(`usage:${state.guild.id}`, error, state));
                    logger.info(`[ai-moderation] ${channel.id}: ${batch.length} messages; input=${usage.input_tokens || 0}, output=${usage.output_tokens || 0}, failed=${failed}`);
                }
            }
        });
    }

    async function actOnCase(entry, state) {
        const patch = { outcome: 'review_only', needs_review: true, result: 'Sent for human review; no automatic punishment.' };
        if (entry.action === 'review' || entry.confidence !== 'high') return patch;
        if (now() - new Date(entry.created_at).getTime() > 10 * 60_000
            || new Date(entry.timeout_until).getTime() <= now()
            || entry.evidence.every((message) => now() - new Date(message.timestamp).getTime() > 10 * 60_000)) {
            patch.result = 'Review is over 10 minutes old; no delayed automatic timeout.';
            return patch;
        }
        const channel = await state.guild.channels.fetch(entry.channel_id);
        if (!eligibleChannel(channel, lastControl, config, state)) return { ...patch, result: 'Channel is no longer in moderation scope.' };
        for (const evidence of entry.evidence) {
            let message;
            try { message = await channel.messages.fetch({ message: evidence.id, force: true }); }
            catch (error) { if (error.code !== 10008) throw error; }
            if (!message || snapshotMessage(message).version !== evidence.version) {
                if (message) await handleMessage(message, lastControl);
                return { outcome: 'stale', needs_review: false, result: 'Evidence was edited or deleted after review; no timeout applied.' };
            }
        }
        const member = await state.guild.members.fetch({ user: entry.user_id, force: true });
        if (isProtected(member, state.guild, state.roleIds) || !member.moderatable) {
            return { ...patch, result: 'Owner, staff, administrator or role hierarchy prevents an automatic timeout. Human review required.' };
        }
        if (member.communicationDisabledUntilTimestamp > now()) {
            if (Math.abs(member.communicationDisabledUntilTimestamp - new Date(entry.timeout_until).getTime()) < 1000) {
                return { outcome: 'timed_out', needs_review: entry.needs_review, result: `${entry.timeout_minutes}-minute timeout already applied by this case; recovered without extending it.` };
            }
            return { outcome: 'already_timed_out', needs_review: entry.needs_review, result: 'Member already has a timeout; it was not changed.' };
        }
        if (stopped) return null;
        await member.disableCommunicationUntil(new Date(entry.timeout_until), `AI moderation ${entry.id}: ${entry.category}. ${entry.reason}`.slice(0, 450));
        return { outcome: 'timed_out', needs_review: entry.needs_review, result: `${entry.timeout_minutes}-minute timeout applied. No automatic ban.` };
    }

    async function processCases(state) {
        assertPrivateLog(state, client.user.id);
        const cases = await store.unfinishedCases(state.guild.id);
        for (const candidate of cases) {
            if (stopped) return;
            await store.withLock(`member:${state.guild.id}:${candidate.user_id}`, async () => {
                let entry = await store.getCase(candidate.id);
                if (!entry || entry.dismissed_by || stopped) return;
                if (entry.outcome === 'pending') {
                    let patch;
                    try { patch = await actOnCase(entry, state); }
                    catch (error) { patch = { outcome: 'action_failed', needs_review: true, result: `Automatic action failed: ${String(error.message).slice(0, 400)}` }; }
                    if (!patch || stopped) return;
                    await store.updateCase(entry.id, patch);
                    entry = { ...entry, ...patch };
                }
                if (!entry.log_message_id && !stopped) {
                    assertPrivateLog(state, client.user.id);
                    const message = await state.logChannel.send({ ...buildCasePayload(entry, state.roleIds), nonce: entry.id, enforceNonce: true });
                    await store.updateCase(entry.id, { log_message_id: message.id, log_channel_id: state.logChannel.id });
                }
            });
        }
    }

    async function tick(control = lastControl) {
        if (running) return running;
        if (stopped || !config.enabled || !config.apiKey || !client.isReady() || control?.desiredEnabled === false) return;
        lastControl = control;
        running = (async () => {
            await ensure(control);
            // Finish persisted actions/notifications before considering new messages.
            for (const state of states.values()) await processCases(state).catch((error) => report(`cases:${state.guild.id}`, error, state));
            if (stopped) return;
            const pending = await store.pendingChannels([...states.keys()]);
            // Two channels can run concurrently; never overlap reviews of the same channel.
            let index = 0;
            const worker = async () => {
                while (index < pending.length && !stopped) {
                    const item = pending[index++];
                    await reviewChannel(item, control).catch((error) => report(`channel:${item.channel_id}`, error, states.get(item.guild_id)));
                }
            };
            await Promise.all([worker(), worker()]);
            for (const state of states.values()) if (!stopped) await processCases(state).catch((error) => report(`cases:${state.guild.id}`, error, state));
            if (!stopped && now() - lastCleanup > 60 * 60_000) { await store.cleanup(); lastCleanup = now(); }
        })().catch((error) => report('cycle', error)).finally(() => { running = null; });
        return running;
    }

    function start(controlProvider) {
        if (timer || stopped) return;
        getControl = controlProvider;
        timer = setIntervalFn(() => { void tick(getControl()); }, INTERVAL_MS);
        timer.unref?.();
    }

    async function stop() {
        stopped = true;
        if (timer) clearIntervalFn(timer);
        timer = null;
        for (const controller of controllers) controller.abort();
        await running;
        await ensuring?.catch(() => {});
    }

    async function handleInteraction(interaction) {
        if (!interaction.isButton?.() || !interaction.customId.startsWith('ai_mod:')) return false;
        await interaction.deferReply({ ephemeral: true });
        const [, action, id] = interaction.customId.split(':');
        const state = states.get(interaction.guildId);
        if (!state || !['dismiss', 'reviewed'].includes(action)) { await interaction.editReply('Moderation is unavailable.'); return true; }
        const moderator = await state.guild.members.fetch({ user: interaction.user.id, force: true });
        const authorized = moderator.id === state.guild.ownerId || moderator.permissions.has(P.ModerateMembers)
            || moderator.permissions.has(P.Administrator) || state.roleIds.some((roleId) => moderator.roles.cache.has(roleId));
        if (!authorized) { await interaction.editReply('Only moderators can review these cases.'); return true; }
        const original = await store.getCase(id);
        if (!original || original.guild_id !== interaction.guildId || original.log_message_id !== interaction.message.id || original.log_channel_id !== interaction.channelId) {
            await interaction.editReply('This moderation case could not be verified.'); return true;
        }
        const locked = await store.withLock(`member:${state.guild.id}:${original.user_id}`, async () => {
            let entry = await store.getCase(id);
            if (entry.dismissed_by) { await interaction.editReply('This case was already dismissed.'); return; }
            let patch = { reviewed_by: moderator.id, reviewed_at: new Date(now()).toISOString() };
            if (action === 'dismiss') {
                let note = 'No active timeout from this case needed removing.';
                const member = await state.guild.members.fetch({ user: entry.user_id, force: true }).catch((error) => {
                    if (error.code === 10007) return null;
                    throw error;
                });
                if (member?.communicationDisabledUntilTimestamp > now()) {
                    if (entry.outcome === 'timed_out' && Math.abs(member.communicationDisabledUntilTimestamp - new Date(entry.timeout_until).getTime()) < 1000) {
                        await member.disableCommunicationUntil(null, `Moderator ${moderator.id} dismissed AI case ${id}`);
                        note = 'The timeout applied by this case was removed.';
                    } else note = 'A different or subsequently changed timeout was left in place.';
                }
                patch = { ...patch, dismissed_by: moderator.id, dismissed_at: new Date(now()).toISOString(), dismissal_note: note };
            }
            await store.updateCase(id, patch);
            entry = { ...entry, ...patch };
            await interaction.message.edit({ ...buildCasePayload(entry, state.roleIds), allowedMentions: { parse: [], users: [], roles: [] } });
            await interaction.editReply(action === 'dismiss' ? `Case dismissed. ${entry.dismissal_note}` : 'Marked reviewed. Any ban decision remains with moderators.');
        });
        if (!locked) await interaction.editReply('This member is being reviewed. Please try again shortly.');
        return true;
    }

    return { ensure, handleMessage, handleDelete, handleInteraction, start, stop, tick, getError: () => healthError };
}

module.exports = { createModerationSystem, readConfig, eligibleChannel, resolveModeratorRoles, makeCase, buildCasePayload, LOG_TOPIC };
