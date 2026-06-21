const { methodNotAllowed, sendJson } = require('../_lib/http');
const {
    markCheckoutExpired,
    markCheckoutPaid
} = require('../_lib/consultation-bookings-store');
const {
    getStripe,
    getStripeWebhookSecret
} = require('../_lib/stripe-consultations');

async function handleCheckoutSession(session) {
    if (!session || !session.id) {
        return null;
    }

    if (session.payment_status === 'paid') {
        return markCheckoutPaid({
            sessionId: session.id,
            paymentIntentId: session.payment_intent,
            customerEmail: session.customer_details && session.customer_details.email,
            amountTotal: session.amount_total,
            currency: session.currency
        });
    }

    if (session.status === 'expired') {
        return markCheckoutExpired(session.id);
    }

    return null;
}

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return methodNotAllowed(req, res, ['POST']);
    }

    try {
        const rawBody = Buffer.isBuffer(req.rawBody)
            ? req.rawBody
            : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}), 'utf8');
        const webhookSecret = getStripeWebhookSecret();
        if (!webhookSecret) {
            return sendJson(res, 503, {
                error: 'Stripe webhook is not configured'
            });
        }

        const stripe = getStripe();
        const event = stripe.webhooks.constructEvent(
            rawBody,
            req.headers['stripe-signature'],
            webhookSecret
        );

        if (
            event.type === 'checkout.session.completed'
            || event.type === 'checkout.session.async_payment_succeeded'
            || event.type === 'checkout.session.expired'
        ) {
            await handleCheckoutSession(event.data && event.data.object);
        }

        return sendJson(res, 200, { received: true });
    } catch (error) {
        return sendJson(res, 400, {
            error: 'Stripe webhook failed',
            details: error.message
        });
    }
};
