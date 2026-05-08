const { methodNotAllowed, readJsonBody, sendJson } = require('../_lib/http');
const { requireAdmin } = require('../_lib/admin-auth');
const {
    getAdminPlatformSettings,
    saveAdminPlatformSettings
} = require('../_lib/admin-platform-settings-store');

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
            const settings = await getAdminPlatformSettings();
            return sendJson(res, 200, { settings });
        }

        const body = await readJsonBody(req);
        const settings = await saveAdminPlatformSettings({
            openaiModel: body && body.openaiModel
        }, auth.user);
        return sendJson(res, 200, { settings });
    } catch (error) {
        const statusCode = /openai model|unsupported characters|characters or fewer/i.test(String(error && error.message || ''))
            ? 400
            : 500;
        return sendJson(res, statusCode, {
            error: 'Failed to update platform settings',
            details: error.message
        });
    }
};
