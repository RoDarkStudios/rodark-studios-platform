const crypto = require('crypto');
const { postgresQuery } = require('./postgres');

const CONTROL_ID = 1;
const LEVEL_ATTACHMENT_UNLOCK_LEVELS = [5, 10, 15, 25, 50, 75, 100];
const DEFAULT_LEADERBOARD_ROLE_NAME = 'Leaderboard Player';
const MAX_LEADERBOARD_ROLE_ICON_BYTES = 256 * 1024;
const ALLOWED_LEADERBOARD_ROLE_ICON_TYPES = new Set([
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp'
]);

function toIsoString(value) {
    if (value instanceof Date) {
        return value.toISOString();
    }

    return typeof value === 'string' ? value : null;
}

function normalizeOptionalSnowflake(value, fieldName) {
    if (value === undefined || value === null) {
        return null;
    }

    const trimmed = String(value).trim();
    if (!trimmed) {
        return null;
    }

    if (!/^\d{5,25}$/.test(trimmed)) {
        throw new Error(`${fieldName} must be a valid Discord ID`);
    }

    return trimmed;
}

function normalizeOptionalSnowflakeArray(value, fieldName) {
    if (value === undefined || value === null) {
        return [];
    }

    const rawValues = Array.isArray(value)
        ? value
        : String(value).split(',');

    const normalizedValues = [];
    const seenValues = new Set();

    rawValues.forEach((rawValue) => {
        const normalizedValue = normalizeOptionalSnowflake(rawValue, fieldName);
        if (!normalizedValue || seenValues.has(normalizedValue)) {
            return;
        }

        seenValues.add(normalizedValue);
        normalizedValues.push(normalizedValue);
    });

    return normalizedValues;
}

function normalizeLevelUnlockLevel(value) {
    const parsedValue = Number.parseInt(value || '5', 10);
    if (!LEVEL_ATTACHMENT_UNLOCK_LEVELS.includes(parsedValue)) {
        throw new Error('Attachment unlock level must be one of 5, 10, 15, 25, 50, 75, or 100');
    }

    return parsedValue;
}

function normalizeDatastoreName(value) {
    const trimmed = String(value || '').trim();
    if (!trimmed) {
        return null;
    }

    if (trimmed.length > 128) {
        throw new Error('OrderedDataStore name must be 128 characters or fewer');
    }

    return trimmed;
}

function normalizeDatastoreScope(value) {
    const trimmed = String(value || 'global').trim();
    if (!trimmed) {
        return 'global';
    }

    if (trimmed.length > 128) {
        throw new Error('OrderedDataStore scope must be 128 characters or fewer');
    }

    return trimmed;
}

function normalizeLeaderboardKeyPrefix(value) {
    const trimmed = String(value || '').trim();
    if (trimmed.length > 64) {
        throw new Error('Leaderboard key prefix must be 64 characters or fewer');
    }

    return trimmed;
}

function normalizeLeaderboardTopSize(value) {
    const parsedValue = Number.parseInt(value || '100', 10);
    if (!Number.isFinite(parsedValue) || parsedValue < 1 || parsedValue > 100) {
        throw new Error('Leaderboard top size must be between 1 and 100');
    }

    return parsedValue;
}

function normalizeLeaderboardSyncIntervalMinutes(value) {
    const parsedValue = Number.parseInt(value || '5', 10);
    if (!Number.isFinite(parsedValue) || parsedValue < 1 || parsedValue > 1440) {
        throw new Error('Leaderboard sync interval must be between 1 and 1440 minutes');
    }

    return parsedValue;
}

function normalizeLeaderboardRoleName(value) {
    const trimmed = String(value || DEFAULT_LEADERBOARD_ROLE_NAME).trim();
    if (!trimmed) {
        return DEFAULT_LEADERBOARD_ROLE_NAME;
    }

    if (trimmed.length > 100) {
        throw new Error('Leaderboard role name must be 100 characters or fewer');
    }

    return trimmed;
}

function bufferLooksLikeImage(buffer, contentType) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
        return false;
    }

    if (contentType === 'image/png') {
        return buffer.length >= 8
            && buffer[0] === 0x89
            && buffer[1] === 0x50
            && buffer[2] === 0x4e
            && buffer[3] === 0x47
            && buffer[4] === 0x0d
            && buffer[5] === 0x0a
            && buffer[6] === 0x1a
            && buffer[7] === 0x0a;
    }

    if (contentType === 'image/jpeg') {
        return buffer[0] === 0xff && buffer[1] === 0xd8;
    }

    if (contentType === 'image/gif') {
        return buffer.length >= 6
            && (buffer.subarray(0, 6).toString('ascii') === 'GIF87a'
                || buffer.subarray(0, 6).toString('ascii') === 'GIF89a');
    }

    if (contentType === 'image/webp') {
        return buffer.length >= 12
            && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
            && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
    }

    return false;
}

function normalizeLeaderboardRoleIconUpload(value) {
    const rawValue = String(value || '').trim();
    if (!rawValue) {
        return null;
    }

    const match = rawValue.match(/^data:([^;,]+);base64,([a-z0-9+/=\s]+)$/i);
    if (!match) {
        throw new Error('Leaderboard role icon must be uploaded as a valid image');
    }

    const contentType = String(match[1] || '').toLowerCase();
    if (!ALLOWED_LEADERBOARD_ROLE_ICON_TYPES.has(contentType)) {
        throw new Error('Leaderboard role icon must be a PNG, JPG, GIF, or WebP image');
    }

    const imageBuffer = Buffer.from(String(match[2] || '').replace(/\s/g, ''), 'base64');
    if (!imageBuffer.length || imageBuffer.length > MAX_LEADERBOARD_ROLE_ICON_BYTES) {
        throw new Error('Leaderboard role icon must be 256 KB or smaller');
    }

    if (!bufferLooksLikeImage(imageBuffer, contentType)) {
        throw new Error('Leaderboard role icon file type did not match the uploaded image');
    }

    return {
        contentType,
        data: imageBuffer,
        sha256: crypto.createHash('sha256').update(imageBuffer).digest('hex')
    };
}

function buildLeaderboardRoleIconDataUrl(row) {
    const contentType = row && row.leaderboard_role_icon_content_type
        ? String(row.leaderboard_role_icon_content_type)
        : '';
    const imageData = row && Buffer.isBuffer(row.leaderboard_role_icon_data)
        ? row.leaderboard_role_icon_data
        : null;

    if (!contentType || !imageData || !imageData.length) {
        return '';
    }

    return `data:${contentType};base64,${imageData.toString('base64')}`;
}

async function ensureDiscordBotControlSchema() {
    await postgresQuery(`
        create table if not exists discord_bot_control (
            id smallint primary key check (id = 1),
            desired_enabled boolean not null default false,
            runtime_status text not null default 'offline',
            last_seen_at timestamptz,
            last_error text,
            guild_id text,
            content_rules_channel_id text,
            content_info_channel_id text,
            content_roles_channel_id text,
            content_staff_info_channel_id text,
            content_game_test_info_channel_id text,
            tickets_category_channel_id text,
            tickets_panel_channel_id text,
            tickets_panel_message_id text,
            tickets_helper_role_ids text[] not null default '{}',
            level_system_enabled boolean not null default false,
            level_announcement_channel_id text,
            level_attachment_unlock_level integer not null default 5,
            level_mention_enabled boolean not null default true,
            leaderboard_role_enabled boolean not null default false,
            leaderboard_role_ordered_datastore_name text,
            leaderboard_role_ordered_datastore_scope text not null default 'global',
            leaderboard_role_key_prefix text not null default '',
            leaderboard_role_top_size integer not null default 100,
            leaderboard_role_sync_interval_minutes integer not null default 5,
            leaderboard_role_id text,
            leaderboard_role_name text not null default 'Leaderboard Player',
            leaderboard_role_hoist boolean not null default false,
            leaderboard_role_icon_content_type text,
            leaderboard_role_icon_data bytea,
            leaderboard_role_icon_sha256 text,
            leaderboard_role_icon_updated_at timestamptz,
            updated_at timestamptz not null default now(),
            updated_by_user_id text,
            updated_by_username text
        )
    `);

    await postgresQuery(`
        alter table discord_bot_control
        add column if not exists guild_id text
    `);

    await postgresQuery(`
        alter table discord_bot_control
        add column if not exists content_rules_channel_id text
    `);

    await postgresQuery(`
        alter table discord_bot_control
        add column if not exists content_info_channel_id text
    `);

    await postgresQuery(`
        alter table discord_bot_control
        add column if not exists content_roles_channel_id text
    `);

    await postgresQuery(`
        alter table discord_bot_control
        add column if not exists content_staff_info_channel_id text
    `);

    await postgresQuery(`
        alter table discord_bot_control
        add column if not exists content_game_test_info_channel_id text
    `);

    await postgresQuery(`
        alter table discord_bot_control
        add column if not exists tickets_category_channel_id text
    `);

    await postgresQuery(`
        alter table discord_bot_control
        add column if not exists tickets_panel_channel_id text
    `);

    await postgresQuery(`
        alter table discord_bot_control
        add column if not exists tickets_panel_message_id text
    `);

    await postgresQuery(`
        alter table discord_bot_control
        add column if not exists tickets_helper_role_ids text[] not null default '{}'
    `);

    await postgresQuery(`
        alter table discord_bot_control
        add column if not exists level_system_enabled boolean not null default false
    `);

    await postgresQuery(`
        alter table discord_bot_control
        add column if not exists level_announcement_channel_id text
    `);

    await postgresQuery(`
        alter table discord_bot_control
        add column if not exists level_attachment_unlock_level integer not null default 5
    `);

    await postgresQuery(`
        alter table discord_bot_control
        add column if not exists level_mention_enabled boolean not null default true
    `);

    await postgresQuery(`
        alter table discord_bot_control
        add column if not exists leaderboard_role_enabled boolean not null default false
    `);

    await postgresQuery(`
        alter table discord_bot_control
        add column if not exists leaderboard_role_ordered_datastore_name text
    `);

    await postgresQuery(`
        alter table discord_bot_control
        add column if not exists leaderboard_role_ordered_datastore_scope text not null default 'global'
    `);

    await postgresQuery(`
        alter table discord_bot_control
        add column if not exists leaderboard_role_key_prefix text not null default ''
    `);

    await postgresQuery(`
        alter table discord_bot_control
        add column if not exists leaderboard_role_top_size integer not null default 100
    `);

    await postgresQuery(`
        alter table discord_bot_control
        add column if not exists leaderboard_role_sync_interval_minutes integer not null default 5
    `);

    await postgresQuery(`
        alter table discord_bot_control
        add column if not exists leaderboard_role_id text
    `);

    await postgresQuery(`
        alter table discord_bot_control
        add column if not exists leaderboard_role_name text not null default 'Leaderboard Player'
    `);

    await postgresQuery(`
        alter table discord_bot_control
        add column if not exists leaderboard_role_hoist boolean not null default false
    `);

    await postgresQuery(`
        alter table discord_bot_control
        add column if not exists leaderboard_role_icon_content_type text
    `);

    await postgresQuery(`
        alter table discord_bot_control
        add column if not exists leaderboard_role_icon_data bytea
    `);

    await postgresQuery(`
        alter table discord_bot_control
        add column if not exists leaderboard_role_icon_sha256 text
    `);

    await postgresQuery(`
        alter table discord_bot_control
        add column if not exists leaderboard_role_icon_updated_at timestamptz
    `);

    await postgresQuery(`
        create table if not exists discord_bot_member_levels (
            guild_id text not null,
            user_id text not null,
            message_count integer not null default 0,
            level integer not null default 0,
            last_message_at timestamptz,
            updated_at timestamptz not null default now(),
            primary key (guild_id, user_id)
        )
    `);

    await postgresQuery(`
        create table if not exists discord_bot_leaderboard_role_assignments (
            guild_id text not null,
            user_id text not null,
            roblox_user_id text not null,
            role_id text not null,
            level_value bigint,
            assigned_at timestamptz not null default now(),
            last_seen_at timestamptz not null default now(),
            primary key (guild_id, user_id)
        )
    `);

    await postgresQuery(`
        create sequence if not exists discord_bot_ticket_id_seq
            as bigint
            start with 1
            increment by 1
            no minvalue
            no maxvalue
            cache 1
    `);

    await postgresQuery(`
        create table if not exists discord_bot_tickets (
            ticket_id bigint primary key,
            guild_id text not null,
            channel_id text unique,
            opener_user_id text not null,
            status text not null default 'open',
            created_at timestamptz not null default now(),
            closed_at timestamptz,
            closed_by_user_id text
        )
    `);

    await postgresQuery(`
        with ranked_open_tickets as (
            select
                ticket_id,
                row_number() over (
                    partition by guild_id, opener_user_id
                    order by created_at asc, ticket_id asc
                ) as open_rank
            from discord_bot_tickets
            where status = 'open'
        )
        update discord_bot_tickets
        set
            status = 'closed',
            closed_at = coalesce(closed_at, now())
        where ticket_id in (
            select ticket_id
            from ranked_open_tickets
            where open_rank > 1
        )
    `);

    await postgresQuery(`
        create unique index if not exists discord_bot_tickets_one_open_per_user_idx
        on discord_bot_tickets (guild_id, opener_user_id)
        where status = 'open'
    `);

    await postgresQuery(`
        create table if not exists discord_bot_ticket_transcripts (
            ticket_id bigint primary key,
            guild_id text not null,
            channel_id text not null,
            channel_name text not null,
            opener_user_id text not null,
            closed_by_user_id text,
            created_at timestamptz,
            closed_at timestamptz not null default now(),
            message_count integer not null default 0,
            transcript jsonb not null default '[]'::jsonb
        )
    `);

    await postgresQuery(`
        alter table discord_bot_control
        drop column if exists ai_ticket_assistant_enabled
    `);

    await postgresQuery(`
        alter table discord_bot_control
        drop column if exists ai_ticket_category_id
    `);

    await postgresQuery(`
        alter table discord_bot_control
        drop column if exists ai_ticket_owner_role_id
    `);

    await postgresQuery(`
        drop table if exists discord_bot_ticket_assistant_threads
    `);

    await postgresQuery(`
        insert into discord_bot_control (id)
        values ($1)
        on conflict (id) do nothing
    `, [CONTROL_ID]);
}

function mapRowToDiscordBotControl(row) {
    if (!row || typeof row !== 'object') {
        return null;
    }

    return {
        desiredEnabled: Boolean(row.desired_enabled),
        runtimeStatus: typeof row.runtime_status === 'string' ? row.runtime_status : 'offline',
        lastSeenAt: toIsoString(row.last_seen_at),
        lastError: row.last_error ? String(row.last_error) : null,
        updatedAt: toIsoString(row.updated_at),
        updatedByUserId: row.updated_by_user_id ? String(row.updated_by_user_id) : null,
        updatedByUsername: row.updated_by_username ? String(row.updated_by_username) : null,
        guildId: row.guild_id ? String(row.guild_id) : null,
        startupContentSync: {
            rulesChannelId: row.content_rules_channel_id ? String(row.content_rules_channel_id) : null,
            infoChannelId: row.content_info_channel_id ? String(row.content_info_channel_id) : null,
            rolesChannelId: row.content_roles_channel_id ? String(row.content_roles_channel_id) : null,
            staffInfoChannelId: row.content_staff_info_channel_id ? String(row.content_staff_info_channel_id) : null,
            gameTestInfoChannelId: row.content_game_test_info_channel_id ? String(row.content_game_test_info_channel_id) : null
        },
        ticketSystem: {
            categoryChannelId: row.tickets_category_channel_id ? String(row.tickets_category_channel_id) : null,
            panelChannelId: row.tickets_panel_channel_id ? String(row.tickets_panel_channel_id) : null,
            panelMessageId: row.tickets_panel_message_id ? String(row.tickets_panel_message_id) : null,
            helperRoleIds: Array.isArray(row.tickets_helper_role_ids)
                ? row.tickets_helper_role_ids.map((value) => String(value)).filter(Boolean)
                : []
        },
        levelSystem: {
            enabled: Boolean(row.level_system_enabled),
            announcementChannelId: row.level_announcement_channel_id ? String(row.level_announcement_channel_id) : null,
            attachmentUnlockLevel: Number(row.level_attachment_unlock_level) || 5,
            mentionLevelUps: row.level_mention_enabled !== false
        },
        leaderboardRole: {
            enabled: Boolean(row.leaderboard_role_enabled),
            orderedDataStoreName: row.leaderboard_role_ordered_datastore_name ? String(row.leaderboard_role_ordered_datastore_name) : '',
            orderedDataStoreScope: row.leaderboard_role_ordered_datastore_scope ? String(row.leaderboard_role_ordered_datastore_scope) : 'global',
            keyPrefix: row.leaderboard_role_key_prefix ? String(row.leaderboard_role_key_prefix) : '',
            topSize: Number(row.leaderboard_role_top_size) || 100,
            syncIntervalMinutes: Number(row.leaderboard_role_sync_interval_minutes) || 5,
            roleId: row.leaderboard_role_id ? String(row.leaderboard_role_id) : null,
            roleName: row.leaderboard_role_name ? String(row.leaderboard_role_name) : DEFAULT_LEADERBOARD_ROLE_NAME,
            hoist: Boolean(row.leaderboard_role_hoist),
            iconContentType: row.leaderboard_role_icon_content_type ? String(row.leaderboard_role_icon_content_type) : '',
            iconDataUrl: buildLeaderboardRoleIconDataUrl(row),
            iconSha256: row.leaderboard_role_icon_sha256 ? String(row.leaderboard_role_icon_sha256) : '',
            iconUpdatedAt: toIsoString(row.leaderboard_role_icon_updated_at)
        }
    };
}

async function getDiscordBotControl() {
    await ensureDiscordBotControlSchema();

    const result = await postgresQuery(`
        select
            desired_enabled,
            runtime_status,
            last_seen_at,
            last_error,
            updated_at,
            updated_by_user_id,
            updated_by_username,
            guild_id,
            content_rules_channel_id,
            content_info_channel_id,
            content_roles_channel_id,
            content_staff_info_channel_id,
            content_game_test_info_channel_id,
            tickets_category_channel_id,
            tickets_panel_channel_id,
            tickets_panel_message_id,
            tickets_helper_role_ids,
            level_system_enabled,
            level_announcement_channel_id,
            level_attachment_unlock_level,
            level_mention_enabled,
            leaderboard_role_enabled,
            leaderboard_role_ordered_datastore_name,
            leaderboard_role_ordered_datastore_scope,
            leaderboard_role_key_prefix,
            leaderboard_role_top_size,
            leaderboard_role_sync_interval_minutes,
            leaderboard_role_id,
            leaderboard_role_name,
            leaderboard_role_hoist,
            leaderboard_role_icon_content_type,
            leaderboard_role_icon_data,
            leaderboard_role_icon_sha256,
            leaderboard_role_icon_updated_at
        from discord_bot_control
        where id = $1
        limit 1
    `, [CONTROL_ID]);

    return mapRowToDiscordBotControl(result.rows[0]);
}

async function updateDiscordBotControl(patch, user) {
    await ensureDiscordBotControlSchema();

    const currentControl = await getDiscordBotControl();
    if (!currentControl) {
        throw new Error('Discord bot control row is unavailable');
    }

    const desiredEnabled = patch && Object.prototype.hasOwnProperty.call(patch, 'desiredEnabled')
        ? Boolean(patch.desiredEnabled)
        : currentControl.desiredEnabled;
    const guildId = patch && Object.prototype.hasOwnProperty.call(patch, 'guildId')
        ? normalizeOptionalSnowflake(patch.guildId, 'Discord server ID')
        : (currentControl.guildId ? String(currentControl.guildId) : null);
    const contentRulesChannelId = patch && Object.prototype.hasOwnProperty.call(patch, 'contentRulesChannelId')
        ? normalizeOptionalSnowflake(patch.contentRulesChannelId, 'Rules channel ID')
        : (currentControl.startupContentSync && currentControl.startupContentSync.rulesChannelId
            ? String(currentControl.startupContentSync.rulesChannelId)
            : null);
    const contentInfoChannelId = patch && Object.prototype.hasOwnProperty.call(patch, 'contentInfoChannelId')
        ? normalizeOptionalSnowflake(patch.contentInfoChannelId, 'Info channel ID')
        : (currentControl.startupContentSync && currentControl.startupContentSync.infoChannelId
            ? String(currentControl.startupContentSync.infoChannelId)
            : null);
    const contentRolesChannelId = patch && Object.prototype.hasOwnProperty.call(patch, 'contentRolesChannelId')
        ? normalizeOptionalSnowflake(patch.contentRolesChannelId, 'Roles channel ID')
        : (currentControl.startupContentSync && currentControl.startupContentSync.rolesChannelId
            ? String(currentControl.startupContentSync.rolesChannelId)
            : null);
    const contentStaffInfoChannelId = patch && Object.prototype.hasOwnProperty.call(patch, 'contentStaffInfoChannelId')
        ? normalizeOptionalSnowflake(patch.contentStaffInfoChannelId, 'Staff info channel ID')
        : (currentControl.startupContentSync && currentControl.startupContentSync.staffInfoChannelId
            ? String(currentControl.startupContentSync.staffInfoChannelId)
            : null);
    const contentGameTestInfoChannelId = patch && Object.prototype.hasOwnProperty.call(patch, 'contentGameTestInfoChannelId')
        ? normalizeOptionalSnowflake(patch.contentGameTestInfoChannelId, 'Game test info channel ID')
        : (currentControl.startupContentSync && currentControl.startupContentSync.gameTestInfoChannelId
            ? String(currentControl.startupContentSync.gameTestInfoChannelId)
            : null);
    const ticketsCategoryChannelId = patch && Object.prototype.hasOwnProperty.call(patch, 'ticketsCategoryChannelId')
        ? normalizeOptionalSnowflake(patch.ticketsCategoryChannelId, 'Tickets category ID')
        : (currentControl.ticketSystem && currentControl.ticketSystem.categoryChannelId
            ? String(currentControl.ticketSystem.categoryChannelId)
            : null);
    const ticketsPanelChannelId = patch && Object.prototype.hasOwnProperty.call(patch, 'ticketsPanelChannelId')
        ? normalizeOptionalSnowflake(patch.ticketsPanelChannelId, 'Ticket panel channel ID')
        : (currentControl.ticketSystem && currentControl.ticketSystem.panelChannelId
            ? String(currentControl.ticketSystem.panelChannelId)
            : null);
    const ticketsHelperRoleIds = patch && Object.prototype.hasOwnProperty.call(patch, 'ticketsHelperRoleIds')
        ? normalizeOptionalSnowflakeArray(patch.ticketsHelperRoleIds, 'Ticket helper role ID')
        : (currentControl.ticketSystem && Array.isArray(currentControl.ticketSystem.helperRoleIds)
            ? currentControl.ticketSystem.helperRoleIds.map((value) => String(value)).filter(Boolean)
            : []);
    const levelSystemEnabled = patch && Object.prototype.hasOwnProperty.call(patch, 'levelSystemEnabled')
        ? Boolean(patch.levelSystemEnabled)
        : Boolean(currentControl.levelSystem && currentControl.levelSystem.enabled);
    const levelAnnouncementChannelId = patch && Object.prototype.hasOwnProperty.call(patch, 'levelAnnouncementChannelId')
        ? normalizeOptionalSnowflake(patch.levelAnnouncementChannelId, 'Level-up announcement channel ID')
        : (currentControl.levelSystem && currentControl.levelSystem.announcementChannelId
            ? String(currentControl.levelSystem.announcementChannelId)
            : null);
    const levelAttachmentUnlockLevel = patch && Object.prototype.hasOwnProperty.call(patch, 'levelAttachmentUnlockLevel')
        ? normalizeLevelUnlockLevel(patch.levelAttachmentUnlockLevel)
        : normalizeLevelUnlockLevel(currentControl.levelSystem && currentControl.levelSystem.attachmentUnlockLevel);
    const levelMentionEnabled = patch && Object.prototype.hasOwnProperty.call(patch, 'levelMentionEnabled')
        ? Boolean(patch.levelMentionEnabled)
        : (currentControl.levelSystem ? currentControl.levelSystem.mentionLevelUps !== false : true);
    const currentLeaderboardRole = currentControl.leaderboardRole || {};
    const leaderboardRoleEnabled = patch && Object.prototype.hasOwnProperty.call(patch, 'leaderboardRoleEnabled')
        ? Boolean(patch.leaderboardRoleEnabled)
        : Boolean(currentLeaderboardRole.enabled);
    const leaderboardRoleOrderedDataStoreName = patch && Object.prototype.hasOwnProperty.call(patch, 'leaderboardRoleOrderedDataStoreName')
        ? normalizeDatastoreName(patch.leaderboardRoleOrderedDataStoreName)
        : (currentLeaderboardRole.orderedDataStoreName ? String(currentLeaderboardRole.orderedDataStoreName) : null);
    const leaderboardRoleOrderedDataStoreScope = patch && Object.prototype.hasOwnProperty.call(patch, 'leaderboardRoleOrderedDataStoreScope')
        ? normalizeDatastoreScope(patch.leaderboardRoleOrderedDataStoreScope)
        : normalizeDatastoreScope(currentLeaderboardRole.orderedDataStoreScope);
    const leaderboardRoleKeyPrefix = patch && Object.prototype.hasOwnProperty.call(patch, 'leaderboardRoleKeyPrefix')
        ? normalizeLeaderboardKeyPrefix(patch.leaderboardRoleKeyPrefix)
        : normalizeLeaderboardKeyPrefix(currentLeaderboardRole.keyPrefix);
    const leaderboardRoleTopSize = patch && Object.prototype.hasOwnProperty.call(patch, 'leaderboardRoleTopSize')
        ? normalizeLeaderboardTopSize(patch.leaderboardRoleTopSize)
        : normalizeLeaderboardTopSize(currentLeaderboardRole.topSize);
    const leaderboardRoleSyncIntervalMinutes = patch && Object.prototype.hasOwnProperty.call(patch, 'leaderboardRoleSyncIntervalMinutes')
        ? normalizeLeaderboardSyncIntervalMinutes(patch.leaderboardRoleSyncIntervalMinutes)
        : normalizeLeaderboardSyncIntervalMinutes(currentLeaderboardRole.syncIntervalMinutes);
    const leaderboardRoleId = patch && Object.prototype.hasOwnProperty.call(patch, 'leaderboardRoleId')
        ? normalizeOptionalSnowflake(patch.leaderboardRoleId, 'Leaderboard role ID')
        : (currentLeaderboardRole.roleId ? String(currentLeaderboardRole.roleId) : null);
    const leaderboardRoleName = patch && Object.prototype.hasOwnProperty.call(patch, 'leaderboardRoleName')
        ? normalizeLeaderboardRoleName(patch.leaderboardRoleName)
        : normalizeLeaderboardRoleName(currentLeaderboardRole.roleName);
    const leaderboardRoleHoist = patch && Object.prototype.hasOwnProperty.call(patch, 'leaderboardRoleHoist')
        ? Boolean(patch.leaderboardRoleHoist)
        : Boolean(currentLeaderboardRole.hoist);
    const leaderboardRoleIconUpload = patch && Object.prototype.hasOwnProperty.call(patch, 'leaderboardRoleIconDataUrl')
        ? normalizeLeaderboardRoleIconUpload(patch.leaderboardRoleIconDataUrl)
        : null;
    const leaderboardRoleIconClear = !leaderboardRoleIconUpload
        && patch
        && Object.prototype.hasOwnProperty.call(patch, 'leaderboardRoleIconClear')
        && Boolean(patch.leaderboardRoleIconClear);
    const leaderboardRoleIconUpdate = Boolean(leaderboardRoleIconUpload);

    const result = await postgresQuery(`
        update discord_bot_control
        set
            desired_enabled = $2,
            guild_id = $3,
            content_rules_channel_id = $4,
            content_info_channel_id = $5,
            content_roles_channel_id = $6,
            content_staff_info_channel_id = $7,
            content_game_test_info_channel_id = $8,
            tickets_category_channel_id = $9,
            tickets_panel_channel_id = $10,
            tickets_helper_role_ids = $11,
            tickets_panel_message_id = case
                when tickets_panel_channel_id is distinct from $10 then null
                else tickets_panel_message_id
            end,
            level_system_enabled = $12,
            level_announcement_channel_id = $13,
            level_attachment_unlock_level = $14,
            level_mention_enabled = $15,
            leaderboard_role_enabled = $16,
            leaderboard_role_ordered_datastore_name = $17,
            leaderboard_role_ordered_datastore_scope = $18,
            leaderboard_role_key_prefix = $19,
            leaderboard_role_top_size = $20,
            leaderboard_role_sync_interval_minutes = $21,
            leaderboard_role_id = $22,
            leaderboard_role_name = $23,
            leaderboard_role_hoist = $24,
            leaderboard_role_icon_content_type = case
                when $27 = true then $29
                when $28 = true then null
                else leaderboard_role_icon_content_type
            end,
            leaderboard_role_icon_data = case
                when $27 = true then $30
                when $28 = true then null
                else leaderboard_role_icon_data
            end,
            leaderboard_role_icon_sha256 = case
                when $27 = true then $31
                when $28 = true then null
                else leaderboard_role_icon_sha256
            end,
            leaderboard_role_icon_updated_at = case
                when $27 = true or $28 = true then now()
                else leaderboard_role_icon_updated_at
            end,
            updated_at = now(),
            updated_by_user_id = $25,
            updated_by_username = $26,
            last_error = case when $2 = false then null else last_error end
        where id = $1
        returning
            desired_enabled,
            runtime_status,
            last_seen_at,
            last_error,
            updated_at,
            updated_by_user_id,
            updated_by_username,
            guild_id,
            content_rules_channel_id,
            content_info_channel_id,
            content_roles_channel_id,
            content_staff_info_channel_id,
            content_game_test_info_channel_id,
            tickets_category_channel_id,
            tickets_panel_channel_id,
            tickets_panel_message_id,
            tickets_helper_role_ids,
            level_system_enabled,
            level_announcement_channel_id,
            level_attachment_unlock_level,
            level_mention_enabled,
            leaderboard_role_enabled,
            leaderboard_role_ordered_datastore_name,
            leaderboard_role_ordered_datastore_scope,
            leaderboard_role_key_prefix,
            leaderboard_role_top_size,
            leaderboard_role_sync_interval_minutes,
            leaderboard_role_id,
            leaderboard_role_name,
            leaderboard_role_hoist,
            leaderboard_role_icon_content_type,
            leaderboard_role_icon_data,
            leaderboard_role_icon_sha256,
            leaderboard_role_icon_updated_at
    `, [
        CONTROL_ID,
        desiredEnabled,
        guildId,
        contentRulesChannelId,
        contentInfoChannelId,
        contentRolesChannelId,
        contentStaffInfoChannelId,
        contentGameTestInfoChannelId,
        ticketsCategoryChannelId,
        ticketsPanelChannelId,
        ticketsHelperRoleIds,
        levelSystemEnabled,
        levelAnnouncementChannelId,
        levelAttachmentUnlockLevel,
        levelMentionEnabled,
        leaderboardRoleEnabled,
        leaderboardRoleOrderedDataStoreName,
        leaderboardRoleOrderedDataStoreScope,
        leaderboardRoleKeyPrefix,
        leaderboardRoleTopSize,
        leaderboardRoleSyncIntervalMinutes,
        leaderboardRoleId,
        leaderboardRoleName,
        leaderboardRoleHoist,
        user && user.id ? String(user.id) : null,
        user && user.username ? String(user.username) : null,
        leaderboardRoleIconUpdate,
        leaderboardRoleIconClear,
        leaderboardRoleIconUpload ? leaderboardRoleIconUpload.contentType : null,
        leaderboardRoleIconUpload ? leaderboardRoleIconUpload.data : null,
        leaderboardRoleIconUpload ? leaderboardRoleIconUpload.sha256 : null
    ]);

    return mapRowToDiscordBotControl(result.rows[0]);
}

async function setDiscordTicketPanelMessageId(panelMessageId) {
    await ensureDiscordBotControlSchema();

    const result = await postgresQuery(`
        update discord_bot_control
        set tickets_panel_message_id = $2
        where id = $1
        returning
            desired_enabled,
            runtime_status,
            last_seen_at,
            last_error,
            updated_at,
            updated_by_user_id,
            updated_by_username,
            guild_id,
            content_rules_channel_id,
            content_info_channel_id,
            content_roles_channel_id,
            content_staff_info_channel_id,
            content_game_test_info_channel_id,
            tickets_category_channel_id,
            tickets_panel_channel_id,
            tickets_panel_message_id,
            tickets_helper_role_ids,
            level_system_enabled,
            level_announcement_channel_id,
            level_attachment_unlock_level,
            level_mention_enabled,
            leaderboard_role_enabled,
            leaderboard_role_ordered_datastore_name,
            leaderboard_role_ordered_datastore_scope,
            leaderboard_role_key_prefix,
            leaderboard_role_top_size,
            leaderboard_role_sync_interval_minutes,
            leaderboard_role_id,
            leaderboard_role_name,
            leaderboard_role_hoist,
            leaderboard_role_icon_content_type,
            leaderboard_role_icon_data,
            leaderboard_role_icon_sha256,
            leaderboard_role_icon_updated_at
    `, [
        CONTROL_ID,
        normalizeOptionalSnowflake(panelMessageId, 'Ticket panel message ID')
    ]);

    return mapRowToDiscordBotControl(result.rows[0]);
}

async function setDiscordBotRuntimeStatus(runtimeStatus, lastError) {
    await ensureDiscordBotControlSchema();

    const result = await postgresQuery(`
        update discord_bot_control
        set
            runtime_status = $2,
            last_seen_at = now(),
            last_error = $3
        where id = $1
        returning
            desired_enabled,
            runtime_status,
            last_seen_at,
            last_error,
            updated_at,
            updated_by_user_id,
            updated_by_username,
            guild_id,
            content_rules_channel_id,
            content_info_channel_id,
            content_roles_channel_id,
            content_staff_info_channel_id,
            content_game_test_info_channel_id,
            tickets_category_channel_id,
            tickets_panel_channel_id,
            tickets_panel_message_id,
            tickets_helper_role_ids,
            level_system_enabled,
            level_announcement_channel_id,
            level_attachment_unlock_level,
            level_mention_enabled,
            leaderboard_role_enabled,
            leaderboard_role_ordered_datastore_name,
            leaderboard_role_ordered_datastore_scope,
            leaderboard_role_key_prefix,
            leaderboard_role_top_size,
            leaderboard_role_sync_interval_minutes,
            leaderboard_role_id,
            leaderboard_role_name,
            leaderboard_role_hoist,
            leaderboard_role_icon_content_type,
            leaderboard_role_icon_data,
            leaderboard_role_icon_sha256,
            leaderboard_role_icon_updated_at
    `, [
        CONTROL_ID,
        String(runtimeStatus || 'offline'),
        lastError ? String(lastError).slice(0, 1000) : null
    ]);

    return mapRowToDiscordBotControl(result.rows[0]);
}

async function setDiscordLeaderboardRoleId(roleId) {
    await ensureDiscordBotControlSchema();

    const result = await postgresQuery(`
        update discord_bot_control
        set leaderboard_role_id = $2
        where id = $1
        returning
            desired_enabled,
            runtime_status,
            last_seen_at,
            last_error,
            updated_at,
            updated_by_user_id,
            updated_by_username,
            guild_id,
            content_rules_channel_id,
            content_info_channel_id,
            content_roles_channel_id,
            content_staff_info_channel_id,
            content_game_test_info_channel_id,
            tickets_category_channel_id,
            tickets_panel_channel_id,
            tickets_panel_message_id,
            tickets_helper_role_ids,
            level_system_enabled,
            level_announcement_channel_id,
            level_attachment_unlock_level,
            level_mention_enabled,
            leaderboard_role_enabled,
            leaderboard_role_ordered_datastore_name,
            leaderboard_role_ordered_datastore_scope,
            leaderboard_role_key_prefix,
            leaderboard_role_top_size,
            leaderboard_role_sync_interval_minutes,
            leaderboard_role_id,
            leaderboard_role_name,
            leaderboard_role_hoist,
            leaderboard_role_icon_content_type,
            leaderboard_role_icon_data,
            leaderboard_role_icon_sha256,
            leaderboard_role_icon_updated_at
    `, [
        CONTROL_ID,
        normalizeOptionalSnowflake(roleId, 'Leaderboard role ID')
    ]);

    return mapRowToDiscordBotControl(result.rows[0]);
}

module.exports = {
    ensureDiscordBotControlSchema,
    getDiscordBotControl,
    updateDiscordBotControl,
    setDiscordTicketPanelMessageId,
    setDiscordBotRuntimeStatus,
    setDiscordLeaderboardRoleId
};
