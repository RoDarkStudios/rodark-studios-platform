let stripeClient;

function getStripeSecretKey() {
    return String(process.env.STRIPE_SECRET_KEY || '').trim();
}

function getStripeWebhookSecret() {
    return String(process.env.STRIPE_WEBHOOK_SECRET || '').trim();
}

function getConsultationAmountTotal() {
    const configured = Number.parseInt(String(process.env.CONSULTATION_PRICE_CENTS || '').trim(), 10);
    return Number.isFinite(configured) && configured > 0 ? configured : 30000;
}

function getConsultationCurrency() {
    const configured = String(process.env.CONSULTATION_CURRENCY || 'usd').trim().toLowerCase();
    return /^[a-z]{3}$/.test(configured) ? configured : 'usd';
}

function getStripe() {
    if (stripeClient) {
        return stripeClient;
    }

    const secretKey = getStripeSecretKey();
    if (!secretKey) {
        throw new Error('STRIPE_SECRET_KEY must be set');
    }

    const Stripe = require('stripe');
    stripeClient = Stripe(secretKey);
    return stripeClient;
}

function getPublicBaseUrl(req) {
    const configured = String(process.env.PUBLIC_SITE_URL || process.env.SITE_URL || '').trim().replace(/\/+$/, '');
    if (configured) {
        return configured;
    }

    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    if (!host) {
        return 'http://localhost:3000';
    }

    return `${proto}://${host}`;
}

async function createConsultationCheckoutSession({ req, booking }) {
    const stripe = getStripe();
    const baseUrl = getPublicBaseUrl(req);

    return stripe.checkout.sessions.create({
        mode: 'payment',
        client_reference_id: booking.id,
        customer_email: booking.contactEmail || undefined,
        line_items: [
            {
                quantity: 1,
                price_data: {
                    currency: booking.currency,
                    unit_amount: booking.amountTotal,
                    product_data: {
                        name: 'Roblox Game Consultation',
                        description: '60-minute live audit covering monetization, retention, UI, economy, and growth strategy.'
                    }
                }
            }
        ],
        success_url: `${baseUrl}/consultation/thanks?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${baseUrl}/consultation?cancelled=1`,
        metadata: {
            booking_id: booking.id,
            roblox_user_id: booking.robloxUserId,
            roblox_username: booking.robloxUsername
        }
    });
}

module.exports = {
    createConsultationCheckoutSession,
    getConsultationAmountTotal,
    getConsultationCurrency,
    getStripe,
    getStripeSecretKey,
    getStripeWebhookSecret
};
