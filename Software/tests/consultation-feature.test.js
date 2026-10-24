const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const server = require('../server');

function request(path, method = 'GET') {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1',
            port: server.address().port,
            path,
            method
        }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        });
        req.on('error', reject);
        req.end();
    });
}

test('consultations are fully disabled by default and one flag restores the preserved feature', async (t) => {
    const previousSetting = process.env.CONSULTATIONS_ENABLED;
    t.after(() => {
        if (previousSetting === undefined) {
            delete process.env.CONSULTATIONS_ENABLED;
        } else {
            process.env.CONSULTATIONS_ENABLED = previousSetting;
        }
    });
    // All checks use local HTTP; Roblox statistics must not require network access.
    t.mock.method(global, 'fetch', async () => { throw new Error('External requests disabled in tests'); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

    await t.test('default hides links and admin tool, blocks booking APIs, and redirects page aliases', async () => {
        delete process.env.CONSULTATIONS_ENABLED;
        for (const path of ['/', '/index.html', '/%69ndex.html', '/admin', '/terms']) {
            const response = await request(path);
            assert.equal(response.status, 200, path);
            assert.doesNotMatch(response.body, /href="\/(?:admin\/)?consultation/);
            assert.doesNotMatch(response.body, /data-consultation-price/);
            assert.equal(Number(response.headers['content-length']), Buffer.byteLength(response.body));
        }

        for (const [path, location] of [
            ['/consultation', '/'],
            ['/consultation?offer=friend50', '/'],
            ['/consultation/thanks?session_id=old-session', '/'],
            ['/admin/consultations', '/admin'],
            ['/%63onsultation.html', '/'],
            ['/%63onsultation-thanks.html', '/'],
            ['/%61dmin-consultations.html', '/admin']
        ]) {
            const response = await request(path);
            assert.equal(response.status, 302, path);
            assert.equal(response.headers.location, location, path);
            assert.equal(response.headers['cache-control'], 'no-store');
            assert.doesNotMatch(response.body, /consultation-checkout-form/);
        }

        for (const [alias, canonical] of [
            ['/consultation.html', '/consultation'],
            ['/consultation-thanks.html', '/consultation/thanks'],
            ['/admin-consultations.html', '/admin/consultations'],
            ['/consultation/', '/consultation']
        ]) {
            const response = await request(alias);
            assert.equal(response.status, 301, alias);
            assert.equal(response.headers.location, canonical, alias);
            assert.equal((await request(canonical)).status, 302);
        }

        for (const [path, method] of [
            ['/api/consultations/config', 'GET'],
            ['/api/consultations/checkout', 'POST'],
            ['/api/consultations/confirm', 'POST'],
            ['/api/admin/consultations', 'GET'],
            ['/api/admin/consultations', 'PATCH']
        ]) {
            const response = await request(path, method);
            assert.equal(response.status, 503, `${method} ${path}`);
            assert.equal(JSON.parse(response.body).error, 'Consultations are currently unavailable');
            assert.equal(response.headers['cache-control'], 'no-store');
        }

        process.env.CONSULTATIONS_ENABLED = 'false';
        assert.equal((await request('/api/consultations/checkout', 'POST')).status, 503);
        // Existing payment webhooks retain their original method/authentication handling.
        assert.equal((await request('/api/consultations/webhook')).status, 405);
        assert.equal((await request('/api/health')).status, 200);
    });

    await t.test('enabling restores the original pages, navigation and authenticated APIs', async () => {
        process.env.CONSULTATIONS_ENABLED = 'true';
        const homepage = await request('/');
        assert.equal(homepage.status, 200);
        assert.match(homepage.body, /href="\/consultation"/);
        assert.match(homepage.body, /Book \$300 Consultation/);
        assert.match((await request('/admin')).body, /href="\/admin\/consultations"/);
        assert.match((await request('/terms')).body, /href="\/consultation"/);

        for (const path of ['/consultation', '/%63onsultation.html']) {
            const response = await request(path);
            assert.equal(response.status, 200, path);
            assert.match(response.body, /id="consultation-checkout-form"/);
        }
        assert.equal((await request('/consultation/thanks')).status, 200);
        assert.equal((await request('/admin/consultations')).status, 200);
        assert.equal((await request('/api/consultations/config')).status, 200);
        assert.equal((await request('/api/consultations/checkout', 'POST')).status, 401);
        assert.equal((await request('/api/consultations/confirm', 'POST')).status, 401);
        assert.equal((await request('/api/admin/consultations')).status, 401);
    });
});
