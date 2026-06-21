const { methodNotAllowed, sendJson } = require('../_lib/http');
const {
    formatConsultationPrice,
    getConsultationAmountTotal,
    getConsultationCurrency
} = require('../_lib/stripe-consultations');

module.exports = async (req, res) => {
    if (req.method !== 'GET') {
        return methodNotAllowed(req, res, ['GET']);
    }

    const amountTotal = getConsultationAmountTotal();
    const currency = getConsultationCurrency();

    return sendJson(res, 200, {
        amountTotal,
        currency,
        displayPrice: formatConsultationPrice(amountTotal, currency)
    });
};
