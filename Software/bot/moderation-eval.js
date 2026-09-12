// Explicit evaluation command: calls OpenAI on synthetic examples, never connects to Discord.
const cases = require('./moderation-eval-cases.json');
const { MODEL, buildReviewInput, reviewConversation } = require('./moderation-policy');

async function main() {
    const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
    if (!apiKey) throw new Error('Set OPENAI_API_KEY to evaluate Luna/high. This command makes paid API calls but cannot moderate Discord.');
    let failures = 0, inputTokens = 0, outputTokens = 0;
    for (const sample of cases) {
        let sequence = 0;
        const messages = (pairs) => (pairs || []).map(([author, content]) => ({
            id: String(100000000000000000n + BigInt(++sequence)), user_id: author,
            guild_id: 'evaluation', channel_id: 'evaluation', author, content,
            timestamp: new Date(Date.UTC(2026, 8, 12, 12, 0, sequence)).toISOString(), reply_to: null, attachment_count: 0, sticker_count: 0
        }));
        const context = messages(sample.context);
        const batch = messages(sample.messages);
        try {
            const result = await reviewConversation(buildReviewInput(batch, context), { apiKey, signal: AbortSignal.timeout(55_000) });
            inputTokens += result.usage.input_tokens || 0; outputTokens += result.usage.output_tokens || 0;
            const actual = new Map(result.cases.map((entry) => [entry.user_id, entry]));
            const issues = [];
            for (const expected of sample.expected) {
                const entry = actual.get(expected.user);
                if (!entry) issues.push(`missed ${expected.user}`);
                else {
                    if (expected.punishment && (entry.action === 'review' || entry.confidence !== 'high')) issues.push(`no clear violation for ${expected.user}`);
                    if (expected.banReview && entry.action !== 'timeout_and_review') issues.push(`missed ban review for ${expected.user}`);
                }
            }
            for (const entry of result.cases) {
                if (!sample.expected.some((expected) => expected.user === entry.user_id)) issues.push(`unexpected case for ${entry.user_id}`);
                if (sample.neverPunish?.includes(entry.user_id) && entry.action !== 'review') issues.push(`punished protected example ${entry.user_id}`);
            }
            if (issues.length) { failures++; console.log(`FAIL ${sample.name}: ${issues.join('; ')}\n${JSON.stringify(result.cases)}`); }
            else console.log(`PASS ${sample.name}`);
        } catch (error) {
            inputTokens += error.usage?.input_tokens || 0; outputTokens += error.usage?.output_tokens || 0;
            failures++; console.log(`ERROR ${sample.name}: ${error.message}`);
        }
    }
    console.log(JSON.stringify({ model: MODEL, reasoning: 'high', examples: cases.length, failures, inputTokens, outputTokens }));
    if (failures) process.exitCode = 1;
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
