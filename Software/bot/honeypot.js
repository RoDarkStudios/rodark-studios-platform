const {
    ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder,
    MessageType, OverwriteType, PermissionFlagsBits: P
} = require('discord.js');
const defaultStore = require('../api/_lib/discord-honeypot-store');

const CHANNEL_NAME = 'ignore│do-not-type';
const WARNING_TITLE = 'DO NOT SEND MESSAGES IN THIS CHANNEL';
const WARNING_MARKER = 'RoDark Studios • Honeypot';
const TOPIC = 'DO NOT TYPE HERE. Any message, image, file, link or reply triggers an immediate permanent ban. This is a spam trap.';
const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const DELETE_MESSAGE_SECONDS = 60 * 60;
const PUBLIC_PERMISSIONS = [P.ViewChannel, P.ReadMessageHistory, P.SendMessages, P.AttachFiles, P.EmbedLinks];
const DENIED_PERMISSIONS = [P.MentionEveryone, P.CreatePublicThreads, P.CreatePrivateThreads, P.SendMessagesInThreads];
const BOT_PERMISSIONS = [...PUBLIC_PERMISSIONS, P.ManageMessages, P.ManageRoles];
const PIN_MESSAGES = P.PinMessages || (1n << 51n);

function isHoneypotName(name) {
    return String(name || '').toLowerCase().replace(/[\s_|│┃｜︱-]/g, '') === 'ignoredonottype';
}

function buildWarning(banCount) {
    return {
        content: '',
        embeds: [new EmbedBuilder()
            .setColor(0xf59e0b)
            .setTitle(WARNING_TITLE)
            .setDescription('This channel catches spam bots and compromised accounts. **Any message sent here will result in an immediate permanent ban.**\n\nDo not test it. This includes text, images, files, links, stickers and replies—even an accidental message. Use the community channels to chat.')
            .setFooter({ text: WARNING_MARKER })],
        components: [new ActionRowBuilder().addComponents(new ButtonBuilder()
            .setCustomId('honeypot:ban-count')
            .setLabel(`Bans: ${banCount}`)
            .setEmoji('🍯')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true))],
        allowedMentions: { parse: [] }
    };
}

function permissionOverwrites(guildId, botId, open = true) {
    return [
        {
            id: guildId, type: OverwriteType.Role,
            allow: open ? PUBLIC_PERMISSIONS : [P.ViewChannel, P.ReadMessageHistory],
            deny: open ? DENIED_PERMISSIONS : [...DENIED_PERMISSIONS, P.SendMessages]
        },
        { id: botId, type: OverwriteType.Member, allow: BOT_PERMISSIONS, deny: [] }
    ];
}

function overwritesMatch(channel, desired) {
    const bits = (values) => values.reduce((result, value) => result | value, 0n);
    return channel.permissionOverwrites.cache.size === desired.length && desired.every((entry) => {
        const current = channel.permissionOverwrites.cache.get(entry.id);
        return current && current.type === entry.type
            && current.allow.bitfield === bits(entry.allow) && current.deny.bitfield === bits(entry.deny);
    });
}

function isOwnWarning(message, botId) {
    return message && !message.webhookId && message.author.id === botId
        && message.embeds.some((embed) => embed.footer?.text === WARNING_MARKER);
}

async function fetchWarning(channel, messageId) {
    if (!messageId) return null;
    try {
        return await channel.messages.fetch(messageId);
    } catch (error) {
        if (error.code === 10008) return null; // Unknown Message, not a permission/network failure.
        throw error;
    }
}

function createHoneypotSystem(client, { store = defaultStore } = {}) {
    const states = new Map();
    const inFlightBans = new Map();
    const recentBans = new Map();
    const pendingBanRecords = new Map();
    const warningUpdates = new Map();
    let syncPromise;
    let lastSyncAt = 0;
    let lastGuildIds = '';

    // Serialize edits so simultaneous bans cannot move the displayed counter backwards.
    function updateWarning(channel, state) {
        const guildId = channel.guild.id;
        const previous = warningUpdates.get(guildId) || Promise.resolve();
        const update = previous.catch(() => {}).then(async () => {
            const saved = await store.getState(guildId);
            let warning = await fetchWarning(channel, state.warningMessageId);
            if (!isOwnWarning(warning, client.user.id)) {
                const messages = await channel.messages.fetch({ limit: 100 });
                warning = messages.find((message) => isOwnWarning(message, client.user.id));
            }
            const payload = buildWarning(saved?.banCount || 0);
            warning = warning ? await warning.edit(payload) : await channel.send(payload);
            state.warningMessageId = warning.id;
            await store.saveState(guildId, channel.id, warning.id);
            // The warning stands alone; pinning only adds a redundant system notice.
            // Migrate warnings pinned by earlier versions without delaying protection
            // if Discord temporarily rejects this cosmetic cleanup.
            try {
                if (warning.pinned && channel.permissionsFor(client.user.id)?.has(PIN_MESSAGES)) {
                    await warning.unpin('The honeypot warning does not need pinning');
                    state.pinNoticesCleaned = false;
                }
                if (!state.pinNoticesCleaned) {
                    const messages = await channel.messages.fetch({ limit: 100 });
                    for (const message of messages.values()) {
                        if (message.type === MessageType.ChannelPinnedMessage && message.author?.id === client.user.id
                            && message.reference?.messageId === warning.id) {
                            await message.delete();
                        }
                    }
                    state.pinNoticesCleaned = true;
                }
            } catch (error) {
                console.warn(`[honeypot] Could not remove the old warning pin notice in ${channel.id}: ${error.message}`);
            }
        });
        warningUpdates.set(guildId, update);
        return update;
    }

    async function ensureGuild(guild, control) {
        const managed = control?.infrastructure?.bindings?.channel;
        const me = await guild.members.fetchMe();
        const required = [P.BanMembers, P.ManageChannels, ...BOT_PERMISSIONS];
        const missing = me.permissions.missing(required);
        if (missing.length) {
            throw new Error(`Honeypot in ${guild.name}: bot is missing ${missing.join(', ')}. Place its role above the member roles it must ban.`);
        }

        const saved = await store.getState(guild.id);
        const channels = await guild.channels.fetch();
        let channel = managed ? channels.get(managed.honeypot) : saved?.channelId ? channels.get(saved.channelId) : null;
        if (managed && !channel) throw new Error('The deployed honeypot is missing. Click Deploy on the website to restore it.');
        if (!channel) {
            const candidates = channels.filter((candidate) => candidate && candidate.type === ChannelType.GuildText && isHoneypotName(candidate.name));
            if (candidates.size > 1) {
                throw new Error(`Honeypot in ${guild.name}: multiple ignore / do-not-type channels found; keep one before setup.`);
            }
            channel = candidates.first();
        }
        if (channel && channel.type !== ChannelType.GuildText) {
            throw new Error(`Honeypot channel ${channel.id} must be a normal text channel.`);
        }
        let category = managed ? channels.get(managed['category:ignore']) : channels.find((candidate) => candidate?.type === ChannelType.GuildCategory && candidate.name === 'IGNORE');
        if (managed && !category) throw new Error('The deployed IGNORE category is missing. Click Deploy on the website to restore it.');
        if (!category) {
            category = await guild.channels.create({ name: 'IGNORE', type: ChannelType.GuildCategory, position: 1, reason: 'Separate the spam trap from normal chat' });
        }
        const categoryPosition = Math.min(1, guild.channels.cache.filter((candidate) => candidate.type === ChannelType.GuildCategory).size - 1);
        if (!managed && category.position !== categoryPosition) await category.setPosition(categoryPosition);
        if (!channel) {
            channel = await guild.channels.create({
                name: CHANNEL_NAME, type: ChannelType.GuildText, parent: category.id,
                topic: TOPIC, position: 0,
                // Publish the warning before granting send permission.
                permissionOverwrites: permissionOverwrites(guild.id, client.user.id, false),
                reason: 'Create RoDark Studios anti-spam honeypot'
            });
        }
        const state = states.get(guild.id)?.channelId === channel.id
            ? states.get(guild.id)
            : { channelId: channel.id, warningMessageId: saved?.channelId === channel.id ? saved.warningMessageId : null, armed: false };
        states.set(guild.id, state);
        await store.saveState(guild.id, channel.id, state.warningMessageId);
        // Repair bot access first, including when adopting an existing locked channel.
        const botOverwrite = permissionOverwrites(guild.id, client.user.id)[1];
        const existingBot = channel.permissionOverwrites.cache.get(client.user.id);
        if (!existingBot || !existingBot.allow.has(BOT_PERMISSIONS) || existingBot.deny.bitfield !== 0n) {
            await channel.permissionOverwrites.set([
                ...channel.permissionOverwrites.cache.filter((overwrite) => overwrite.id !== client.user.id).values(),
                botOverwrite
            ], 'Restore bot access to the honeypot warning');
        }
        await updateWarning(channel, state);
        // MESSAGE_CREATE may arrive before the channel edit response; arm before opening it.
        state.armed = true;
        const desired = permissionOverwrites(guild.id, client.user.id);
        const changes = {};
        if (channel.name !== CHANNEL_NAME) changes.name = CHANNEL_NAME;
        if (channel.topic !== TOPIC) changes.topic = TOPIC;
        if (channel.parentId !== category.id) changes.parent = category.id;
        if (channel.nsfw) changes.nsfw = false;
        if (channel.rateLimitPerUser) changes.rateLimitPerUser = 0;
        // This dedicated trap must not retain role/member denies or level gates.
        if (!overwritesMatch(channel, desired)) changes.permissionOverwrites = desired;
        if (Object.keys(changes).length) {
            await channel.edit({ ...changes, reason: 'Keep the honeypot visible and writable, including attachments and link previews' });
        }
        if (channel.position !== 0) await channel.setPosition(0);
    }

    async function ensure(control, { force = false } = {}) {
        if (!client.isReady()) return;
        if (syncPromise) return syncPromise;
        const guilds = [...client.guilds.cache.values()].filter((guild) => !control?.guildId || guild.id === String(control.guildId));
        const guildIds = guilds.map((guild) => guild.id).sort().join(',');
        if (!force && !pendingBanRecords.size && guildIds === lastGuildIds && Date.now() - lastSyncAt < SYNC_INTERVAL_MS) return;
        syncPromise = (async () => {
            // Retry counts after a transient database outage without repeating successful bans.
            for (const [messageId, record] of pendingBanRecords) {
                await store.recordBan(record);
                pendingBanRecords.delete(messageId);
            }
            for (const guildId of states.keys()) {
                if (!guilds.some((guild) => guild.id === guildId)) states.delete(guildId);
            }
            const errors = [];
            for (const guild of guilds) {
                try { await ensureGuild(guild, control); } catch (error) { errors.push(error.message); }
            }
            if (errors.length) throw new Error(errors.join('; '));
            lastGuildIds = guildIds;
            lastSyncAt = Date.now();
        })();
        try { await syncPromise; } finally { syncPromise = null; }
    }

    async function deleteTrigger(message) {
        try { await message.delete(); } catch (error) {
            if (error.code !== 10008) console.error(`[honeypot] Could not delete message ${message.id}:`, error);
        }
    }

    async function banAuthor(message, state) {
        const guild = message.guild;
        const key = `${guild.id}:${message.author.id}`;
        try {
            let member;
            try {
                member = await guild.members.fetch({ user: message.author.id, force: true });
            } catch (error) {
                if (error.code !== 10007) throw error; // Ban by ID if they posted and then left.
            }
            if (member && !member.bannable) {
                throw new Error('Discord role hierarchy or missing Ban Members permission prevents the ban');
            }
            await guild.members.ban(message.author.id, {
                deleteMessageSeconds: DELETE_MESSAGE_SECONDS,
                reason: `Honeypot: message ${message.id} in #${CHANNEL_NAME} (${message.channelId})`
            });
            recentBans.set(key, Date.now());
            console.log(`[honeypot] Banned user ${message.author.id} in guild ${guild.id}; trigger ${message.id}.`);
        } catch (error) {
            await deleteTrigger(message);
            throw new Error(`Honeypot could not ban ${message.author.id} in ${guild.id}: ${error.message}`);
        }
        await deleteTrigger(message);
        // A database/counter failure must never prevent the actual moderation action.
        const record = { id: message.id, guild: { id: guild.id }, channelId: message.channelId, author: { id: message.author.id } };
        pendingBanRecords.set(message.id, record);
        await store.recordBan(record);
        pendingBanRecords.delete(message.id);
        const channel = guild.channels.cache.get(state.channelId);
        if (channel) await updateWarning(channel, state);
    }

    async function handleMessage(message, control) {
        if (!message?.guild || (control?.guildId && message.guild.id !== String(control.guildId))) return false;
        const state = states.get(message.guild.id);
        const channelId = message.channel?.isThread() ? message.channel.parentId : message.channelId;
        if (!state || state.channelId !== channelId) return false;
        if (!state.armed || message.system || !message.author || message.author.id === client.user.id) return true;
        // Webhook authors are not guild members. Never mistake a webhook ID for a user ID.
        if (message.webhookId) {
            await deleteTrigger(message);
            throw new Error(`Honeypot received webhook ${message.webhookId} in ${message.channelId}; removed its message. Review the server's integrations.`);
        }
        for (const [key, at] of recentBans) {
            if (Date.now() - at > 60_000) recentBans.delete(key);
        }
        const key = `${message.guild.id}:${message.author.id}`;
        if (recentBans.has(key)) { await deleteTrigger(message); return true; }
        if (inFlightBans.has(key)) {
            try { await inFlightBans.get(key); } finally { await deleteTrigger(message); }
            return true;
        }
        const operation = banAuthor(message, state);
        inFlightBans.set(key, operation);
        try { await operation; } finally { inFlightBans.delete(key); }
        return true;
    }

    return { ensure, handleMessage };
}

module.exports = { createHoneypotSystem };
