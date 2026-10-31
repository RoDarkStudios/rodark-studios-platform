// Games included in both the showcase and studio totals alongside group-owned games.
// Chew Rocks for Cash: https://www.roblox.com/games/105108640103109
const ADDITIONAL_STUDIO_UNIVERSE_IDS = [10767758871];

function includeAdditionalStudioGames(universeIds) {
    return [...new Set([...universeIds, ...ADDITIONAL_STUDIO_UNIVERSE_IDS])];
}

module.exports = {
    ADDITIONAL_STUDIO_UNIVERSE_IDS,
    includeAdditionalStudioGames
};
