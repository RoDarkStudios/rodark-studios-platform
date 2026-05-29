const { methodNotAllowed, sendJson } = require('../_lib/http');
const { clearAuthCookies } = require('../_lib/cookies');

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return methodNotAllowed(req, res, ['POST']);
    }

    clearAuthCookies(res);
    return sendJson(res, 200, { ok: true });
};
