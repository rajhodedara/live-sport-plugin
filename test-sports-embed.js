const { extractSportsEmbed } = require('./src/providers/SportsEmbedExtractor');

async function run() {
    try {
        const url = await extractSportsEmbed('https://sportsembed.su/embed/674e3cbe70a/dobey-c-crabtree-c/hd/1');
        console.log("Extracted URL:", url);
    } catch(e) {
        console.error("Error:", e);
    }
}
run();
