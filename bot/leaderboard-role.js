const { Routes } = require('discord.js');
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

let lastSyncAtByGuildId = new Map();
let bloxlinkLookupCache = new Map();

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
        roleName: leaderboardRole.roleName ? String(leaderboardRole.roleName).trim() : DEFAULT_ROLE_NAME
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

    const response = await fetch(`${BLOXLINK_API_BASE_URL}/public/guilds/${encodeURIComponent(guildId)}/roblox-to-discord/${encodeURIComponent(robloxUserId)}`, {
        method: 'GET',
        headers: {
            Authorization: BLOXLINK_API_KEY
        },
        signal: AbortSignal.timeout(15000)
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
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

async function ensureLeaderboardRole(guild, leaderboardRole) {
    await guild.roles.fetch().catch(() => null);

    if (leaderboardRole.roleId) {
        const configuredRole = guild.roles.cache.get(leaderboardRole.roleId);
        if (configuredRole) {
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
        if (String(existingRole.id) !== String(leaderboardRole.roleId || '')) {
            await setDiscordLeaderboardRoleId(existingRole.id).catch(() => null);
        }
        return existingRole;
    }

    const createdRole = await guild.roles.create({
        name: roleName,
        color: 0x22d3ee,
        mentionable: false,
        reason: 'Ensure RoDark Studios leaderboard player role exists'
    });
    await setDiscordLeaderboardRoleId(createdRole.id).catch(() => null);
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

async function addRoleToMember(guild, userId, roleId) {
    await guild.client.rest.put(Routes.guildMemberRole(guild.id, userId, roleId), {
        reason: 'Top player on Coding Simulator 2 leaderboard'
    });
}

async function removeRoleFromMember(guild, userId, roleId) {
    await guild.client.rest.delete(Routes.guildMemberRole(guild.id, userId, roleId), {
        reason: 'No longer in Coding Simulator 2 leaderboard top list'
    });
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
    const desiredByUserId = new Map();

    for (const entry of topEntries) {
        const discordIds = await lookupDiscordIdsForRobloxUser(guild.id, entry.robloxUserId);
        for (const discordId of discordIds) {
            desiredByUserId.set(discordId, {
                robloxUserId: entry.robloxUserId,
                levelValue: entry.levelValue
            });
        }
    }

    console.log(`[leaderboard-role] Bloxlink resolved ${desiredByUserId.size} Discord member${desiredByUserId.size === 1 ? '' : 's'} from ${topEntries.length} Roblox entr${topEntries.length === 1 ? 'y' : 'ies'}.`);

    const existingAssignments = await getExistingAssignments(guild.id);
    let addedOrConfirmedCount = 0;
    let failedAddCount = 0;

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
        if (desiredByUserId.has(assignment.userId)) {
            continue;
        }

        await removeRoleFromMember(guild, assignment.userId, assignment.roleId || role.id).catch((error) => {
            console.error(`[leaderboard-role] Failed to remove role from ${assignment.userId}:`, error);
        });
        await deleteAssignment(guild.id, assignment.userId);
    }

    console.log(`[leaderboard-role] Synced ${addedOrConfirmedCount} Discord member(s) for ${guild.name}. Failed adds: ${failedAddCount}.`);
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
        const lastSync = lastSyncAtByGuildId.get(guild.id) || 0;
        const intervalMs = leaderboardRole.syncIntervalMinutes * 60 * 1000;
        if (!force && now - lastSync < intervalMs) {
            continue;
        }

        await syncLeaderboardRoleForGuild(guild, control);
        lastSyncAtByGuildId.set(guild.id, Date.now());
    }
}

function resetLeaderboardRoleSyncState() {
    lastSyncAtByGuildId = new Map();
    bloxlinkLookupCache = new Map();
}

module.exports = {
    getLeaderboardRoleControl,
    getLeaderboardRoleSyncKey,
    syncLeaderboardRoleIfNeeded,
    resetLeaderboardRoleSyncState
};
