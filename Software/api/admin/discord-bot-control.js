const { methodNotAllowed, readJsonBody, sendJson } = require('../_lib/http');
const { requireAdmin } = require('../_lib/admin-auth');
const {
    getDiscordBotControl: getRawDiscordBotControl,
    updateDiscordBotControl
} = require('../_lib/discord-bot-control-store');
const {
    getDiscordTicketTranscript,
    listDiscordTicketTranscripts
} = require('../_lib/discord-ticket-store');

const infrastructureStore = require('../_lib/discord-infrastructure-store');
const { controlWithLayout } = require('../../bot/server-infrastructure');
const { manifest } = require('../../bot/server-blueprint');
async function getDiscordBotControl() {
    const control = await getRawDiscordBotControl();
    const state = await infrastructureStore.getState(manifest.guildId);
    return { ...controlWithLayout(control, state.active), serverLayoutManaged: Boolean(state.initialized || state.maintenance), serverLayoutMaintenance: state.maintenance };
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
            return sendJson(res, 200, { control });
        }

        const body = await readJsonBody(req);
        if (!body || typeof body.desiredEnabled !== 'boolean' || Object.keys(body).some(key => key !== 'desiredEnabled')) {
            return sendJson(res, 400, { error: 'Only Connect/Disconnect is configurable here. Server, startup channels, tickets and levels are defined in the repository; announcements are posted directly in Discord.' });
        }
        const existing = await getDiscordBotControl();
        if (existing.serverLayoutMaintenance) return sendJson(res, 409, { error: 'A server rebuild is in progress. Finish it before changing bot status.' });
        await updateDiscordBotControl({ desiredEnabled: body.desiredEnabled }, auth.user);
        return sendJson(res, 200, { control: await getDiscordBotControl() });
    } catch (error) {
        return sendJson(res, 500, {
            error: 'Failed to update Discord bot control',
            details: error.message
        });
    }
};
