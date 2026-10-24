const { sendJson } = require('./http');

// Opt in explicitly so the preserved feature stays disabled after deployment.
function areConsultationsEnabled() {
    return String(process.env.CONSULTATIONS_ENABLED || '').trim().toLowerCase() === 'true';
}

function renderConsultationFeatures(html) {
    const enabled = areConsultationsEnabled();
    return html.replace(
        /<!-- consultations:start -->([\s\S]*?)<!-- consultations:end -->/g,
        (_, content) => enabled ? content : ''
    );
}

function withConsultationsEnabled(handler) {
    return (req, res) => {
        if (!areConsultationsEnabled()) {
            res.setHeader('Cache-Control', 'no-store');
            return sendJson(res, 503, { error: 'Consultations are currently unavailable' });
        }
        return handler(req, res);
    };
}

module.exports = { areConsultationsEnabled, renderConsultationFeatures, withConsultationsEnabled };
