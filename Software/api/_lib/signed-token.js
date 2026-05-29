const crypto = require('crypto');
const { toBase64Url, fromBase64Url } = require('./base64url');

function signPayload(encodedPayload, secret) {
    return toBase64Url(
        crypto.createHmac('sha256', secret).update(encodedPayload).digest()
    );
}

function issueSignedToken(payload, secret, ttlSeconds) {
    const now = Math.floor(Date.now() / 1000);
    const safeTtl = Math.max(1, Number(ttlSeconds) || 1);
    const tokenPayload = {
        ...payload,
        iat: now,
        exp: now + safeTtl
    };

    const encodedPayload = toBase64Url(JSON.stringify(tokenPayload));
    const signature = signPayload(encodedPayload, secret);

    return `${encodedPayload}.${signature}`;
}

function verifySignedToken(token, secret) {
    if (!token || typeof token !== 'string' || !token.includes('.')) {
        return null;
    }

    const [encodedPayload, encodedSig] = token.split('.');
    if (!encodedPayload || !encodedSig) {
        return null;
    }

    const expectedSig = signPayload(encodedPayload, secret);
    const actualSig = Buffer.from(encodedSig);
    const expectedSigBuffer = Buffer.from(expectedSig);

    if (actualSig.length !== expectedSigBuffer.length) {
        return null;
    }

    if (!crypto.timingSafeEqual(actualSig, expectedSigBuffer)) {
        return null;
    }

    let payload;
    try {
        payload = JSON.parse(fromBase64Url(encodedPayload).toString('utf8'));
    } catch (error) {
        return null;
    }

    if (!payload || typeof payload !== 'object') {
        return null;
    }

    const now = Math.floor(Date.now() / 1000);
    if (!payload.exp || now > payload.exp) {
        return null;
    }

    return payload;
}

module.exports = {
    issueSignedToken,
    verifySignedToken
};
