const ROBLOX_OPEN_CLOUD_BASE_URL = 'https://apis.roblox.com';
const ROBLOX_THUMBNAILS_BASE_URL = 'https://thumbnails.roblox.com';
const ROBLOX_BADGES_BASE_URL = 'https://badges.roblox.com';
const ROBLOX_CONFIG_REPOSITORY_IN_EXPERIENCE = 'InExperienceConfig';
const ROBLOX_CONFIG_REPOSITORY_RECOMMENDATION_SERVICES = 'RecommendationServicesConfig';

function getRobloxOpenCloudApiKey() {
    const apiKey = String(process.env.ROBLOX_OPEN_CLOUD_API_KEY || '').trim();
    if (!apiKey) {
        throw new Error('ROBLOX_OPEN_CLOUD_API_KEY must be set');
    }

    return apiKey;
}

function parseUniverseId(value, fieldName) {
    const parsed = Number.parseInt(String(value || '').trim(), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`${fieldName} must be a positive integer`);
    }

    return parsed;
}

function parseTargetUniverseIds(rawList) {
    const list = Array.isArray(rawList) ? rawList : [];
    const seen = new Set();
    const parsed = [];

    for (const value of list) {
        const id = parseUniverseId(value, 'targetUniverseIds[]');
        if (seen.has(id)) {
            continue;
        }
        seen.add(id);
        parsed.push(id);
    }

    return parsed;
}

function parseConfigRepository(value, fieldName) {
    const raw = String(value || '').trim();
    if (!raw) {
        return ROBLOX_CONFIG_REPOSITORY_IN_EXPERIENCE;
    }

    const normalized = raw.toLowerCase();
    if (normalized === ROBLOX_CONFIG_REPOSITORY_IN_EXPERIENCE.toLowerCase()) {
        return ROBLOX_CONFIG_REPOSITORY_IN_EXPERIENCE;
    }
    if (normalized === ROBLOX_CONFIG_REPOSITORY_RECOMMENDATION_SERVICES.toLowerCase()) {
        return ROBLOX_CONFIG_REPOSITORY_RECOMMENDATION_SERVICES;
    }

    throw new Error(`${fieldName} must be InExperienceConfig or RecommendationServicesConfig`);
}

function normalizeConfigEntries(entries, fieldName) {
    if (entries === null || entries === undefined) {
        return {};
    }
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
        throw new Error(`${fieldName} must be an object`);
    }

    return JSON.parse(JSON.stringify(entries));
}

async function parseJsonSafely(response) {
    try {
        return await response.json();
    } catch (error) {
        return null;
    }
}

function extractApiErrorMessage(data, fallback) {
    if (!data || typeof data !== 'object') {
        return fallback;
    }

    const directDetail = [
        data.errorMessage,
        data.error,
        data.message,
        data.detail,
        data.title
    ].find((value) => typeof value === 'string' && value.trim());

    if (directDetail) {
        return directDetail.trim();
    }

    const errorArrays = [data.errors, data.errorDetails, data.details];
    for (const errors of errorArrays) {
        if (!Array.isArray(errors)) {
            continue;
        }

        for (const item of errors) {
            if (typeof item === 'string' && item.trim()) {
                return item.trim();
            }

            if (!item || typeof item !== 'object') {
                continue;
            }

            const code = item.code !== undefined && item.code !== null
                ? String(item.code).trim()
                : '';
            const message = [
                item.userFacingMessage,
                item.message,
                item.errorMessage,
                item.detail,
                item.title
            ].find((value) => typeof value === 'string' && value.trim());

            if (message && code) {
                return `Error ${code}: ${message.trim()}`;
            }
            if (message) {
                return message.trim();
            }
            if (code) {
                return `Error ${code}`;
            }
        }
    }

    return fallback;
}

function asPriceValue(config) {
    const price = Number(config && config.priceInformation && config.priceInformation.defaultPriceInRobux);
    if (!Number.isFinite(price) || price <= 0) {
        return null;
    }

    return Math.round(price);
}

function isRegionalPricingEnabled(config) {
    const features = config && config.priceInformation && Array.isArray(config.priceInformation.enabledFeatures)
        ? config.priceInformation.enabledFeatures
        : [];

    return features.includes('RegionalPricing');
}

function toBooleanString(value) {
    return value ? 'true' : 'false';
}

async function robloxOpenCloudRequest({ method, path, query, body, headers: extraHeaders }) {
    const url = new URL(`${ROBLOX_OPEN_CLOUD_BASE_URL}${path}`);
    if (query && typeof query === 'object') {
        for (const [key, value] of Object.entries(query)) {
            if (value === undefined || value === null || value === '') {
                continue;
            }
            url.searchParams.set(key, String(value));
        }
    }

    const headers = {
        'x-api-key': getRobloxOpenCloudApiKey()
    };
    if (extraHeaders && typeof extraHeaders === 'object') {
        for (const [key, value] of Object.entries(extraHeaders)) {
            if (value === undefined || value === null || value === '') {
                continue;
            }
            headers[key] = value;
        }
    }

    const options = {
        method,
        headers
    };

    if (body) {
        options.body = body;
    }

    const response = await fetch(url, options);
    const data = await parseJsonSafely(response);

    if (!response.ok) {
        const fallback = `Roblox Open Cloud request failed (${response.status})`;
        throw new Error(extractApiErrorMessage(data, fallback));
    }

    return data;
}

async function robloxPublicRequest({ baseUrl, method, path, query, body, headers }) {
    const url = new URL(`${baseUrl}${path}`);
    if (query && typeof query === 'object') {
        for (const [key, value] of Object.entries(query)) {
            if (value === undefined || value === null || value === '') {
                continue;
            }
            url.searchParams.set(key, String(value));
        }
    }

    const options = {
        method,
        headers: headers && typeof headers === 'object' ? headers : {}
    };

    if (body) {
        options.body = body;
    }

    const response = await fetch(url, options);
    const data = await parseJsonSafely(response);

    if (!response.ok) {
        const fallback = `Roblox request failed (${response.status})`;
        throw new Error(extractApiErrorMessage(data, fallback));
    }

    return data;
}

async function listAllGamePassConfigs(universeId) {
    const results = [];
    let pageToken = '';

    do {
        const payload = await robloxOpenCloudRequest({
            method: 'GET',
            path: `/game-passes/v1/universes/${universeId}/game-passes/creator`,
            query: {
                pageSize: 100,
                pageToken: pageToken || undefined
            }
        });

        const rows = Array.isArray(payload && payload.gamePasses) ? payload.gamePasses : [];
        results.push(...rows);
        pageToken = payload && payload.nextPageToken ? String(payload.nextPageToken) : '';
    } while (pageToken);

    return results;
}

async function listAllDeveloperProductConfigs(universeId) {
    const results = [];
    let pageToken = '';

    do {
        const payload = await robloxOpenCloudRequest({
            method: 'GET',
            path: `/developer-products/v2/universes/${universeId}/developer-products/creator`,
            query: {
                pageSize: 100,
                pageToken: pageToken || undefined
            }
        });

        const rows = Array.isArray(payload && payload.developerProducts) ? payload.developerProducts : [];
        results.push(...rows);
        pageToken = payload && payload.nextPageToken ? String(payload.nextPageToken) : '';
    } while (pageToken);

    return results;
}

async function listAllBadges(universeId) {
    const results = [];
    let cursor = '';

    do {
        const payload = await robloxPublicRequest({
            baseUrl: ROBLOX_BADGES_BASE_URL,
            method: 'GET',
            path: `/v1/universes/${universeId}/badges`,
            query: {
                limit: 100,
                sortOrder: 'Asc',
                cursor: cursor || undefined
            }
        });

        const rows = Array.isArray(payload && payload.data) ? payload.data : [];
        results.push(...rows);
        cursor = payload && payload.nextPageCursor ? String(payload.nextPageCursor) : '';
    } while (cursor);

    return results;
}

let cachedBadgeMetadata = null;
let cachedBadgeMetadataAt = 0;
const BADGE_METADATA_TTL_MS = 5 * 60 * 1000;

async function getBadgeMetadata() {
    const now = Date.now();
    if (cachedBadgeMetadata && (now - cachedBadgeMetadataAt) < BADGE_METADATA_TTL_MS) {
        return cachedBadgeMetadata;
    }

    const payload = await robloxPublicRequest({
        baseUrl: ROBLOX_BADGES_BASE_URL,
        method: 'GET',
        path: '/v1/badges/metadata'
    });

    cachedBadgeMetadata = payload || null;
    cachedBadgeMetadataAt = now;
    return cachedBadgeMetadata;
}

async function getUniverseFreeBadgesQuota(universeId) {
    const payload = await robloxPublicRequest({
        baseUrl: ROBLOX_BADGES_BASE_URL,
        method: 'GET',
        path: `/v1/universes/${universeId}/free-badges-quota`
    });

    const quota = Number(payload);
    if (!Number.isFinite(quota) || quota < 0) {
        return null;
    }

    return Math.floor(quota);
}

async function getThumbnailUrlMap({ endpointPath, idParamName, ids, size }) {
    const map = new Map();
    const cleanIds = Array.isArray(ids) ? ids.filter((id) => Number.isFinite(Number(id))) : [];
    if (cleanIds.length === 0) {
        return map;
    }

    const chunkSize = 50;
    for (let start = 0; start < cleanIds.length; start += chunkSize) {
        const chunk = cleanIds.slice(start, start + chunkSize);
        const url = new URL(`${ROBLOX_THUMBNAILS_BASE_URL}${endpointPath}`);
        url.searchParams.set(idParamName, chunk.join(','));
        url.searchParams.set('size', size);
        url.searchParams.set('format', 'Png');
        url.searchParams.set('isCircular', 'false');

        const response = await fetch(url, { method: 'GET' });
        const payload = await parseJsonSafely(response);
        if (!response.ok) {
            continue;
        }

        const rows = Array.isArray(payload && payload.data) ? payload.data : [];
        for (const row of rows) {
            const targetId = Number(row && row.targetId);
            const imageUrl = row && typeof row.imageUrl === 'string' ? row.imageUrl.trim() : '';
            if (!Number.isFinite(targetId) || !imageUrl) {
                continue;
            }
            map.set(targetId, imageUrl);
        }
    }

    return map;
}

async function getGamePassThumbnailUrlMap(gamePassIds) {
    return getThumbnailUrlMap({
        endpointPath: '/v1/game-passes',
        idParamName: 'gamePassIds',
        ids: gamePassIds,
        size: '150x150'
    });
}

async function getDeveloperProductThumbnailUrlMap(productIds) {
    return getThumbnailUrlMap({
        endpointPath: '/v1/developer-products/icons',
        idParamName: 'developerProductIds',
        ids: productIds,
        size: '420x420'
    });
}

async function getBadgeThumbnailUrlMap(badgeIds) {
    return getThumbnailUrlMap({
        endpointPath: '/v1/badges/icons',
        idParamName: 'badgeIds',
        ids: badgeIds,
        size: '150x150'
    });
}

async function getAssetThumbnailUrlMap(assetIds, size) {
    return getThumbnailUrlMap({
        endpointPath: '/v1/assets',
        idParamName: 'assetIds',
        ids: assetIds,
        size: size || '420x420'
    });
}

async function downloadImageBuffer(url) {
    const response = await fetch(url, { method: 'GET' });
    if (!response.ok) {
        throw new Error(`Image download failed (${response.status})`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
}

function addMonetizationFormFields(formData, sourceConfig, imageBuffer, options) {
    const config = sourceConfig || {};
    const settings = options || {};

    const includeName = settings.includeName !== false;
    const requireName = settings.requireName !== false;
    const includeDescription = settings.includeDescription !== false;

    const nameSource = settings.nameOverride !== undefined ? settings.nameOverride : config.name;
    const name = String(nameSource || '').trim();
    if (includeName) {
        if (!name && requireName) {
            throw new Error('Source item is missing a name');
        }
        if (name) {
            formData.append('name', name);
        }
    }

    if (includeDescription && typeof config.description === 'string') {
        formData.append('description', config.description);
    }

    const resolvedForSale = typeof settings.forceForSale === 'boolean'
        ? settings.forceForSale
        : Boolean(config.isForSale);
    formData.append('isForSale', toBooleanString(resolvedForSale));

    const forcedPrice = Number(settings.fixedPrice);
    const priceValue = Number.isFinite(forcedPrice)
        ? Math.max(0, Math.round(forcedPrice))
        : asPriceValue(config);
    if (priceValue !== null) {
        formData.append('price', String(priceValue));
    }

    const resolvedRegionalPricing = typeof settings.forceRegionalPricingEnabled === 'boolean'
        ? settings.forceRegionalPricingEnabled
        : isRegionalPricingEnabled(config);
    formData.append('isRegionalPricingEnabled', toBooleanString(resolvedRegionalPricing));

    if (imageBuffer && imageBuffer.length > 0) {
        const imageFieldName = String(settings.imageFieldName || 'imageFile');
        formData.append(imageFieldName, new Blob([imageBuffer], { type: 'image/png' }), 'icon.png');
    }
}

async function createGamePass(universeId, sourceConfig, imageBuffer, options) {
    const formData = new FormData();
    addMonetizationFormFields(formData, sourceConfig, imageBuffer, {
        imageFieldName: 'imageFile',
        requireName: true,
        ...(options || {})
    });

    const payload = await robloxOpenCloudRequest({
        method: 'POST',
        path: `/game-passes/v1/universes/${universeId}/game-passes`,
        body: formData
    });

    return payload || null;
}

async function updateGamePass(universeId, gamePassId, sourceConfig, imageBuffer, options) {
    const formData = new FormData();
    addMonetizationFormFields(formData, sourceConfig, imageBuffer, {
        imageFieldName: 'file',
        requireName: false,
        ...(options || {})
    });

    await robloxOpenCloudRequest({
        method: 'PATCH',
        path: `/game-passes/v1/universes/${universeId}/game-passes/${gamePassId}`,
        body: formData
    });
}

async function createDeveloperProduct(universeId, sourceConfig, imageBuffer, options) {
    const formData = new FormData();
    addMonetizationFormFields(formData, sourceConfig, imageBuffer, {
        imageFieldName: 'imageFile',
        requireName: true,
        ...(options || {})
    });

    const payload = await robloxOpenCloudRequest({
        method: 'POST',
        path: `/developer-products/v2/universes/${universeId}/developer-products`,
        body: formData
    });

    return payload || null;
}

async function updateDeveloperProduct(universeId, productId, sourceConfig, imageBuffer, options) {
    const formData = new FormData();
    addMonetizationFormFields(formData, sourceConfig, imageBuffer, {
        imageFieldName: 'imageFile',
        requireName: false,
        ...(options || {})
    });

    await robloxOpenCloudRequest({
        method: 'PATCH',
        path: `/developer-products/v2/universes/${universeId}/developer-products/${productId}`,
        body: formData
    });
}

function addBadgeCreateFormFields(formData, sourceBadge, imageBuffer, options) {
    const config = sourceBadge || {};
    const settings = options || {};
    const nameSource = settings.nameOverride !== undefined ? settings.nameOverride : config.name;
    const name = String(nameSource || '').trim();
    if (!name) {
        throw new Error('Source badge is missing a name');
    }

    formData.append('name', name);

    if (typeof config.description === 'string') {
        formData.append('description', config.description);
    }

    const enabled = typeof settings.forceEnabled === 'boolean'
        ? settings.forceEnabled
        : Boolean(config.enabled);
    formData.append('isActive', toBooleanString(enabled));

    const paymentSourceType = Number.isFinite(Number(settings.paymentSourceType))
        ? Math.round(Number(settings.paymentSourceType))
        : 1;
    const expectedCost = Number(settings.expectedCost);
    formData.append('paymentSourceType', String(paymentSourceType));
    if (Number.isFinite(expectedCost) && expectedCost >= 0) {
        formData.append('expectedCost', String(Math.round(expectedCost)));
    }

    if (imageBuffer && imageBuffer.length > 0) {
        formData.append('files', new Blob([imageBuffer], { type: 'image/png' }), 'icon.png');
    }
}

async function createBadge(universeId, sourceBadge, imageBuffer, options) {
    const settings = options || {};
    const metadata = await getBadgeMetadata().catch(() => null);
    const freeBadgeQuota = await getUniverseFreeBadgesQuota(universeId).catch(() => null);

    const paymentSourceCandidates = [];
    if (Number.isFinite(Number(settings.paymentSourceType))) {
        paymentSourceCandidates.push(Math.round(Number(settings.paymentSourceType)));
    } else {
        paymentSourceCandidates.push(1, 2);
    }

    const expectedCostCandidates = [];
    const settingsExpectedCost = Number(settings.expectedCost);
    const metadataExpectedCost = Number(metadata && metadata.badgeCreationPrice);
    if (Number.isFinite(settingsExpectedCost) && settingsExpectedCost >= 0) {
        expectedCostCandidates.push(Math.round(settingsExpectedCost));
    }
    if (Number.isFinite(freeBadgeQuota) && freeBadgeQuota > 0) {
        expectedCostCandidates.push(0);
    }
    if (Number.isFinite(metadataExpectedCost) && metadataExpectedCost >= 0) {
        expectedCostCandidates.push(Math.round(metadataExpectedCost));
    }

    const uniquePaymentCandidates = [...new Set(paymentSourceCandidates)];
    const uniqueExpectedCostCandidates = [...new Set(expectedCostCandidates)];
    if (uniqueExpectedCostCandidates.length === 0) {
        uniqueExpectedCostCandidates.push(undefined);
    }

    const attemptCreate = async (paymentSourceType, expectedCost) => {
        const formData = new FormData();
        addBadgeCreateFormFields(formData, sourceBadge, imageBuffer, {
            ...settings,
            paymentSourceType,
            expectedCost
        });

        return robloxOpenCloudRequest({
            method: 'POST',
            path: `/legacy-badges/v1/universes/${universeId}/badges`,
            body: formData
        });
    };

    let lastPaymentError = null;
    for (const paymentSourceType of uniquePaymentCandidates) {
        for (const expectedCost of uniqueExpectedCostCandidates) {
            try {
                const payload = await attemptCreate(paymentSourceType, expectedCost);
                return payload || null;
            } catch (error) {
                const message = String(error && error.message ? error.message : '').toLowerCase();
                const likelyPaymentProblem = message.includes('payment')
                    || message.includes('expected')
                    || message.includes('cost')
                    || message.includes('insufficient funds')
                    || message.includes('error 16')
                    || message.includes('error 17')
                    || message.includes('error 18');

                if (!likelyPaymentProblem) {
                    throw error;
                }

                lastPaymentError = error;
            }
        }
    }

    if (lastPaymentError) {
        throw lastPaymentError;
    }

    throw new Error('Badge creation failed');
}

async function updateBadge(badgeId, sourceBadge, options) {
    const config = sourceBadge || {};
    const settings = options || {};
    const nameSource = settings.nameOverride !== undefined ? settings.nameOverride : config.name;
    const name = String(nameSource || '').trim();
    if (!name) {
        throw new Error('Badge name is required');
    }

    const body = {
        name,
        description: typeof config.description === 'string' ? config.description : '',
        enabled: typeof settings.forceEnabled === 'boolean'
            ? settings.forceEnabled
            : Boolean(config.enabled)
    };

    await robloxOpenCloudRequest({
        method: 'PATCH',
        path: `/legacy-badges/v1/badges/${badgeId}`,
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });
}

async function updateBadgeIcon(badgeId, imageBuffer) {
    if (!imageBuffer || imageBuffer.length === 0) {
        throw new Error('Badge icon image is required');
    }

    const formData = new FormData();
    formData.append('Files', new Blob([imageBuffer], { type: 'image/png' }), 'icon.png');

    await robloxOpenCloudRequest({
        method: 'POST',
        path: `/legacy-publish/v1/badges/${badgeId}/icon`,
        body: formData
    });
}

function parsePlaceIdFromResourcePath(placePath) {
    const value = String(placePath || '').trim();
    if (!value) {
        throw new Error('Missing root place path');
    }

    const match = value.match(/^universes\/\d+\/places\/(\d+)$/);
    if (!match) {
        throw new Error('Invalid root place path format');
    }

    const placeId = Number.parseInt(match[1], 10);
    if (!Number.isFinite(placeId) || placeId <= 0) {
        throw new Error('Invalid root place ID');
    }

    return placeId;
}

async function getUniverse(universeId) {
    return robloxOpenCloudRequest({
        method: 'GET',
        path: `/cloud/v2/universes/${universeId}`
    });
}

async function getPlace(universeId, placeId) {
    return robloxOpenCloudRequest({
        method: 'GET',
        path: `/cloud/v2/universes/${universeId}/places/${placeId}`
    });
}

async function updatePlaceDescription(universeId, placeId, description) {
    await robloxOpenCloudRequest({
        method: 'PATCH',
        path: `/cloud/v2/universes/${universeId}/places/${placeId}`,
        query: {
            updateMask: 'description'
        },
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            description: String(description || '')
        })
    });
}

async function getUniverseRootPlaceInfo(universeId) {
    const universe = await getUniverse(universeId);
    const placePath = universe && universe.rootPlace ? String(universe.rootPlace).trim() : '';
    const placeId = parsePlaceIdFromResourcePath(placePath);
    return {
        universe,
        placeId,
        placePath
    };
}

async function getUniverseDescription(universeId) {
    const rootPlace = await getUniverseRootPlaceInfo(universeId);
    const place = await getPlace(universeId, rootPlace.placeId);
    return {
        placeId: rootPlace.placeId,
        description: place && typeof place.description === 'string'
            ? place.description
            : ''
    };
}

async function updateUniverseDescription(universeId, description) {
    const rootPlace = await getUniverseRootPlaceInfo(universeId);
    await updatePlaceDescription(universeId, rootPlace.placeId, description);
    return {
        placeId: rootPlace.placeId
    };
}

async function getConfigRepositoryValues(universeId, repository) {
    const parsedRepository = parseConfigRepository(repository, 'repository');
    return robloxOpenCloudRequest({
        method: 'GET',
        path: `/creator-configs-public-api/v1/configs/universes/${universeId}/repositories/${parsedRepository}`
    });
}

async function getConfigRepositoryFull(universeId, repository) {
    const parsedRepository = parseConfigRepository(repository, 'repository');
    return robloxOpenCloudRequest({
        method: 'GET',
        path: `/creator-configs-public-api/v1/configs/universes/${universeId}/repositories/${parsedRepository}/full`
    });
}

async function overwriteConfigRepositoryDraft(universeId, repository, entries, draftHash) {
    const parsedRepository = parseConfigRepository(repository, 'repository');
    const body = {
        entries: normalizeConfigEntries(entries, 'entries')
    };
    if (typeof draftHash === 'string' && draftHash.trim()) {
        body.draftHash = draftHash.trim();
    }

    return robloxOpenCloudRequest({
        method: 'PUT',
        path: `/creator-configs-public-api/v1/configs/universes/${universeId}/repositories/${parsedRepository}/draft:overwrite`,
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });
}

async function publishConfigRepositoryDraft(universeId, repository, draftHash, options) {
    const parsedRepository = parseConfigRepository(repository, 'repository');
    const settings = options || {};
    const body = {
        draftHash: String(draftHash || '').trim(),
        deploymentStrategy: String(settings.deploymentStrategy || 'Immediate').trim() || 'Immediate'
    };

    if (!body.draftHash) {
        throw new Error('draftHash is required to publish config changes');
    }

    const message = String(settings.message || '').trim();
    if (message) {
        body.message = message;
    }

    return robloxOpenCloudRequest({
        method: 'POST',
        path: `/creator-configs-public-api/v1/configs/universes/${universeId}/repositories/${parsedRepository}/publish`,
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
    parseUniverseId,
    parseTargetUniverseIds,
    listAllGamePassConfigs,
    listAllDeveloperProductConfigs,
    listAllBadges,
    getGamePassThumbnailUrlMap,
    getDeveloperProductThumbnailUrlMap,
    getBadgeThumbnailUrlMap,
    getAssetThumbnailUrlMap,
    downloadImageBuffer,
    createGamePass,
    updateGamePass,
    createDeveloperProduct,
    updateDeveloperProduct,
    createBadge,
    updateBadge,
    updateBadgeIcon,
    getUniverse,
    getPlace,
    updatePlaceDescription,
    getUniverseRootPlaceInfo,
    getUniverseDescription,
    updateUniverseDescription,
    parseConfigRepository,
    getConfigRepositoryValues,
    getConfigRepositoryFull,
    overwriteConfigRepositoryDraft,
    publishConfigRepositoryDraft,
    sleep
};
