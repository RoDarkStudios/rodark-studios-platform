const { methodNotAllowed, readJsonBody, sendJson } = require('../_lib/http');
const { requireUserFromSession } = require('../_lib/session');
const {
    findBookingByCheckoutSession,
    markCheckoutPaid
} = require('../_lib/consultation-bookings-store');
const { getStripe } = require('../_lib/stripe-consultations');

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return methodNotAllowed(req, res, ['POST']);
    }

    try {
        const { user } = await requireUserFromSession(req, res);
        if (!user) {
            return sendJson(res, 401, { error: 'Not authenticated' });
        }

        const body = await readJsonBody(req);
        const sessionId = String(body && body.sessionId || '').trim();
        if (!sessionId) {
            return sendJson(res, 400, { error: 'Missing checkout session' });
        }

        const booking = await findBookingByCheckoutSession(sessionId);
        if (!booking) {
            return sendJson(res, 404, { error: 'Booking not found' });
        }
        if (booking.robloxUserId !== user.id) {
            return sendJson(res, 403, { error: 'This booking belongs to another Roblox account' });
        }

        if (booking.paymentStatus === 'paid') {
            return sendJson(res, 200, { booking });
        }

        const stripe = getStripe();
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        if (session.payment_status !== 'paid') {
            return sendJson(res, 202, {
                booking,
                paymentStatus: session.payment_status || 'pending'
            });
        }

        const updatedBooking = await markCheckoutPaid({
            sessionId: session.id,
            paymentIntentId: session.payment_intent,
            customerEmail: session.customer_details && session.customer_details.email,
            amountTotal: session.amount_total,
            currency: session.currency
        });

        return sendJson(res, 200, { booking: updatedBooking });
    } catch (error) {
        return sendJson(res, 500, {
            error: 'Failed to confirm checkout',
            details: error.message
        });
    }
};
