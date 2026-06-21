const crypto = require('crypto');
const { postgresQuery } = require('./postgres');

const BOOKING_STATUSES = new Set([
    'checkout_created',
    'new',
    'scheduled',
    'completed',
    'cancelled',
    'refunded'
]);

let schemaReady = false;

async function ensureConsultationBookingsSchema() {
    if (schemaReady) {
        return;
    }

    await postgresQuery(`
        create table if not exists consultation_bookings (
            id uuid primary key,
            roblox_user_id text not null,
            roblox_username text not null,
            roblox_display_name text,
            roblox_profile_url text,
            contact_discord text not null,
            contact_email text,
            game_url text not null,
            goals text not null,
            status text not null default 'checkout_created',
            payment_status text not null default 'unpaid',
            stripe_checkout_session_id text unique,
            stripe_payment_intent_id text,
            stripe_customer_email text,
            amount_total integer not null default 30000,
            currency text not null default 'usd',
            scheduled_at timestamptz,
            admin_notes text,
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now(),
            paid_at timestamptz
        )
    `);

    await postgresQuery(`
        create index if not exists consultation_bookings_created_at_idx
        on consultation_bookings (created_at desc)
    `);

    await postgresQuery(`
        create index if not exists consultation_bookings_payment_status_idx
        on consultation_bookings (payment_status)
    `);

    schemaReady = true;
}

function cleanText(value, maxLength) {
    const cleaned = String(value || '').trim();
    if (!cleaned) {
        return '';
    }

    return cleaned.length > maxLength ? cleaned.slice(0, maxLength) : cleaned;
}

function normalizeEmail(value) {
    const cleaned = cleanText(value, 254).toLowerCase();
    return cleaned || null;
}

function normalizeBooking(row) {
    if (!row) {
        return null;
    }

    return {
        id: row.id,
        robloxUserId: row.roblox_user_id,
        robloxUsername: row.roblox_username,
        robloxDisplayName: row.roblox_display_name,
        robloxProfileUrl: row.roblox_profile_url,
        contactDiscord: row.contact_discord,
        contactEmail: row.contact_email,
        gameUrl: row.game_url,
        goals: row.goals,
        status: row.status,
        paymentStatus: row.payment_status,
        stripeCheckoutSessionId: row.stripe_checkout_session_id,
        stripePaymentIntentId: row.stripe_payment_intent_id,
        stripeCustomerEmail: row.stripe_customer_email,
        amountTotal: row.amount_total,
        currency: row.currency,
        scheduledAt: row.scheduled_at ? row.scheduled_at.toISOString() : null,
        adminNotes: row.admin_notes,
        createdAt: row.created_at ? row.created_at.toISOString() : null,
        updatedAt: row.updated_at ? row.updated_at.toISOString() : null,
        paidAt: row.paid_at ? row.paid_at.toISOString() : null
    };
}

function validateBookingInput(body) {
    const contactDiscord = cleanText(body && body.contactDiscord, 80);
    const contactEmail = normalizeEmail(body && body.contactEmail);
    const gameUrl = cleanText(body && body.gameUrl, 500);
    const goals = cleanText(body && body.goals, 2000);

    if (!contactDiscord) {
        throw new Error('Discord username is required');
    }
    if (!gameUrl) {
        throw new Error('Roblox game link is required');
    }
    if (!/^https:\/\/(www\.)?roblox\.com\//i.test(gameUrl)) {
        throw new Error('Enter a valid roblox.com game link');
    }
    if (!goals) {
        throw new Error('Tell us what you want reviewed');
    }
    if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
        throw new Error('Enter a valid email address');
    }

    return {
        contactDiscord,
        contactEmail,
        gameUrl,
        goals
    };
}

async function createConsultationBooking({ user, body, amountTotal, currency }) {
    await ensureConsultationBookingsSchema();
    const input = validateBookingInput(body);
    const id = crypto.randomUUID();

    const result = await postgresQuery(`
        insert into consultation_bookings (
            id,
            roblox_user_id,
            roblox_username,
            roblox_display_name,
            roblox_profile_url,
            contact_discord,
            contact_email,
            game_url,
            goals,
            amount_total,
            currency
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        returning *
    `, [
        id,
        user.id,
        user.username,
        user.display_name || user.username,
        user.profile_url || null,
        input.contactDiscord,
        input.contactEmail,
        input.gameUrl,
        input.goals,
        amountTotal,
        currency
    ]);

    return normalizeBooking(result.rows[0]);
}

async function attachCheckoutSession({ bookingId, sessionId }) {
    await ensureConsultationBookingsSchema();
    const result = await postgresQuery(`
        update consultation_bookings
        set
            stripe_checkout_session_id = $2,
            updated_at = now()
        where id = $1
        returning *
    `, [bookingId, sessionId]);

    return normalizeBooking(result.rows[0]);
}

async function markCheckoutPaid({ sessionId, paymentIntentId, customerEmail, amountTotal, currency }) {
    await ensureConsultationBookingsSchema();
    const result = await postgresQuery(`
        update consultation_bookings
        set
            status = case when status = 'checkout_created' then 'new' else status end,
            payment_status = 'paid',
            stripe_payment_intent_id = coalesce($2, stripe_payment_intent_id),
            stripe_customer_email = coalesce($3, stripe_customer_email),
            amount_total = coalesce($4, amount_total),
            currency = coalesce($5, currency),
            paid_at = coalesce(paid_at, now()),
            updated_at = now()
        where stripe_checkout_session_id = $1
        returning *
    `, [
        sessionId,
        paymentIntentId || null,
        customerEmail || null,
        Number.isFinite(Number(amountTotal)) ? Math.trunc(Number(amountTotal)) : null,
        currency ? String(currency).toLowerCase() : null
    ]);

    return normalizeBooking(result.rows[0]);
}

async function markCheckoutExpired(sessionId) {
    await ensureConsultationBookingsSchema();
    const result = await postgresQuery(`
        update consultation_bookings
        set
            status = case when payment_status = 'paid' then status else 'cancelled' end,
            payment_status = case when payment_status = 'paid' then payment_status else 'expired' end,
            updated_at = now()
        where stripe_checkout_session_id = $1
        returning *
    `, [sessionId]);

    return normalizeBooking(result.rows[0]);
}

async function findBookingByCheckoutSession(sessionId) {
    await ensureConsultationBookingsSchema();
    const result = await postgresQuery(`
        select *
        from consultation_bookings
        where stripe_checkout_session_id = $1
        limit 1
    `, [sessionId]);

    return normalizeBooking(result.rows[0]);
}

async function listConsultationBookings() {
    await ensureConsultationBookingsSchema();
    const result = await postgresQuery(`
        select *
        from consultation_bookings
        order by created_at desc
        limit 200
    `);

    return result.rows.map(normalizeBooking);
}

async function updateConsultationBooking({ id, status, scheduledAt, adminNotes }) {
    await ensureConsultationBookingsSchema();

    const normalizedStatus = status ? cleanText(status, 40) : null;
    if (normalizedStatus && !BOOKING_STATUSES.has(normalizedStatus)) {
        throw new Error('Invalid booking status');
    }

    const normalizedScheduledAt = cleanText(scheduledAt, 80);
    const parsedScheduledAt = normalizedScheduledAt ? new Date(normalizedScheduledAt) : null;
    if (normalizedScheduledAt && Number.isNaN(parsedScheduledAt.getTime())) {
        throw new Error('Invalid scheduled time');
    }

    const result = await postgresQuery(`
        update consultation_bookings
        set
            status = coalesce($2, status),
            scheduled_at = $3,
            admin_notes = $4,
            updated_at = now()
        where id = $1
        returning *
    `, [
        id,
        normalizedStatus,
        parsedScheduledAt ? parsedScheduledAt.toISOString() : null,
        cleanText(adminNotes, 4000) || null
    ]);

    return normalizeBooking(result.rows[0]);
}

module.exports = {
    attachCheckoutSession,
    createConsultationBooking,
    ensureConsultationBookingsSchema,
    findBookingByCheckoutSession,
    listConsultationBookings,
    markCheckoutExpired,
    markCheckoutPaid,
    updateConsultationBooking
};
