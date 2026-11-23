'use strict';
const fs = require('fs');
const path = require('path');

// Clean conflicting runtime cache files in root data/ that cause @vercel/ncc asset collisions
const rootData = path.join(__dirname, '..', 'data');
if (fs.existsSync(rootData)) {
  const conflicting = ['iframe_domains.json', 'matches_cache.json', 'team_logos_cache.json', 'sportzx_events.json'];
  for (const file of conflicting) {
    const fullPath = path.join(rootData, file);
    if (fs.existsSync(fullPath)) {
      try {
        fs.unlinkSync(fullPath);
      } catch (_) {}
    }
  }
}
