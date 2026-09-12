const { methodNotAllowed, readJsonBody, sendJson } = require('../_lib/http');
const { getRequestOrigin } = require('../_lib/auth-config');
const { requireAdmin } = require('../_lib/admin-auth');
const { getDiscordBotControl } = require('../_lib/discord-bot-control-store');
const store = require('../_lib/discord-infrastructure-store');
const { compileBlueprint } = require('../../bot/server-blueprint');

function createHandler(dependencies = {}) {
    const authorize = dependencies.authorize || requireAdmin;
    const getControl = dependencies.getControl || getDiscordBotControl;
    const persistence = dependencies.store || store;
    return async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        if (!['GET', 'POST'].includes(req.method)) return methodNotAllowed(req, res, ['GET', 'POST']);
        try {
            const auth = await authorize(req, res);
            if (!auth.user) return sendJson(res, 401, { error: 'Sign in with your studio owner account.' });
            if (!auth.isAdmin || !Number.isInteger(auth.rank) || auth.rank < 254) return sendJson(res, 403, { error: 'Only studio owners can deploy the Discord server.' });
            const control = await getControl();
            const blueprint = compileBlueprint(control);
            if (control.guildId && control.guildId !== blueprint.guildId) return sendJson(res, 409, { error: 'The configured server differs from discord/server.json.' });
            if (req.method === 'GET') {
                const [state, jobs] = await Promise.all([persistence.getState(blueprint.guildId), persistence.latestJobs(blueprint.guildId)]);
                return sendJson(res, 200, { version: blueprint.version, guildId: blueprint.guildId, name: blueprint.spec.name,
                    online: control.desiredEnabled && control.runtimeStatus === 'online',
                    initialized: state.initialized, maintenance: state.maintenance, lastSuccessAt: state.last_success_at,
                    lastCheckedAt: state.last_checked_at, drift: state.drift, activeVersion: state.active?.version || null,
                    jobs, blueprint: { roles: blueprint.roles, channels: blueprint.channels, onboarding: blueprint.spec.onboarding,
                        games: blueprint.spec.games, notifications: blueprint.spec.notifications, settings: blueprint.spec.settings } });
            }
            if (String(req.headers.origin || '') !== getRequestOrigin(req) || !String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
                return sendJson(res, 403, { error: 'Use the deployment controls on this website.' });
            }
            const body = await readJsonBody(req);
            if (!body || Object.keys(body).some((key) => !['action', 'previewId', 'version'].includes(key))) return sendJson(res, 400, { error: 'Only a preview or deployment request is accepted.' });
            if (body.version !== blueprint.version) return sendJson(res, 409, { error: 'The configuration changed. Refresh this page.' });
            const actor = { id: String(auth.user.id), username: String(auth.user.username || auth.user.name || '') };
            if (body.action === 'preview') return sendJson(res, 202, { job: await persistence.queuePreview(blueprint.guildId, blueprint.version, actor) });
            if (body.action === 'deploy' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(body.previewId || '')) {
                return sendJson(res, 202, { job: await persistence.queueDeploy(blueprint.guildId, body.previewId, blueprint.version, actor) });
            }
            return sendJson(res, 400, { error: 'Choose Preview changes or Deploy.' });
        } catch (error) {
            console.error('[discord-infrastructure-api]', error.message);
            return sendJson(res, error.statusCode || 500, { error: error.message || 'The deployment controls are unavailable.' });
        }
    };
}
module.exports = createHandler();
module.exports.createHandler = createHandler;
