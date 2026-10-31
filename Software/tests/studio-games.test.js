const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const groupId = 5545660;
const manualUniverseId = 10767758871;

function game(id, visits, playing) {
    return {
        id,
        rootPlaceId: id === manualUniverseId ? 105108640103109 : id + 100,
        name: id === manualUniverseId ? 'Chew Rocks for Cash' : `Game ${id}`,
        visits,
        playing,
        creator: { id: groupId, type: 'Group' }
    };
}

function request(server, path) {
    return new Promise((resolve, reject) => {
        const req = http.get({
            hostname: '127.0.0.1',
            port: server.address().port,
            path,
            agent: false
        }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject);
    });
}

const scenarios = [
    {
        name: 'external manual game contributes visits and CCU below showcase display thresholds',
        groupIds: [11, 12],
        games: [
            game(11, 2000000, 800),
            game(12, 50000, 25),
            { ...game(manualUniverseId, 50000, 600), creator: { id: 390147260, type: 'Group' } }
        ],
        totalVisits: 2100000,
        totalPlaying: 1425,
        showcaseIds: [11, manualUniverseId],
        preview: '2.1M visits, 1.4K active players, and 1.9M community members.'
    },
    {
        name: 'manual game already in the group counts once and retains activity sorting',
        groupIds: [11, manualUniverseId, manualUniverseId],
        games: [game(11, 2000000, 3000), game(manualUniverseId, 500000, 2000)],
        totalVisits: 2500000,
        totalPlaying: 5000,
        showcaseIds: [11, manualUniverseId],
        preview: '2.5M visits, 5K active players, and 1.9M community members.'
    },
    {
        name: 'manual game still contributes when the group has no games',
        groupIds: [],
        games: [game(manualUniverseId, 50000, 600)],
        totalVisits: 50000,
        totalPlaying: 600,
        showcaseIds: [manualUniverseId],
        preview: '50K visits and 1.9M community members.'
    }
];

for (const scenario of scenarios) {
    test(scenario.name, async (t) => {
        const previousGroupId = process.env.ROBLOX_GROUP_ID;
        process.env.ROBLOX_GROUP_ID = String(groupId);
        t.after(() => {
            if (previousGroupId === undefined) delete process.env.ROBLOX_GROUP_ID;
            else process.env.ROBLOX_GROUP_ID = previousGroupId;
        });

        t.mock.method(global, 'fetch', async (endpoint) => {
            const url = new URL(endpoint);
            if (url.href === `https://groups.roblox.com/v1/groups/${groupId}`) {
                return new Response(JSON.stringify({ memberCount: 1900000 }));
            }
            if (url.origin === 'https://games.roblox.com' && url.pathname === `/v2/groups/${groupId}/games`) {
                return new Response(JSON.stringify({
                    data: scenario.groupIds.map(id => scenario.games.find(row => row.id === id))
                }));
            }
            assert.equal(url.origin + url.pathname, 'https://games.roblox.com/v1/games');
            const ids = url.searchParams.get('universeIds').split(',').map(Number);
            assert.equal(ids.filter(id => id === manualUniverseId).length, 1);
            assert.equal(ids.length, new Set(ids).size);
            return new Response(JSON.stringify({ data: ids.map(id => scenario.games.find(row => row.id === id)) }));
        });

        // Each scenario starts with empty server and showcase caches.
        delete require.cache[require.resolve('../server')];
        delete require.cache[require.resolve('../api/roblox/group-games')];
        const server = require('../server');
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));

        const statsResponse = await request(server, '/api/roblox/studio-stats');
        assert.equal(statsResponse.status, 200, statsResponse.body);
        const stats = JSON.parse(statsResponse.body);
        assert.equal(stats.totalVisits, scenario.totalVisits);
        assert.equal(stats.totalPlaying, scenario.totalPlaying);
        assert.equal(stats.memberCount, 1900000);
        assert.equal(stats.showActivePlayers, scenario.totalPlaying > 1000);

        const showcaseResponse = await request(server, '/api/roblox/group-games');
        assert.equal(showcaseResponse.status, 200, showcaseResponse.body);
        const showcase = JSON.parse(showcaseResponse.body).games;
        assert.deepEqual(showcase.map(row => row.universeId), scenario.showcaseIds);
        assert.equal(showcase.find(row => row.universeId === manualUniverseId).robloxUrl,
            'https://www.roblox.com/games/105108640103109');

        // The first homepage request refreshes the separate share-preview cache.
        await request(server, '/');
        const homepage = await request(server, '/');
        assert.equal(homepage.status, 200);
        const descriptions = [...homepage.body.matchAll(
            /<meta (?:name="description"|property="og:description"|name="twitter:description") content="([^"]*)"/g
        )].map(match => match[1]);
        assert.deepEqual(descriptions, [scenario.preview, scenario.preview, scenario.preview]);
    });
}
