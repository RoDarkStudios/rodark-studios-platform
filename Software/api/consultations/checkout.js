const { methodNotAllowed, readJsonBody, sendJson } = require('../_lib/http');
const { requireUserFromSession } = require('../_lib/session');
const {
    attachCheckoutSession,
    createConsultationBooking
} = require('../_lib/consultation-bookings-store');
const {
    createConsultationCheckoutSession,
    getConsultationAmountTotal,
    getConsultationCurrency,
    getConsultationOffer,
    getConsultationOfferCode,
    getStripeSecretKey
} = require('../_lib/stripe-consultations');

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return methodNotAllowed(req, res, ['POST']);
    }

    try {
        const { user } = await requireUserFromSession(req, res);
        if (!user) {
            return sendJson(res, 401, {
                error: 'Sign in with Roblox before booking',
                loginRequired: true
            });
        }

        if (!getStripeSecretKey()) {
            return sendJson(res, 503, {
                error: 'Checkout is not configured yet'
            });
        }

        const body = await readJsonBody(req);
        const rawOfferCode = String(body && body.offerCode || '').trim();
        const requestedOfferCode = getConsultationOfferCode(rawOfferCode);
        const offer = requestedOfferCode ? getConsultationOffer(requestedOfferCode) : null;
        if (rawOfferCode && (!requestedOfferCode || !offer)) {
            return sendJson(res, 400, {
                error: 'This consultation discount link is invalid or expired'
            });
        }

        const booking = await createConsultationBooking({
            user,
            body,
            amountTotal: offer ? offer.amountTotal : getConsultationAmountTotal(),
            currency: getConsultationCurrency()
        });
        const session = await createConsultationCheckoutSession({ req, booking, offer });
        await attachCheckoutSession({
            bookingId: booking.id,
            sessionId: session.id
        });

        return sendJson(res, 200, {
            checkoutUrl: session.url,
            bookingId: booking.id
        });
    } catch (error) {
        const message = String(error && error.message || '');
        const statusCode = /required|valid roblox|valid email|reviewed/i.test(message) ? 400 : 500;
        return sendJson(res, statusCode, {
            error: statusCode === 400 ? message : 'Failed to start checkout',
            details: statusCode === 400 ? undefined : message
        });
    }
};
