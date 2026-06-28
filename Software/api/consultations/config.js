const { methodNotAllowed, sendJson } = require('../_lib/http');
const {
    formatConsultationPrice,
    getConsultationAmountTotal,
    getConsultationCurrency,
    getConsultationOffer,
    getConsultationOfferCode
} = require('../_lib/stripe-consultations');

function getQueryParam(req, name) {
    if (req.query && Object.prototype.hasOwnProperty.call(req.query, name)) {
        return req.query[name];
    }

    const requestUrl = new URL(req.url || '/', 'http://localhost');
    return requestUrl.searchParams.get(name);
}

module.exports = async (req, res) => {
    if (req.method !== 'GET') {
        return methodNotAllowed(req, res, ['GET']);
    }

    const baseAmountTotal = getConsultationAmountTotal();
    const currency = getConsultationCurrency();
    const rawOfferCode = String(getQueryParam(req, 'offer') || '').trim();
    const requestedOfferCode = getConsultationOfferCode(rawOfferCode);
    const offer = getConsultationOffer(requestedOfferCode);
    const amountTotal = offer ? offer.amountTotal : baseAmountTotal;

    return sendJson(res, 200, {
        amountTotal,
        currency,
        displayPrice: formatConsultationPrice(amountTotal, currency),
        baseAmountTotal,
        baseDisplayPrice: formatConsultationPrice(baseAmountTotal, currency),
        offer: offer ? {
            code: offer.code,
            amountTotal: offer.amountTotal,
            displayPrice: offer.displayPrice
        } : null,
        offerError: rawOfferCode && (!requestedOfferCode || !offer) ? 'invalid_or_expired' : null
    });
};
