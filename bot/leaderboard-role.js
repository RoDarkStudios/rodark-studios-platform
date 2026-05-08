const fs = require('fs/promises');
const path = require('path');
const { postgresQuery } = require('../api/_lib/postgres');
const { getStoredGameConfig } = require('../api/_lib/admin-game-config-store');
const {
    listOrderedDataStoreEntries,
    listOrderedDataStoreEntriesLegacy
} = require('../api/_lib/roblox-open-cloud');
const { setDiscordLeaderboardRoleId } = require('../api/_lib/discord-bot-control-store');

const DEFAULT_ROLE_NAME = 'Leaderboard Player';
const DEFAULT_SYNC_INTERVAL_MINUTES = 5;
const BLOXLINK_API_BASE_URL = String(process.env.BLOXLINK_API_BASE_URL || 'https://api.blox.link/v4').replace(/\/+$/g, '');
const BLOXLINK_API_KEY = String(process.env.BLOXLINK_API_KEY || '').trim();
const BLOXLINK_LOOKUP_CACHE_TTL_MS = Number.parseInt(process.env.BLOXLINK_LOOKUP_CACHE_TTL_MINUTES || '10', 10) * 60 * 1000;
const BLOXLINK_LOOKUPS_PER_SYNC = Math.max(1, Math.min(100, Number.parseInt(process.env.BLOXLINK_LOOKUPS_PER_SYNC || '10', 10) || 10));
const BLOXLINK_LOOKUP_DELAY_MS = Math.max(0, Number.parseInt(process.env.BLOXLINK_LOOKUP_DELAY_MS || '750', 10) || 750);
const BLOXLINK_RATE_LIMIT_BACKOFF_MS = Math.max(60 * 1000, Number.parseInt(process.env.BLOXLINK_RATE_LIMIT_BACKOFF_MS || '300000', 10) || 300000);
const DISCORD_API_BASE_URL = 'https://discord.com/api/v10';
const DISCORD_BOT_TOKEN = String(process.env.DISCORD_BOT_TOKEN || '').trim();
const DISCORD_ROLE_REQUEST_DELAY_MS = Math.max(0, Number.parseInt(process.env.DISCORD_ROLE_REQUEST_DELAY_MS || '500', 10) || 500);
const LEADERBOARD_ROLE_ICON_PATH = path.join(__dirname, 'assets', 'discord', 'role-icons', 'leaderboard-player.png');

let lastSyncAtByGuildId = new Map();
let bloxlinkLookupCache = new Map();
let bloxlinkLookupCursorByGuildId = new Map();
let bloxlinkRateLimitedUntil = 0;
let leaderboardSyncInFlightByGuildId = new Set();
let cachedLeaderboardRoleIconDataUri = null;
let roleIconSyncAttemptedByRoleId = new Set();

function getLeaderboardRoleControl(control) {
    const leaderboardRole = control && control.leaderboardRole && typeof control.leaderboardRole === 'object'
        ? control.leaderboardRole
        : {};

    const topSize = Math.max(1, Math.min(100, Number.parseInt(leaderboardRole.topSize || '100', 10) || 100));
    const syncIntervalMinutes = Math.max(1, Number.parseInt(leaderboardRole.syncIntervalMinutes || DEFAULT_SYNC_INTERVAL_MINUTES, 10) || DEFAULT_SYNC_INTERVAL_MINUTES);

    return {
        enabled: Boolean(leaderboardRole.enabled),
        orderedDataStoreName: leaderboardRole.orderedDataStoreName ? String(leaderboardRole.orderedDataStoreName).trim() : '',
        orderedDataStoreScope: leaderboardRole.orderedDataStoreScope ? String(leaderboardRole.orderedDataStoreScope).trim() : 'global',
        keyPrefix: leaderboardRole.keyPrefix ? String(leaderboardRole.keyPrefix).trim() : '',
        topSize,
        syncIntervalMinutes,
        roleId: leaderboardRole.roleId ? String(leaderboardRole.roleId) : '',
        roleName: leaderboardRole.roleName ? String(leaderboardRole.roleName).trim() : DEFAULT_ROLE_NAME,
        hoist: Boolean(leaderboardRole.hoist)
    };
}

function getLeaderboardRoleSyncKey(control) {
    const leaderboardRole = getLeaderboardRoleControl(control);
    return JSON.stringify(leaderboardRole);
}

function normalizeRobloxUserIdFromEntryKey(entryKey, keyPrefix) {
    let rawKey = String(entryKey || '').trim();
    const pathMatch = rawKey.match(/\/entries\/([^/?#]+)$/);
    if (pathMatch) {
        rawKey = decodeURIComponent(pathMatch[1]);
    }

    const prefix = String(keyPrefix || '').trim();
    if (prefix && rawKey.startsWith(prefix)) {
        rawKey = rawKey.slice(prefix.length);
    }

    const match = rawKey.match(/\d{2,20}/);
    return match ? match[0] : '';
}

function normalizeLevelValue(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.floor(value);
    }

    if (typeof value === 'string') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? Math.floor(parsed) : null;
    }

    if (value && typeof value === 'object') {
        const candidates = [value.value, value.integerValue, value.doubleValue, value.numberValue];
        for (const candidate of candidates) {
            const parsed = Number(candidate);
            if (Number.isFinite(parsed)) {
                return Math.floor(parsed);
            }
        }
    }

    return null;
}

function getOrderedRowsFromPayload(payload) {
    if (Array.isArray(payload && payload.entries)) {
        return payload.entries;
    }
    if (Array.isArray(payload && payload.orderedDataStoreEntries)) {
        return payload.orderedDataStoreEntries;
    }
    if (Array.isArray(payload && payload.data)) {
        return payload.data;
    }

    return [];
}

function summarizeOrderedEntry(row) {
    if (!row || typeof row !== 'object') {
        return String(row || '');
    }

    return JSON.stringify({
        keys: Object.keys(row).slice(0, 10),
        id: row.id || null,
        key: row.key || null,
        name: row.name || null,
        path: row.path || null,
        valueType: typeof row.value,
        value: row.value
    }).slice(0, 500);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractOrderedEntries(payload, keyPrefix) {
    const rows = getOrderedRowsFromPayload(payload);
    const entries = [];

    for (const row of rows) {
        const entryKey = row && (row.id || row.key || row.name || row.path);
        const robloxUserId = normalizeRobloxUserIdFromEntryKey(entryKey, keyPrefix);
        const levelValue = normalizeLevelValue(row && row.value);
        if (!robloxUserId || levelValue === null) {
            continue;
        }

        entries.push({
            robloxUserId,
            levelValue
        });
    }

    return entries;
}

async function fetchTopLeaderboardEntries(leaderboardRole) {
    const gameConfig = await getStoredGameConfig();
    if (!gameConfig || !gameConfig.productionUniverseId) {
        throw new Error('Production universe ID is not configured');
    }

    console.log(`[leaderboard-role] Querying production universe ${gameConfig.productionUniverseId}, OrderedDataStore "${leaderboardRole.orderedDataStoreName}", scope "${leaderboardRole.orderedDataStoreScope}".`);

    let source = 'cloud-v2';
    let payload = await listOrderedDataStoreEntries({
        universeId: gameConfig.productionUniverseId,
        orderedDataStoreId: leaderboardRole.orderedDataStoreName,
        scopeId: leaderboardRole.orderedDataStoreScope,
        maxPageSize: leaderboardRole.topSize,
        orderBy: 'value desc'
    });

    let rows = getOrderedRowsFromPayload(payload);
    if (rows.length === 0) {
        try {
            const legacyPayload = await listOrderedDataStoreEntriesLegacy({
                universeId: gameConfig.productionUniverseId,
                orderedDataStoreId: leaderboardRole.orderedDataStoreName,
                scopeId: leaderboardRole.orderedDataStoreScope,
                maxPageSize: leaderboardRole.topSize,
                orderBy: 'desc'
            });
            const legacyRows = getOrderedRowsFromPayload(legacyPayload);
            if (legacyRows.length > 0) {
                source = 'ordered-data-stores-v1';
                payload = legacyPayload;
                rows = legacyRows;
            }
        } catch (error) {
            console.error(`[leaderboard-role] Legacy OrderedDataStore fallback failed: ${String(error.message || error)}`);
        }
    }

    const entries = extractOrderedEntries(payload, leaderboardRole.keyPrefix).slice(0, leaderboardRole.topSize);
    const payloadKeys = payload && typeof payload === 'object' ? Object.keys(payload).join(',') : '';
    console.log(`[leaderboard-role] ${source} returned ${rows.length} raw row(s), parsed ${entries.length}. Payload keys: ${payloadKeys || 'none'}.`);
    if (rows.length > 0 && entries.length === 0) {
        console.log(`[leaderboard-role] First raw OrderedDataStore row: ${summarizeOrderedEntry(rows[0])}`);
    }

    return entries;
}

function extractDiscordIdsFromBloxlinkPayload(payload) {
    const candidates = [
        payload && payload.discordIDs,
        payload && payload.DiscordIDs,
        payload && payload.discordIds,
        payload && payload.discord_ids,
        payload && payload.data && payload.data.discordIDs,
        payload && payload.data && payload.data.DiscordIDs
    ];

    for (const candidate of candidates) {
        if (!Array.isArray(candidate)) {
            continue;
        }

        return candidate
            .map((value) => String(value || '').trim())
            .filter((value) => /^\d{5,25}$/.test(value));
    }

    return [];
}

async function lookupDiscordIdsForRobloxUser(guildId, robloxUserId) {
    if (!BLOXLINK_API_KEY) {
        throw new Error('BLOXLINK_API_KEY must be set');
    }

    const cacheKey = `${guildId}:${robloxUserId}`;
    const cached = bloxlinkLookupCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < BLOXLINK_LOOKUP_CACHE_TTL_MS) {
        return cached.discordIds;
    }

    if (Date.now() < bloxlinkRateLimitedUntil) {
        const waitSeconds = Math.ceil((bloxlinkRateLimitedUntil - Date.now()) / 1000);
        throw new Error(`Bloxlink rate limited; retrying in ${waitSeconds}s`);
    }

    const response = await fetch(`${BLOXLINK_API_BASE_URL}/public/guilds/${encodeURIComponent(guildId)}/roblox-to-discord/${encodeURIComponent(robloxUserId)}`, {
        method: 'GET',
        headers: {
            Authorization: BLOXLINK_API_KEY
        },
        signal: AbortSignal.timeout(15000)
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
        if (response.status === 429) {
            const retryAfterHeader = response.headers && response.headers.get ? response.headers.get('retry-after') : '';
            const retryAfterSeconds = Number(retryAfterHeader);
            const backoffMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
                ? Math.ceil(retryAfterSeconds * 1000)
                : BLOXLINK_RATE_LIMIT_BACKOFF_MS;
            bloxlinkRateLimitedUntil = Date.now() + backoffMs;
            throw new Error(`Bloxlink rate limited; retrying in ${Math.ceil(backoffMs / 1000)}s`);
        }

        if (response.status === 404) {
            bloxlinkLookupCache.set(cacheKey, {
                fetchedAt: Date.now(),
                discordIds: []
            });
            return [];
        }

        const message = payload && payload.error
            ? String(payload.error)
            : (payload && payload.message ? String(payload.message) : `Bloxlink lookup failed (${response.status})`);
        throw new Error(message);
    }

    const discordIds = extractDiscordIdsFromBloxlinkPayload(payload);
    bloxlinkLookupCache.set(cacheKey, {
        fetchedAt: Date.now(),
        discordIds
    });
    return discordIds;
}

function getLookupBatch(guildId, topEntries) {
    if (!Array.isArray(topEntries) || topEntries.length <= BLOXLINK_LOOKUPS_PER_SYNC) {
        return topEntries;
    }

    const start = bloxlinkLookupCursorByGuildId.get(guildId) || 0;
    const batch = [];
    for (let offset = 0; offset < BLOXLINK_LOOKUPS_PER_SYNC; offset += 1) {
        batch.push(topEntries[(start + offset) % topEntries.length]);
    }

    bloxlinkLookupCursorByGuildId.set(guildId, (start + BLOXLINK_LOOKUPS_PER_SYNC) % topEntries.length);
    return batch;
}

async function getLeaderboardRoleIconDataUri() {
    if (cachedLeaderboardRoleIconDataUri) {
        return cachedLeaderboardRoleIconDataUri;
    }

    const icon = await fs.readFile(LEADERBOARD_ROLE_ICON_PATH);
    cachedLeaderboardRoleIconDataUri = `data:image/png;base64,${icon.toString('base64')}`;
    return cachedLeaderboardRoleIconDataUri;
}

function guildSupportsRoleIcons(guild) {
    if (!guild || !Array.isArray(guild.features)) {
        return true;
    }

    return guild.features.includes('ROLE_ICONS');
}

async function syncLeaderboardRoleIcon(role) {
    if (!role || !role.id || !role.guild) {
        return;
    }
    if (role.managed || role.icon || roleIconSyncAttemptedByRoleId.has(role.id)) {
        return;
    }

    roleIconSyncAttemptedByRoleId.add(role.id);

    if (!guildSupportsRoleIcons(role.guild)) {
        console.warn('[leaderboard-role] Discord server does not advertise ROLE_ICONS, so the leaderboard role icon was not applied.');
        return;
    }
    if (!DISCORD_BOT_TOKEN) {
        console.warn('[leaderboard-role] DISCORD_BOT_TOKEN is missing, so the leaderboard role icon was not applied.');
        return;
    }

    const icon = await getLeaderboardRoleIconDataUri();
    const response = await fetch(`${DISCORD_API_BASE_URL}/guilds/${encodeURIComponent(role.guild.id)}/roles/${encodeURIComponent(role.id)}`, {
        method: 'PATCH',
        headers: {
            Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
            'Content-Type': 'application/json',
            'X-Audit-Log-Reason': encodeURIComponent('Set RoDark Studios leaderboard role icon')
        },
        body: JSON.stringify({ icon }),
        signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        const message = payload && payload.message
            ? String(payload.message)
            : `Discord role icon request failed (${response.status})`;
        console.warn(`[leaderboard-role] Failed to apply leaderboard role icon: ${message}`);
        return;
    }

    await role.guild.roles.fetch(role.id).catch(() => null);
    console.log(`[leaderboard-role] Applied icon to leaderboard role "${role.name}".`);
}

async function syncLeaderboardRoleDisplaySetting(role, leaderboardRole) {
    if (!role || role.hoist === Boolean(leaderboardRole.hoist)) {
        return;
    }

    await role.edit({
        hoist: Boolean(leaderboardRole.hoist),
        reason: 'Sync RoDark Studios leaderboard role display setting'
    });
}

function getLeaderboardRoleTargetPosition(role) {
    const guild = role && role.guild;
    if (!guild || !guild.roles || !guild.roles.cache) {
        return 1;
    }

    const memberRole = guild.roles.cache.find((candidate) => {
        if (!candidate || candidate.id === role.id || candidate.id === guild.id) {
            return false;
        }

        const normalizedName = String(candidate.name || '').trim().toLowerCase();
        return normalizedName === 'member' || normalizedName === 'members';
    });

    return Math.max(1, (memberRole ? memberRole.position : 0) + 1);
}

async function syncLeaderboardRolePosition(role) {
    if (!role || typeof role.setPosition !== 'function') {
        return;
    }

    const targetPosition = getLeaderboardRoleTargetPosition(role);
    if (role.position === targetPosition) {
        return;
    }

    await role.setPosition(targetPosition, {
        reason: 'Keep RoDark Studios leaderboard role near the bottom of the role list'
    });
}

async function ensureLeaderboardRole(guild, leaderboardRole) {
    await guild.roles.fetch().catch(() => null);

    if (leaderboardRole.roleId) {
        const configuredRole = guild.roles.cache.get(leaderboardRole.roleId);
        if (configuredRole) {
            await syncLeaderboardRoleDisplaySetting(configuredRole, leaderboardRole).catch((error) => {
                console.error('[leaderboard-role] Failed to sync role hoist setting:', error);
            });
            await syncLeaderboardRolePosition(configuredRole).catch((error) => {
                console.error('[leaderboard-role] Failed to sync role position:', error);
            });
            await syncLeaderboardRoleIcon(configuredRole).catch((error) => {
                console.warn('[leaderboard-role] Failed to sync configured role icon:', error);
            });
            return configuredRole;
        }
    }

    const roleName = leaderboardRole.roleName || DEFAULT_ROLE_NAME;
    const existingRole = guild.roles.cache.find((role) => (
        role &&
        typeof role.name === 'string' &&
        role.name.toLowerCase() === roleName.toLowerCase()
    ));

    if (existingRole) {
        await syncLeaderboardRoleDisplaySetting(existingRole, leaderboardRole).catch((error) => {
            console.error('[leaderboard-role] Failed to sync role hoist setting:', error);
        });
        await syncLeaderboardRolePosition(existingRole).catch((error) => {
            console.error('[leaderboard-role] Failed to sync role position:', error);
        });

        if (String(existingRole.id) !== String(leaderboardRole.roleId || '')) {
            await setDiscordLeaderboardRoleId(existingRole.id).catch(() => null);
        }
        await syncLeaderboardRoleIcon(existingRole).catch((error) => {
            console.warn('[leaderboard-role] Failed to sync existing role icon:', error);
        });
        return existingRole;
    }

    const createdRole = await guild.roles.create({
        name: roleName,
        color: 0x22d3ee,
        hoist: Boolean(leaderboardRole.hoist),
        mentionable: false,
        reason: 'Ensure RoDark Studios leaderboard player role exists'
    });
    await setDiscordLeaderboardRoleId(createdRole.id).catch(() => null);
    await syncLeaderboardRolePosition(createdRole).catch((error) => {
        console.error('[leaderboard-role] Failed to sync role position:', error);
    });
    await syncLeaderboardRoleIcon(createdRole).catch((error) => {
        console.warn('[leaderboard-role] Failed to sync created role icon:', error);
    });
    return createdRole;
}

async function getExistingAssignments(guildId) {
    const result = await postgresQuery(`
        select user_id, roblox_user_id, role_id
        from discord_bot_leaderboard_role_assignments
        where guild_id = $1
    `, [String(guildId)]);

    return result.rows.map((row) => ({
        userId: String(row.user_id),
        robloxUserId: String(row.roblox_user_id),
        roleId: String(row.role_id)
    }));
}

async function upsertAssignment(guildId, userId, robloxUserId, roleId, levelValue) {
    await postgresQuery(`
        insert into discord_bot_leaderboard_role_assignments (
            guild_id,
            user_id,
            roblox_user_id,
            role_id,
            level_value,
            assigned_at,
            last_seen_at
        )
        values ($1, $2, $3, $4, $5, now(), now())
        on conflict (guild_id, user_id) do update
        set
            roblox_user_id = excluded.roblox_user_id,
            role_id = excluded.role_id,
            level_value = excluded.level_value,
            last_seen_at = now()
    `, [
        String(guildId),
        String(userId),
        String(robloxUserId),
        String(roleId),
        Number.isFinite(Number(levelValue)) ? Math.floor(Number(levelValue)) : null
    ]);
}

async function deleteAssignment(guildId, userId) {
    await postgresQuery(`
        delete from discord_bot_leaderboard_role_assignments
        where guild_id = $1 and user_id = $2
    `, [
        String(guildId),
        String(userId)
    ]);
}

async function discordRoleRequest(method, guildId, userId, roleId, reason) {
    if (!DISCORD_BOT_TOKEN) {
        throw new Error('DISCORD_BOT_TOKEN must be set');
    }

    const response = await fetch(`${DISCORD_API_BASE_URL}/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(userId)}/roles/${encodeURIComponent(roleId)}`, {
        method,
        headers: {
            Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
            'X-Audit-Log-Reason': encodeURIComponent(reason || 'Sync leaderboard role')
        },
        signal: AbortSignal.timeout(15000)
    });

    if (response.status === 204) {
        return;
    }

    const payload = await response.json().catch(() => ({}));
    const message = payload && payload.message
        ? String(payload.message)
        : `Discord role request failed (${response.status})`;
    throw new Error(message);
}

async function addRoleToMember(guild, userId, roleId) {
    await discordRoleRequest('PUT', guild.id, userId, roleId, 'Top player on Coding Simulator 2 leaderboard');
    if (DISCORD_ROLE_REQUEST_DELAY_MS > 0) {
        await sleep(DISCORD_ROLE_REQUEST_DELAY_MS);
    }
}

async function removeRoleFromMember(guild, userId, roleId) {
    await discordRoleRequest('DELETE', guild.id, userId, roleId, 'No longer in Coding Simulator 2 leaderboard top list');
    if (DISCORD_ROLE_REQUEST_DELAY_MS > 0) {
        await sleep(DISCORD_ROLE_REQUEST_DELAY_MS);
    }
}

async function syncLeaderboardRoleForGuild(guild, control) {
    const leaderboardRole = getLeaderboardRoleControl(control);
    if (!guild || !leaderboardRole.enabled) {
        return;
    }
    if (!leaderboardRole.orderedDataStoreName) {
        throw new Error('Leaderboard OrderedDataStore name is not configured');
    }

    const role = await ensureLeaderboardRole(guild, leaderboardRole);
    const topEntries = await fetchTopLeaderboardEntries(leaderboardRole);
    console.log(`[leaderboard-role] Read ${topEntries.length} top Roblox entr${topEntries.length === 1 ? 'y' : 'ies'} from OrderedDataStore "${leaderboardRole.orderedDataStoreName}".`);
    const topRobloxUserIds = new Set(topEntries.map((entry) => String(entry.robloxUserId)));
    const lookupEntries = getLookupBatch(guild.id, topEntries);
    if (lookupEntries.length < topEntries.length) {
        console.log(`[leaderboard-role] Looking up ${lookupEntries.length}/${topEntries.length} Roblox entr${topEntries.length === 1 ? 'y' : 'ies'} this cycle to respect Bloxlink rate limits.`);
    }
    const desiredByUserId = new Map();
    let rateLimited = false;

    for (const entry of lookupEntries) {
        let discordIds = [];
        try {
            discordIds = await lookupDiscordIdsForRobloxUser(guild.id, entry.robloxUserId);
        } catch (error) {
            const message = String(error && error.message ? error.message : error);
            if (/rate limited/i.test(message)) {
                rateLimited = true;
                console.warn(`[leaderboard-role] ${message}`);
                break;
            }

            console.error(`[leaderboard-role] Bloxlink lookup failed for Roblox ${entry.robloxUserId}:`, error);
            continue;
        }
        for (const discordId of discordIds) {
            desiredByUserId.set(discordId, {
                robloxUserId: entry.robloxUserId,
                levelValue: entry.levelValue
            });
        }

        if (BLOXLINK_LOOKUP_DELAY_MS > 0) {
            await sleep(BLOXLINK_LOOKUP_DELAY_MS);
        }
    }

    console.log(`[leaderboard-role] Bloxlink resolved ${desiredByUserId.size} Discord member${desiredByUserId.size === 1 ? '' : 's'} from ${lookupEntries.length} checked Roblox entr${lookupEntries.length === 1 ? 'y' : 'ies'}.`);

    if (rateLimited && desiredByUserId.size === 0) {
        return;
    }

    const existingAssignments = await getExistingAssignments(guild.id);
    let addedOrConfirmedCount = 0;
    let failedAddCount = 0;
    let removedCount = 0;
    let failedRemoveCount = 0;

    for (const [userId, desired] of desiredByUserId.entries()) {
        try {
            await addRoleToMember(guild, userId, role.id);
            addedOrConfirmedCount += 1;
            await upsertAssignment(guild.id, userId, desired.robloxUserId, role.id, desired.levelValue);
        } catch (error) {
            failedAddCount += 1;
            console.error(`[leaderboard-role] Failed to add role to ${userId}:`, error);
        }
    }

    for (const assignment of existingAssignments) {
        if (topRobloxUserIds.has(String(assignment.robloxUserId))) {
            continue;
        }

        let removed = false;
        await removeRoleFromMember(guild, assignment.userId, assignment.roleId || role.id).then(() => {
            removed = true;
        }).catch((error) => {
            failedRemoveCount += 1;
            console.error(`[leaderboard-role] Failed to remove role from ${assignment.userId}:`, error);
        });
        if (removed) {
            removedCount += 1;
            await deleteAssignment(guild.id, assignment.userId);
        }
    }

    console.log(`[leaderboard-role] Synced ${addedOrConfirmedCount} Discord member(s) for ${guild.name}. Failed adds: ${failedAddCount}. Removed: ${removedCount}. Failed removes: ${failedRemoveCount}.`);
}

async function syncLeaderboardRoleIfNeeded(client, control, options) {
    const leaderboardRole = getLeaderboardRoleControl(control);
    if (!client || !client.isReady || !client.isReady() || !leaderboardRole.enabled) {
        return;
    }

    const force = Boolean(options && options.force);
    const now = Date.now();
    const guildId = control && control.guildId ? String(control.guildId) : '';
    const targetGuilds = guildId
        ? Array.from(client.guilds.cache.values()).filter((guild) => String(guild.id) === guildId)
        : Array.from(client.guilds.cache.values());

    if (guildId && targetGuilds.length === 0) {
        console.warn(`[leaderboard-role] Configured guild ${guildId} is not available in the bot cache.`);
    }

    for (const guild of targetGuilds) {
        if (leaderboardSyncInFlightByGuildId.has(guild.id)) {
            continue;
        }

        const lastSync = lastSyncAtByGuildId.get(guild.id) || 0;
        const intervalMs = leaderboardRole.syncIntervalMinutes * 60 * 1000;
        if (!force && now - lastSync < intervalMs) {
            continue;
        }

        leaderboardSyncInFlightByGuildId.add(guild.id);
        try {
            await syncLeaderboardRoleForGuild(guild, control);
            lastSyncAtByGuildId.set(guild.id, Date.now());
        } finally {
            leaderboardSyncInFlightByGuildId.delete(guild.id);
        }
    }
}

function resetLeaderboardRoleSyncState() {
    lastSyncAtByGuildId = new Map();
    bloxlinkLookupCache = new Map();
    bloxlinkLookupCursorByGuildId = new Map();
    bloxlinkRateLimitedUntil = 0;
    leaderboardSyncInFlightByGuildId = new Set();
}

module.exports = {
    getLeaderboardRoleControl,
    getLeaderboardRoleSyncKey,
    syncLeaderboardRoleIfNeeded,
    resetLeaderboardRoleSyncState
};
