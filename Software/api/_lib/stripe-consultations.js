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

function getConsultationOfferCode(value) {
    const code = String(value || '').trim().toLowerCase();
    return /^[a-z0-9_-]{1,64}$/.test(code) ? code : '';
}

function getConsultationOfferMap() {
    const offers = new Map();
    const raw = String(process.env.CONSULTATION_DISCOUNT_OFFERS || '').trim();
    if (!raw) {
        return offers;
    }

    raw.split(/[\n,;]+/).forEach((entry) => {
        const cleaned = entry.trim();
        if (!cleaned) {
            return;
        }

        const separatorIndex = cleaned.search(/[:=]/);
        if (separatorIndex <= 0) {
            return;
        }

        const code = getConsultationOfferCode(cleaned.slice(0, separatorIndex));
        const amountTotal = Number.parseInt(cleaned.slice(separatorIndex + 1).trim(), 10);
        if (code && Number.isFinite(amountTotal) && amountTotal > 0) {
            offers.set(code, amountTotal);
        }
    });

    return offers;
}

function getConsultationOffer(value) {
    const code = getConsultationOfferCode(value);
    if (!code) {
        return null;
    }

    const amountTotal = getConsultationOfferMap().get(code);
    const baseAmountTotal = getConsultationAmountTotal();
    if (!Number.isFinite(amountTotal) || amountTotal <= 0 || amountTotal >= baseAmountTotal) {
        return null;
    }

    const currency = getConsultationCurrency();
    return {
        code,
        amountTotal,
        currency,
        displayPrice: formatConsultationPrice(amountTotal, currency)
    };
}

function getConsultationCurrency() {
    return getConsultationCurrencyValue(process.env.CONSULTATION_CURRENCY);
}

function formatConsultationPrice(amountTotal, currency) {
    const normalizedAmount = Number.isFinite(Number(amountTotal)) ? Math.max(0, Math.trunc(Number(amountTotal))) : 0;
    const normalizedCurrency = getConsultationCurrencyValue(currency);
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: normalizedCurrency.toUpperCase(),
        minimumFractionDigits: normalizedAmount % 100 === 0 ? 0 : 2,
        maximumFractionDigits: 2
    }).format(normalizedAmount / 100);
}

function getConsultationCurrencyValue(currency) {
    const configured = String(currency || 'usd').trim().toLowerCase();
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

async function createConsultationCheckoutSession({ req, booking, offer }) {
    const stripe = getStripe();
    const baseUrl = getPublicBaseUrl(req);
    const cancelUrl = new URL('/consultation', baseUrl);
    if (offer && offer.code) {
        cancelUrl.searchParams.set('offer', offer.code);
    }
    cancelUrl.searchParams.set('cancelled', '1');

    return stripe.checkout.sessions.create({
        mode: 'payment',
        adaptive_pricing: {
            enabled: false
        },
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
                        description: '60-minute live audit with a RoDark Studios owner, covering monetization, retention, UI, economy, and growth strategy.'
                    }
                }
            }
        ],
        success_url: `${baseUrl}/consultation/thanks?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: cancelUrl.toString(),
        metadata: {
            booking_id: booking.id,
            roblox_user_id: booking.robloxUserId,
            roblox_username: booking.robloxUsername,
            consultation_offer_code: offer && offer.code ? offer.code : ''
        }
    });
}

module.exports = {
    createConsultationCheckoutSession,
    formatConsultationPrice,
    getConsultationAmountTotal,
    getConsultationCurrency,
    getConsultationOffer,
    getConsultationOfferCode,
    getStripe,
    getStripeSecretKey,
    getStripeWebhookSecret
};
