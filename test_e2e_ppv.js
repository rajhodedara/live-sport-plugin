const PpvStProvider = require('./src/providers/PpvStProvider');
const EmbedIndiaProvider = require('./src/providers/EmbedIndiaProvider');

async function test() {
    try {
        console.log("Instantiating PpvStProvider and EmbedIndiaProvider...");
        const ppvProvider = new PpvStProvider();
        const embedProvider = new EmbedIndiaProvider({});
        
        console.log("Fetching active streams from ppv.st...");
        const matches = await ppvProvider.getMatches();
        
        // Extract all embedindia sources
        const streams = [];
        for (const match of matches) {
            for (const source of match.sources) {
                if (source.embedUrl && source.embedUrl.includes('embedindia.st')) {
                    streams.push({ name: match.title, iframe: source.embedUrl });
                }
            }
        }
        
        console.log(`Found ${streams.length} active streams.`);
        
        let allSuccess = true;
        for (let i = 0; i < streams.length; i++) {
            const stream = streams[i];
            console.log(`\nTesting stream ${i+1}/${streams.length}: ${stream.name}`);
            console.log(`Iframe URL: ${stream.iframe}`);
            
            try {
                // Testing resolveStream instead of manually calling extractIndia
                const resolvedStreamsPpv = await ppvProvider.resolveStream('ppvst', stream.name, stream.name, { embedUrl: stream.iframe });
                const resolvedStreamsEmbed = await embedProvider.resolveStream('embedindia', stream.name, stream.name, { embedUrl: stream.iframe });
                
                let foundM3u8Ppv = false;
                for (const resStream of resolvedStreamsPpv) {
                    if (resStream.url && resStream.url.includes('.m3u8')) {
                        console.log("SUCCESS (PpvSt)! Got m3u8:");
                        console.log(resStream.url);
                        foundM3u8Ppv = true;
                        break;
                    }
                }
                
                let foundM3u8Embed = false;
                for (const resStream of resolvedStreamsEmbed) {
                    if (resStream.url && resStream.url.includes('.m3u8')) {
                        console.log("SUCCESS (EmbedIndia)! Got m3u8:");
                        console.log(resStream.url);
                        foundM3u8Embed = true;
                        break;
                    }
                }

                if (!foundM3u8Ppv || !foundM3u8Embed) {
                     console.error("FAILED TO EXTRACT: Missing M3U8 in one or both providers.");
                     allSuccess = false;
                }
            } catch (err) {
                console.error("FAILED TO EXTRACT:", err.message);
                allSuccess = false;
            }
        }
        
        if (allSuccess && streams.length > 0) {
            console.log("\nALL STREAMS SUCCESSFUL");
        } else {
            console.log("\nSOME STREAMS FAILED OR NO STREAMS FOUND");
        }
    } catch(e) {
        console.error("TEST FAILED:", e);
    }
}

test();
