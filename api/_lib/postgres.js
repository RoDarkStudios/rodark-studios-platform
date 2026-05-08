let pool;

function getDatabaseUrl() {
    return String(process.env.DATABASE_URL || process.env.POSTGRES_URL || '').trim();
}

function getPostgresPool() {
    if (pool) {
        return pool;
    }

    const connectionString = getDatabaseUrl();
    if (!connectionString) {
        throw new Error('DATABASE_URL must be set');
    }

    const { Pool } = require('pg');
    pool = new Pool({
        connectionString,
        connectionTimeoutMillis: 5000,
        query_timeout: 10000,
        statement_timeout: 10000,
        ssl: connectionString.includes('localhost') || connectionString.includes('127.0.0.1')
            ? false
            : { rejectUnauthorized: false }
    });

    return pool;
}

async function postgresQuery(text, params) {
    const postgresPool = getPostgresPool();
    return postgresPool.query(text, params);
}

module.exports = {
    getPostgresPool,
    postgresQuery
};
