const { methodNotAllowed, readJsonBody, sendJson } = require('../_lib/http');
const { requireAdmin } = require('../_lib/admin-auth');
const {
    getDiscordBotControl,
    updateDiscordBotControl
} = require('../_lib/discord-bot-control-store');
const { getStoredGameConfig } = require('../_lib/admin-game-config-store');
const {
    getDiscordTicketTranscript,
    listDiscordTicketTranscripts
} = require('../_lib/discord-ticket-store');

const DISCORD_API_BASE_URL = 'https://discord.com/api/v10';
const DISCORD_BOT_TOKEN = String(process.env.DISCORD_BOT_TOKEN || '').trim();
const CHANNEL_LOOKUP_CACHE_TTL_MS = 60 * 1000;
const DISCORD_LOOKUP_TIMEOUT_MS = Number.parseInt(process.env.DISCORD_LOOKUP_TIMEOUT_MS || '5000', 10);
const DISCORD_ANNOUNCEMENT_REACTIONS = ['🔥', '🎉', '👀', '❤️', '💯'];
const DISCORD_ADD_REACTIONS_PERMISSION = 1n << 6n;
const MAX_ANNOUNCEMENT_TITLE_LENGTH = 120;
const MAX_ANNOUNCEMENT_BODY_LENGTH = 3500;
const DISCORD_REACTION_DELAY_MS = 350;
const DISCORD_REACTION_MAX_ATTEMPTS = 4;
const channelLookupCache = new Map();
const channelLookupInflight = new Map();
const roleLookupCache = new Map();
const roleLookupInflight = new Map();

async function discordApiRequest(pathname, options) {
    if (!DISCORD_BOT_TOKEN) {
        throw new Error('DISCORD_BOT_TOKEN is not configured for Discord bot actions');
    }

    const settings = options || {};
    const response = await fetch(`${DISCORD_API_BASE_URL}${pathname}`, {
        method: settings.method || 'GET',
        headers: {
            Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
            ...(settings.body ? { 'Content-Type': 'application/json' } : {}),
            ...(settings.headers || {})
        },
        body: settings.body ? JSON.stringify(settings.body) : undefined,
        signal: AbortSignal.timeout(Number.isFinite(DISCORD_LOOKUP_TIMEOUT_MS) && DISCORD_LOOKUP_TIMEOUT_MS >= 1000
            ? DISCORD_LOOKUP_TIMEOUT_MS
            : 5000)
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(payload && payload.message ? payload.message : `Discord API failed (${response.status})`);
        error.status = response.status;
        error.payload = payload;
        throw error;
    }

    return payload;
}

async function discordApiGet(pathname) {
    return discordApiRequest(pathname);
}

async function discordApiPut(pathname, body) {
    return discordApiRequest(pathname, {
        method: 'PUT',
        body
    });
}

async function discordApiPatch(pathname, body) {
    return discordApiRequest(pathname, {
        method: 'PATCH',
        body
    });
}

async function discordApiPost(pathname, body) {
    return discordApiRequest(pathname, {
        method: 'POST',
        body
    });
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function getGuildDiscoveryChannelIds(control) {
    const startup = control && control.startupContentSync && typeof control.startupContentSync === 'object'
        ? control.startupContentSync
        : {};

    return [
        startup.rulesChannelId,
        startup.infoChannelId,
        startup.rolesChannelId,
        startup.staffInfoChannelId,
        startup.gameTestInfoChannelId,
        control && control.gameUpdates ? control.gameUpdates.channelId : null,
        control && control.ticketSystem ? control.ticketSystem.categoryChannelId : null,
        control && control.ticketSystem ? control.ticketSystem.panelChannelId : null,
        control && control.levelSystem ? control.levelSystem.announcementChannelId : null
    ]
        .filter(Boolean)
        .map((value) => String(value));
}

async function resolveDiscordGuildId(control) {
    if (control && control.guildId) {
        return String(control.guildId);
    }

    const configuredGuildId = String(process.env.DISCORD_BOT_GUILD_ID || '').trim();
    if (configuredGuildId) {
        return configuredGuildId;
    }

    for (const channelId of getGuildDiscoveryChannelIds(control)) {
        try {
            const channel = await discordApiGet(`/channels/${encodeURIComponent(channelId)}`);
            if (channel && channel.guild_id) {
                return String(channel.guild_id);
            }
        } catch (error) {
            continue;
        }
    }

    return '';
}

function buildDiscordChannelLookup(channels) {
    const categoryById = new Map(
        channels
            .filter((channel) => channel && Number(channel.type) === 4)
            .map((channel) => [String(channel.id), String(channel.name || '')])
    );

    const mapped = channels
        .filter((channel) => channel && channel.id && channel.name)
        .map((channel) => ({
            id: String(channel.id),
            name: String(channel.name),
            type: Number(channel.type),
            parentId: channel.parent_id ? String(channel.parent_id) : '',
            parentName: channel.parent_id && categoryById.has(String(channel.parent_id))
                ? categoryById.get(String(channel.parent_id))
                : ''
        }));

    mapped.sort((left, right) => {
        const leftCategory = left.parentName || '';
        const rightCategory = right.parentName || '';
        if (leftCategory !== rightCategory) {
            return leftCategory.localeCompare(rightCategory);
        }

        if (left.type !== right.type) {
            return left.type - right.type;
        }

        return left.name.localeCompare(right.name);
    });

    return mapped;
}

function buildDiscordRoleLookup(roles, guildId) {
    const mapped = roles
        .filter((role) => role && role.id && role.name && String(role.id) !== String(guildId))
        .map((role) => ({
            id: String(role.id),
            name: String(role.name),
            managed: Boolean(role.managed),
            position: Number(role.position || 0)
        }));

    mapped.sort((left, right) => {
        if (left.position !== right.position) {
            return right.position - left.position;
        }

        return left.name.localeCompare(right.name);
    });

    return mapped;
}

async function getDiscordChannelLookup(control) {
    try {
        const guildId = await resolveDiscordGuildId(control);
        if (!guildId) {
            return {
                guildId: '',
                channels: []
            };
        }

        const cached = channelLookupCache.get(guildId);
        if (cached && (Date.now() - cached.fetchedAt) < CHANNEL_LOOKUP_CACHE_TTL_MS) {
            return {
                guildId,
                channels: cached.channels
            };
        }

        if (channelLookupInflight.has(guildId)) {
            return await channelLookupInflight.get(guildId);
        }

        const pendingLookup = (async () => {
            try {
                const channels = await discordApiGet(`/guilds/${encodeURIComponent(guildId)}/channels`);
                const mappedChannels = buildDiscordChannelLookup(Array.isArray(channels) ? channels : []);
                channelLookupCache.set(guildId, {
                    fetchedAt: Date.now(),
                    channels: mappedChannels
                });
                return {
                    guildId,
                    channels: mappedChannels
                };
            } catch (error) {
                if (cached && Array.isArray(cached.channels) && cached.channels.length) {
                    return {
                        guildId,
                        channels: cached.channels
                    };
                }

                return {
                    guildId: '',
                    channels: [],
                    error: String(error.message || error)
                };
            } finally {
                channelLookupInflight.delete(guildId);
            }
        })();

        channelLookupInflight.set(guildId, pendingLookup);
        return await pendingLookup;
    } catch (error) {
        return {
            guildId: '',
            channels: [],
            error: String(error.message || error)
        };
    }
}

async function getDiscordRoleLookup(control) {
    try {
        const guildId = await resolveDiscordGuildId(control);
        if (!guildId) {
            return {
                guildId: '',
                roles: []
            };
        }

        const cached = roleLookupCache.get(guildId);
        if (cached && (Date.now() - cached.fetchedAt) < CHANNEL_LOOKUP_CACHE_TTL_MS) {
            return {
                guildId,
                roles: cached.roles
            };
        }

        if (roleLookupInflight.has(guildId)) {
            return await roleLookupInflight.get(guildId);
        }

        const pendingLookup = (async () => {
            try {
                const roles = await discordApiGet(`/guilds/${encodeURIComponent(guildId)}/roles`);
                const mappedRoles = buildDiscordRoleLookup(Array.isArray(roles) ? roles : [], guildId);
                roleLookupCache.set(guildId, {
                    fetchedAt: Date.now(),
                    roles: mappedRoles
                });
                return {
                    guildId,
                    roles: mappedRoles
                };
            } catch (error) {
                if (cached && Array.isArray(cached.roles) && cached.roles.length) {
                    return {
                        guildId,
                        roles: cached.roles
                    };
                }

                return {
                    guildId: '',
                    roles: [],
                    error: String(error.message || error)
                };
            } finally {
                roleLookupInflight.delete(guildId);
            }
        })();

        roleLookupInflight.set(guildId, pendingLookup);
        return await pendingLookup;
    } catch (error) {
        return {
            guildId: '',
            roles: [],
            error: String(error.message || error)
        };
    }
}

async function getDiscordLookupPayload(control) {
    const [channelLookup, roleLookup] = await Promise.all([
        getDiscordChannelLookup(control),
        getDiscordRoleLookup(control)
    ]);

    return {
        channelLookup,
        roleLookup
    };
}

function parseDiscordSnowflake(value, fieldName) {
    const trimmed = String(value || '').trim();
    if (!/^\d{5,25}$/.test(trimmed)) {
        throw new Error(`${fieldName} must be a valid Discord ID`);
    }

    return trimmed;
}

function normalizeAnnouncementText(value, fieldName, maxLength) {
    const normalized = String(value || '').replace(/\r\n/g, '\n').trim();
    if (!normalized) {
        throw new Error(`${fieldName} is required`);
    }

    if (normalized.length > maxLength) {
        throw new Error(`${fieldName} must be ${maxLength} characters or fewer`);
    }

    return normalized;
}

function stripTrailingPlayNow(value) {
    return String(value || '')
        .replace(/\n{0,3}\s*(?:\*\*)?Play now(?:\*\*)?\s*:?\s+https?:\/\/\S+\s*$/i, '')
        .trim();
}

async function fetchProductionGameLink() {
    const gameConfig = await getStoredGameConfig();
    const universeId = Number(gameConfig && gameConfig.productionUniverseId);
    if (!Number.isFinite(universeId) || universeId <= 0) {
        throw new Error('Production universe ID is not configured');
    }

    const endpoint = new URL('https://games.roblox.com/v1/games');
    endpoint.searchParams.set('universeIds', String(universeId));
    const response = await fetch(endpoint, {
        method: 'GET',
        headers: {
            Accept: 'application/json'
        },
        signal: AbortSignal.timeout(8000)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(`Roblox game lookup failed (${response.status})`);
    }

    const row = Array.isArray(payload && payload.data) ? payload.data[0] : null;
    const rootPlaceId = Number(row && row.rootPlaceId);
    if (!Number.isFinite(rootPlaceId) || rootPlaceId <= 0) {
        throw new Error('Production game root place ID was not returned by Roblox');
    }

    return {
        universeId,
        rootPlaceId,
        name: row && row.name ? String(row.name) : 'Production game',
        url: `https://www.roblox.com/games/${encodeURIComponent(String(rootPlaceId))}`
    };
}

function applyAddReactionsDeny(channel) {
    const guildId = channel && channel.guild_id ? String(channel.guild_id) : '';
    const overwrites = Array.isArray(channel && channel.permission_overwrites)
        ? channel.permission_overwrites
        : [];
    const everyoneOverwrite = overwrites.find((overwrite) => {
        return String(overwrite && overwrite.id) === guildId && Number(overwrite && overwrite.type) === 0;
    }) || {};
    const currentAllow = BigInt(String(everyoneOverwrite.allow || '0'));
    const currentDeny = BigInt(String(everyoneOverwrite.deny || '0'));
    const nextAllow = currentAllow & ~DISCORD_ADD_REACTIONS_PERMISSION;
    const nextDeny = currentDeny | DISCORD_ADD_REACTIONS_PERMISSION;

    return {
        changed: nextAllow !== currentAllow || nextDeny !== currentDeny,
        allow: nextAllow.toString(),
        deny: nextDeny.toString()
    };
}

async function ensureGameUpdatesChannelReactionPolicy(channelId) {
    const channel = await discordApiGet(`/channels/${encodeURIComponent(channelId)}`);
    const channelType = Number(channel && channel.type);
    if (![0, 5].includes(channelType)) {
        throw new Error('Game updates channel must be a Discord text or announcement channel');
    }

    const guildId = channel && channel.guild_id ? String(channel.guild_id) : '';
    if (!guildId) {
        throw new Error('Game updates channel must belong to a Discord server');
    }

    const permissionUpdate = applyAddReactionsDeny(channel);
    if (permissionUpdate.changed) {
        await discordApiPut(`/channels/${encodeURIComponent(channelId)}/permissions/${encodeURIComponent(guildId)}`, {
            type: 0,
            allow: permissionUpdate.allow,
            deny: permissionUpdate.deny
        });
    }

    return {
        guildId,
        channelName: channel && channel.name ? String(channel.name) : '',
        reactionRestrictionApplied: true
    };
}

async function addAnnouncementReactions(channelId, messageId) {
    if (!messageId) {
        throw new Error('Discord did not return an announcement message ID');
    }

    const addedReactions = [];
    const failedReactions = [];
    for (const emoji of DISCORD_ANNOUNCEMENT_REACTIONS) {
        let added = false;
        let lastError = null;

        for (let attempt = 1; attempt <= DISCORD_REACTION_MAX_ATTEMPTS; attempt += 1) {
            try {
                await discordApiPut(
                    `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(emoji)}/@me`,
                    null
                );
                added = true;
                addedReactions.push(emoji);
                break;
            } catch (error) {
                lastError = error;
                const retryAfterSeconds = Number(error && error.payload && error.payload.retry_after);
                const retryAfterMs = Number.isFinite(retryAfterSeconds)
                    ? Math.ceil(retryAfterSeconds * 1000)
                    : 0;
                const shouldRetry = Number(error && error.status) === 429 || attempt < 2;
                if (!shouldRetry || attempt >= DISCORD_REACTION_MAX_ATTEMPTS) {
                    break;
                }

                await sleep(Math.max(DISCORD_REACTION_DELAY_MS, Math.min(retryAfterMs || DISCORD_REACTION_DELAY_MS, 5000)));
            }
        }

        if (!added) {
            failedReactions.push({
                emoji,
                error: lastError && lastError.message ? String(lastError.message) : 'Unknown Discord reaction error'
            });
        }

        await sleep(DISCORD_REACTION_DELAY_MS);
    }

    if (failedReactions.length) {
        console.warn('[discord-game-updates] Failed to add some announcement reactions:', failedReactions);
    }

    return {
        addedReactions,
        failedReactions
    };
}

async function clearAnnouncementPingContent(channelId, messageId) {
    if (!messageId) {
        return;
    }

    await discordApiPatch(
        `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
        {
            content: '',
            allowed_mentions: {
                parse: []
            }
        }
    );
}

async function sendGameUpdateAnnouncement(body, user) {
    const announcement = body && typeof body.gameUpdateAnnouncement === 'object' && body.gameUpdateAnnouncement
        ? body.gameUpdateAnnouncement
        : {};
    const currentControl = await getDiscordBotControl();
    const channelId = parseDiscordSnowflake(
        announcement.channelId || (currentControl && currentControl.gameUpdates && currentControl.gameUpdates.channelId),
        'Game updates channel ID'
    );
    const title = normalizeAnnouncementText(
        announcement.title,
        'Announcement title',
        MAX_ANNOUNCEMENT_TITLE_LENGTH
    );
    const bodyText = stripTrailingPlayNow(normalizeAnnouncementText(
        announcement.body,
        'Announcement body',
        MAX_ANNOUNCEMENT_BODY_LENGTH
    ));
    if (!bodyText) {
        throw new Error('Announcement body is required');
    }

    const [playLink, channelPolicy] = await Promise.all([
        fetchProductionGameLink(),
        ensureGameUpdatesChannelReactionPolicy(channelId)
    ]);
    const description = `${bodyText}\n\n**Play now:** ${playLink.url}`;
    if (description.length > 4096) {
        throw new Error('Announcement body is too long once the Play now link is added');
    }

    const message = await discordApiPost(`/channels/${encodeURIComponent(channelId)}/messages`, {
        content: '@everyone',
        embeds: [
            {
                title,
                description,
                color: 0xf97316,
                timestamp: new Date().toISOString(),
                footer: {
                    text: 'RoDark Studios Game Update'
                }
            }
        ],
        allowed_mentions: {
            parse: ['everyone']
        }
    });

    await clearAnnouncementPingContent(channelId, String(message && message.id));
    const reactionResult = await addAnnouncementReactions(channelId, String(message && message.id));
    const control = await updateDiscordBotControl({ gameUpdatesChannelId: channelId }, user);

    return {
        control,
        announcement: {
            channelId,
            channelName: channelPolicy.channelName,
            messageId: message && message.id ? String(message.id) : '',
            messageUrl: `https://discord.com/channels/${channelPolicy.guildId}/${channelId}/${message && message.id ? String(message.id) : ''}`,
            reactions: DISCORD_ANNOUNCEMENT_REACTIONS,
            addedReactions: reactionResult.addedReactions,
            failedReactions: reactionResult.failedReactions,
            playUrl: playLink.url,
            productionUniverseId: playLink.universeId,
            productionRootPlaceId: playLink.rootPlaceId,
            reactionRestrictionApplied: channelPolicy.reactionRestrictionApplied
        }
    };
}

module.exports = async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'POST') {
        return methodNotAllowed(req, res, ['GET', 'POST']);
    }

    try {
        const auth = await requireAdmin(req, res);
        if (!auth.user) {
            return sendJson(res, 401, { error: 'Not authenticated' });
        }
        if (!auth.isAdmin) {
            return sendJson(res, 403, { error: 'Admin access required' });
        }

        if (req.method === 'GET') {
            if (req.query && Object.prototype.hasOwnProperty.call(req.query, 'ticketTranscripts')) {
                const transcripts = await listDiscordTicketTranscripts(req.query.limit, req.query.offset);
                return sendJson(res, 200, { transcripts });
            }

            if (req.query && req.query.ticketTranscriptId) {
                const transcript = await getDiscordTicketTranscript(req.query.ticketTranscriptId);
                if (!transcript) {
                    return sendJson(res, 404, { error: 'Ticket transcript not found' });
                }

                return sendJson(res, 200, { transcript });
            }

            const control = await getDiscordBotControl();
            if (req.query && req.query.includeLookups === '0') {
                return sendJson(res, 200, {
                    control,
                    channelLookup: {
                        guildId: control && control.guildId ? String(control.guildId) : '',
                        channels: []
                    },
                    roleLookup: {
                        guildId: control && control.guildId ? String(control.guildId) : '',
                        roles: []
                    }
                });
            }

            const { channelLookup, roleLookup } = await getDiscordLookupPayload(control);
            return sendJson(res, 200, {
                control,
                channelLookup,
                roleLookup
            });
        }

        const body = await readJsonBody(req);
        const operation = String(body && body.operation ? body.operation : '').trim().toLowerCase();
        if (operation === 'game-update:send') {
            const payload = await sendGameUpdateAnnouncement(body, auth.user);
            const { channelLookup, roleLookup } = await getDiscordLookupPayload(payload.control);
            return sendJson(res, 200, {
                control: payload.control,
                channelLookup,
                roleLookup,
                announcement: payload.announcement
            });
        }

        const startupContentSync = body && typeof body.startupContentSync === 'object' && body.startupContentSync
            ? body.startupContentSync
            : null;
        const gameUpdates = body && typeof body.gameUpdates === 'object' && body.gameUpdates
            ? body.gameUpdates
            : null;
        const ticketSystem = body && typeof body.ticketSystem === 'object' && body.ticketSystem
            ? body.ticketSystem
            : null;
        const levelSystem = body && typeof body.levelSystem === 'object' && body.levelSystem
            ? body.levelSystem
            : null;
        const leaderboardRole = body && typeof body.leaderboardRole === 'object' && body.leaderboardRole
            ? body.leaderboardRole
            : null;
        const patch = {};

        if (body && Object.prototype.hasOwnProperty.call(body, 'desiredEnabled')) {
            patch.desiredEnabled = Boolean(body.desiredEnabled);
        }

        if (body && Object.prototype.hasOwnProperty.call(body, 'guildId')) {
            patch.guildId = body.guildId;
        }

        if (startupContentSync && Object.prototype.hasOwnProperty.call(startupContentSync, 'rulesChannelId')) {
            patch.contentRulesChannelId = startupContentSync.rulesChannelId;
        }

        if (startupContentSync && Object.prototype.hasOwnProperty.call(startupContentSync, 'infoChannelId')) {
            patch.contentInfoChannelId = startupContentSync.infoChannelId;
        }

        if (startupContentSync && Object.prototype.hasOwnProperty.call(startupContentSync, 'rolesChannelId')) {
            patch.contentRolesChannelId = startupContentSync.rolesChannelId;
        }

        if (startupContentSync && Object.prototype.hasOwnProperty.call(startupContentSync, 'staffInfoChannelId')) {
            patch.contentStaffInfoChannelId = startupContentSync.staffInfoChannelId;
        }

        if (startupContentSync && Object.prototype.hasOwnProperty.call(startupContentSync, 'gameTestInfoChannelId')) {
            patch.contentGameTestInfoChannelId = startupContentSync.gameTestInfoChannelId;
        }

        if (gameUpdates && Object.prototype.hasOwnProperty.call(gameUpdates, 'channelId')) {
            patch.gameUpdatesChannelId = gameUpdates.channelId;
        }

        if (ticketSystem && Object.prototype.hasOwnProperty.call(ticketSystem, 'categoryChannelId')) {
            patch.ticketsCategoryChannelId = ticketSystem.categoryChannelId;
        }

        if (ticketSystem && Object.prototype.hasOwnProperty.call(ticketSystem, 'panelChannelId')) {
            patch.ticketsPanelChannelId = ticketSystem.panelChannelId;
        }

        if (ticketSystem && Object.prototype.hasOwnProperty.call(ticketSystem, 'helperRoleIds')) {
            patch.ticketsHelperRoleIds = ticketSystem.helperRoleIds;
        }

        if (levelSystem && Object.prototype.hasOwnProperty.call(levelSystem, 'enabled')) {
            patch.levelSystemEnabled = levelSystem.enabled;
        }

        if (levelSystem && Object.prototype.hasOwnProperty.call(levelSystem, 'announcementChannelId')) {
            patch.levelAnnouncementChannelId = levelSystem.announcementChannelId;
        }

        if (levelSystem && Object.prototype.hasOwnProperty.call(levelSystem, 'attachmentUnlockLevel')) {
            patch.levelAttachmentUnlockLevel = levelSystem.attachmentUnlockLevel;
        }

        if (levelSystem && Object.prototype.hasOwnProperty.call(levelSystem, 'mentionLevelUps')) {
            patch.levelMentionEnabled = levelSystem.mentionLevelUps;
        }

        if (leaderboardRole && Object.prototype.hasOwnProperty.call(leaderboardRole, 'enabled')) {
            patch.leaderboardRoleEnabled = leaderboardRole.enabled;
        }

        if (leaderboardRole && Object.prototype.hasOwnProperty.call(leaderboardRole, 'orderedDataStoreName')) {
            patch.leaderboardRoleOrderedDataStoreName = leaderboardRole.orderedDataStoreName;
        }

        if (leaderboardRole && Object.prototype.hasOwnProperty.call(leaderboardRole, 'orderedDataStoreScope')) {
            patch.leaderboardRoleOrderedDataStoreScope = leaderboardRole.orderedDataStoreScope;
        }

        if (leaderboardRole && Object.prototype.hasOwnProperty.call(leaderboardRole, 'keyPrefix')) {
            patch.leaderboardRoleKeyPrefix = leaderboardRole.keyPrefix;
        }

        if (leaderboardRole && Object.prototype.hasOwnProperty.call(leaderboardRole, 'topSize')) {
            patch.leaderboardRoleTopSize = leaderboardRole.topSize;
        }

        if (leaderboardRole && Object.prototype.hasOwnProperty.call(leaderboardRole, 'roleId')) {
            patch.leaderboardRoleId = leaderboardRole.roleId;
        }

        if (leaderboardRole && Object.prototype.hasOwnProperty.call(leaderboardRole, 'roleName')) {
            patch.leaderboardRoleName = leaderboardRole.roleName;
        }

        if (leaderboardRole && Object.prototype.hasOwnProperty.call(leaderboardRole, 'hoist')) {
            patch.leaderboardRoleHoist = leaderboardRole.hoist;
        }

        if (leaderboardRole && Object.prototype.hasOwnProperty.call(leaderboardRole, 'iconDataUrl')) {
            patch.leaderboardRoleIconDataUrl = leaderboardRole.iconDataUrl;
        }

        if (leaderboardRole && Object.prototype.hasOwnProperty.call(leaderboardRole, 'clearIcon')) {
            patch.leaderboardRoleIconClear = leaderboardRole.clearIcon;
        }

        const control = await updateDiscordBotControl(patch, auth.user);
        const { channelLookup, roleLookup } = await getDiscordLookupPayload(control);
        return sendJson(res, 200, { control, channelLookup, roleLookup });
    } catch (error) {
        const statusCode = /required|valid discord id|must be a valid discord id|unlock level|orderedDataStore|leaderboard|role icon|uploaded image|announcement|game updates channel|production universe/i.test(String(error && error.message || ''))
            ? 400
            : 500;
        return sendJson(res, statusCode, {
            error: 'Failed to update Discord bot control',
            details: error.message
        });
    }
};
