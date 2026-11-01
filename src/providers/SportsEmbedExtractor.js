const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

function buildProtoHex(embedUrl) {
    // https://sportsembed.su/embed/6028327/club-america-columbus-crew/platinum/1
    const parts = embedUrl.split('/');
    const channel = parts.pop();
    const tier = parts.pop();
    const slug = parts.pop();
    const matchId = parts.pop();

    const writeString = (tag, str) => {
        const strBuf = Buffer.from(str, 'utf8');
        const buf = Buffer.alloc(2 + strBuf.length);
        let offset = 0;
        buf.writeUInt8((tag << 3) | 2, offset++);
        buf.writeUInt8(strBuf.length, offset++);
        strBuf.copy(buf, offset);
        return buf;
    };

    return Buffer.concat([
        writeString(1, tier),
        writeString(2, slug),
        writeString(3, channel),
        writeString(4, matchId)
    ]).toString('hex');
}

const wasmPath = path.join(__dirname, 'stream-lock.wasm');
let _wasmModule = null;
function getWasmModule() {
  if (!_wasmModule) {
    const bytes = fs.readFileSync(wasmPath);
    _wasmModule = new WebAssembly.Module(bytes);
  }
  return _wasmModule;
}

async function extractSportsEmbed(embedUrl) {
    const protoHex = buildProtoHex(embedUrl);
    const instance = new WebAssembly.Instance(getWasmModule(), {});
    const exports = instance.exports;
    const mem = exports.memory;
    
    function getMem() { return new Uint8Array(mem.buffer); }
    function getDV() { return new DataView(mem.buffer); }

    let ctx = exports.ovpc12b4fa4bac(-16);
    
    const protoBytes = Buffer.from(protoHex, 'hex');
    const nonceBytes = crypto.randomBytes(32);
    
    const p1 = Buffer.alloc(1 + 4 + protoBytes.length + 4 + nonceBytes.length);
    let offset = 0;
    p1.writeUInt8(0x17, offset); offset += 1;
    p1.writeUInt32LE(protoBytes.length, offset); offset += 4;
    protoBytes.copy(p1, offset); offset += protoBytes.length;
    p1.writeUInt32LE(nonceBytes.length, offset); offset += 4;
    nonceBytes.copy(p1, offset); offset += nonceBytes.length;
    
    const ptr1 = exports.izcs19bd193b14(p1.length, 1);
    getMem().set(p1, ptr1);
    exports.vlhl85a7afaa09(ctx, ptr1, p1.length);
    
    const factorPtr = getDV().getUint32(ctx, true);
    const factor = Buffer.from(mem.buffer.slice(factorPtr, factorPtr + 16));
    
    exports.cwyd1adb5e0ed7(factorPtr, 16, 1);
    exports.ovpc12b4fa4bac(16);
    ctx = exports.ovpc12b4fa4bac(-16);
    
    const p2 = Buffer.alloc(1 + 4 + protoBytes.length + 4 + nonceBytes.length + 4 + 16);
    offset = 0;
    p2.writeUInt8(0x29, offset); offset += 1;
    p2.writeUInt32LE(protoBytes.length, offset); offset += 4;
    protoBytes.copy(p2, offset); offset += protoBytes.length;
    p2.writeUInt32LE(nonceBytes.length, offset); offset += 4;
    nonceBytes.copy(p2, offset); offset += nonceBytes.length;
    p2.writeUInt32LE(16, offset); offset += 4;
    factor.copy(p2, offset); offset += 16;
    
    const ptr2 = exports.izcs19bd193b14(p2.length, 1);
    getMem().set(p2, ptr2);
    exports.vlhl85a7afaa09(ctx, ptr2, p2.length);
    
    const proofPtr = getDV().getUint32(ctx, true);
    const proof = Buffer.from(mem.buffer.slice(proofPtr, proofPtr + 64)).toString();
    
    exports.cwyd1adb5e0ed7(proofPtr, 64, 1);
    exports.ovpc12b4fa4bac(16);
    ctx = exports.ovpc12b4fa4bac(-16);
    
    const { getImpit } = require('../impitClient');
    const impit = getImpit();
    let resp;
    const fetchArgs = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-protobuf',
            'x-client-nonce': nonceBytes.toString('base64'),
            'x-client-factor': factor.toString('base64'),
            'x-client-proof': proof,
            'Origin': 'https://sportsembed.su',
            'Referer': embedUrl,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
        },
        body: protoBytes
    };
    
    if (impit) {
        resp = await impit.fetch('https://sportsembed.su/api/get', fetchArgs);
    } else {
        const https = require('https');
        const adaptiveDnsResolver = require('../services/AdaptiveDnsResolver');
        const keepAliveAgent = new https.Agent({
          keepAlive: true,
          keepAliveMsecs: 10000,
          lookup: (hostname, opts, cb) => adaptiveDnsResolver.lookup(hostname, opts, cb)
        });
        const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
        fetchArgs.agent = keepAliveAgent;
        resp = await fetch('https://sportsembed.su/api/get', fetchArgs);
    }
    
    const resBuf = Buffer.from(await resp.arrayBuffer());
    if (resBuf.length < 50) throw new Error('API Blocked / Forbidden: ' + resBuf.toString());
    
    const liveHex = resp.headers.get('x-live').replace('WFTY_EDGE_V3_', '');
    const liveBytes = Buffer.from(liveHex, 'hex');
    const edgeBytes = Buffer.from(resp.headers.get('x-edge'), 'base64');
    
    const extra32 = Buffer.concat([liveBytes, edgeBytes]);
    const token = Buffer.from(resp.headers.get('x-body-tag'), 'base64');
    const payload = resBuf;
    
    const p3 = Buffer.alloc(1 + 4 + payload.length + 4 + 32 + 4 + 32 + 4 + 16 + 4 + 8);
    offset = 0;
    p3.writeUInt8(0x3b, offset); offset += 1;
    
    p3.writeUInt32LE(payload.length, offset); offset += 4;
    payload.copy(p3, offset); offset += payload.length;
    
    p3.writeUInt32LE(32, offset); offset += 4;
    extra32.copy(p3, offset); offset += 32;
    
    p3.writeUInt32LE(32, offset); offset += 4;
    nonceBytes.copy(p3, offset); offset += 32;
    
    p3.writeUInt32LE(16, offset); offset += 4;
    factor.copy(p3, offset); offset += 16;
    
    p3.writeUInt32LE(8, offset); offset += 4;
    token.copy(p3, offset); offset += 8;
    
    const ptr3 = exports.izcs19bd193b14(p3.length, 1);
    getMem().set(p3, ptr3);
    
    exports.vlhl85a7afaa09(ctx, ptr3, p3.length);
    
    for(let i = 0; i < 64; i += 4) {
        const val = getDV().getUint32(ctx + i, true);
        if (val > 1000000 && val < 10000000) {
            const len = getDV().getUint32(ctx + i + 4, true);
            const len2 = getDV().getUint32(ctx + i - 4, true);
            if (len > 50 && len < 300) {
                const urlBuf = Buffer.from(mem.buffer.slice(val, val + len));
                if (urlBuf.toString().startsWith('http')) return urlBuf.toString();
            } else if (len2 > 50 && len2 < 300) {
                const urlBuf = Buffer.from(mem.buffer.slice(val, val + len2));
                if (urlBuf.toString().startsWith('http')) return urlBuf.toString();
            }
        }
    }
    
    throw new Error('M3U8 string not found in decoded memory.');
}

module.exports = { extractSportsEmbed };
