const { ensureDiscordBotControlSchema } = require('./discord-bot-control-store');
const { postgresQuery } = require('./postgres');

async function reserveDiscordTicketId() {
    await ensureDiscordBotControlSchema();

    const result = await postgresQuery(`
        select nextval('discord_bot_ticket_id_seq') as ticket_id
    `);

    return Number(result.rows[0].ticket_id);
}

async function createDiscordTicketRecord(ticket) {
    await ensureDiscordBotControlSchema();

    await postgresQuery(`
        insert into discord_bot_tickets (
            ticket_id,
            guild_id,
            channel_id,
            opener_user_id,
            status
        )
        values ($1, $2, $3, $4, 'open')
        on conflict (ticket_id) do nothing
    `, [
        ticket.ticketId,
        String(ticket.guildId),
        String(ticket.channelId),
        String(ticket.openerUserId)
    ]);
}

async function getOpenDiscordTicketForUser(guildId, openerUserId) {
    await ensureDiscordBotControlSchema();

    const result = await postgresQuery(`
        select
            ticket_id,
            guild_id,
            channel_id,
            opener_user_id,
            status
        from discord_bot_tickets
        where guild_id = $1
            and opener_user_id = $2
            and status = 'open'
        order by created_at asc
        limit 1
    `, [
        String(guildId),
        String(openerUserId)
    ]);

    const row = result.rows[0];
    if (!row) {
        return null;
    }

    return {
        ticketId: Number(row.ticket_id),
        guildId: String(row.guild_id),
        channelId: String(row.channel_id),
        openerUserId: String(row.opener_user_id),
        status: String(row.status)
    };
}

async function closeDiscordTicketRecord(channelId, closedByUserId) {
    await ensureDiscordBotControlSchema();

    const result = await postgresQuery(`
        update discord_bot_tickets
        set
            status = 'closed',
            closed_at = coalesce(closed_at, now()),
            closed_by_user_id = coalesce(closed_by_user_id, $2)
        where channel_id = $1
        returning
            ticket_id,
            guild_id,
            channel_id,
            opener_user_id,
            status,
            created_at,
            closed_at,
            closed_by_user_id
    `, [
        String(channelId),
        closedByUserId ? String(closedByUserId) : null
    ]);

    const row = result.rows[0];
    if (!row) {
        return null;
    }

    return {
        ticketId: Number(row.ticket_id),
        guildId: String(row.guild_id),
        channelId: String(row.channel_id),
        openerUserId: String(row.opener_user_id),
        status: String(row.status),
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at || ''),
        closedAt: row.closed_at instanceof Date ? row.closed_at.toISOString() : String(row.closed_at || ''),
        closedByUserId: row.closed_by_user_id ? String(row.closed_by_user_id) : null
    };
}

async function saveDiscordTicketTranscript(transcript) {
    await ensureDiscordBotControlSchema();

    await postgresQuery(`
        insert into discord_bot_ticket_transcripts (
            ticket_id,
            guild_id,
            channel_id,
            channel_name,
            opener_user_id,
            closed_by_user_id,
            created_at,
            closed_at,
            message_count,
            transcript
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
        on conflict (ticket_id) do update
        set
            guild_id = excluded.guild_id,
            channel_id = excluded.channel_id,
            channel_name = excluded.channel_name,
            opener_user_id = excluded.opener_user_id,
            closed_by_user_id = excluded.closed_by_user_id,
            created_at = excluded.created_at,
            closed_at = excluded.closed_at,
            message_count = excluded.message_count,
            transcript = excluded.transcript
    `, [
        transcript.ticketId,
        String(transcript.guildId),
        String(transcript.channelId),
        String(transcript.channelName || ''),
        String(transcript.openerUserId),
        transcript.closedByUserId ? String(transcript.closedByUserId) : null,
        transcript.createdAt || null,
        transcript.closedAt || null,
        Number(transcript.messageCount) || 0,
        JSON.stringify(Array.isArray(transcript.messages) ? transcript.messages : [])
    ]);
}

async function listDiscordTicketTranscripts(limit, offset) {
    await ensureDiscordBotControlSchema();

    const safeLimit = Math.min(Math.max(Number.parseInt(String(limit || '50'), 10) || 50, 1), 100);
    const safeOffset = Math.max(Number.parseInt(String(offset || '0'), 10) || 0, 0);
    const result = await postgresQuery(`
        select
            ticket_id,
            guild_id,
            channel_id,
            channel_name,
            opener_user_id,
            closed_by_user_id,
            created_at,
            closed_at,
            message_count
        from discord_bot_ticket_transcripts
        order by closed_at desc, ticket_id desc
        limit $1
        offset $2
    `, [safeLimit, safeOffset]);

    return result.rows.map((row) => ({
        ticketId: Number(row.ticket_id),
        guildId: String(row.guild_id),
        channelId: String(row.channel_id),
        channelName: String(row.channel_name || ''),
        openerUserId: String(row.opener_user_id),
        closedByUserId: row.closed_by_user_id ? String(row.closed_by_user_id) : null,
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at || ''),
        closedAt: row.closed_at instanceof Date ? row.closed_at.toISOString() : String(row.closed_at || ''),
        messageCount: Number(row.message_count) || 0
    }));
}

async function getDiscordTicketTranscript(ticketId) {
    await ensureDiscordBotControlSchema();

    const result = await postgresQuery(`
        select
            ticket_id,
            guild_id,
            channel_id,
            channel_name,
            opener_user_id,
            closed_by_user_id,
            created_at,
            closed_at,
            message_count,
            transcript
        from discord_bot_ticket_transcripts
        where ticket_id = $1
    `, [Number(ticketId)]);

    const row = result.rows[0];
    if (!row) {
        return null;
    }

    return {
        ticketId: Number(row.ticket_id),
        guildId: String(row.guild_id),
        channelId: String(row.channel_id),
        channelName: String(row.channel_name || ''),
        openerUserId: String(row.opener_user_id),
        closedByUserId: row.closed_by_user_id ? String(row.closed_by_user_id) : null,
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at || ''),
        closedAt: row.closed_at instanceof Date ? row.closed_at.toISOString() : String(row.closed_at || ''),
        messageCount: Number(row.message_count) || 0,
        messages: Array.isArray(row.transcript) ? row.transcript : []
    };
}

module.exports = {
    reserveDiscordTicketId,
    createDiscordTicketRecord,
    getOpenDiscordTicketForUser,
    closeDiscordTicketRecord,
    saveDiscordTicketTranscript,
    listDiscordTicketTranscripts,
    getDiscordTicketTranscript
};
