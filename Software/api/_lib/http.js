const MAX_JSON_BODY_BYTES = 5 * 1024 * 1024;

function sendJson(res, status, data) {
    res.status(status).json(data);
}

function methodNotAllowed(req, res, allowed) {
    res.setHeader('Allow', allowed.join(', '));
    return sendJson(res, 405, { error: `Method ${req.method} Not Allowed` });
}

async function readJsonBody(req) {
    if (req.body && typeof req.body === 'object') {
        return req.body;
    }

    if (typeof req.body === 'string' && req.body.length > 0) {
        return JSON.parse(req.body);
    }

    const chunks = [];
    let totalLength = 0;
    for await (const chunk of req) {
        totalLength += chunk.length;
        if (totalLength > MAX_JSON_BODY_BYTES) {
            const error = new Error('Request body too large');
            error.statusCode = 413;
            throw error;
        }
        chunks.push(chunk);
    }

    if (chunks.length === 0) {
        return {};
    }

    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) {
        return {};
    }

    return JSON.parse(raw);
}

module.exports = {
    sendJson,
    methodNotAllowed,
    readJsonBody
};
