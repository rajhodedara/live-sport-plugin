'use strict';

// Locate the `player.php` endpoint reference inside an embed page.
//
// The previous unanchored patterns, /([^"']*player\.php)/ and
// /([^"'\s]*player\.php\?[^"'\s]*[?&]id=\d+[^"'\s]*)/, restart a greedy scan at
// every character and backtrack through the whole quote-free run each time, so on
// a long run they cost O(run^2) (about 1.7-2.1 s on a 60 KB run, tens of seconds
// on a real ~150 KB embed) and block the event loop for all of that time. Checking
// includes('player.php') first removes the pages that lack it entirely, but a page
// that mentions player.php after a long quote-free run still hits the quadratic path.
//
// Every run is therefore bounded. A URL reference longer than these limits is not a
// plausible player endpoint, and the cost becomes O(length * LEAD) instead of
// O(length^2). Results for ordinary references are identical (see the differential
// test).
const LEAD = 300;     // characters allowed before `player.php`
const MIDDLE = 500;   // characters between `player.php?` and `[?&]id=`
const TAIL = 1500;    // characters after the numeric id

const CONCRETE = new RegExp(
  `([^"'\\s]{0,${LEAD}}player\\.php\\?[^"'\\s]{0,${MIDDLE}}[?&]id=\\d+[^"'\\s]{0,${TAIL}})`, 'i');
const ENDPOINT = new RegExp(`([^"']{0,${LEAD}}player\\.php)`, 'i');

// Linear pre-check. Case-insensitive on purpose: the patterns below are /i, so a
// case-sensitive includes('player.php') guard would silently stop matching
// PLAYER.PHP, which the unguarded patterns used to accept.
const HAS_PLAYER_PHP = /player\.php/i;

function extractPlayerPhpRefs(html) {
  if (typeof html !== 'string' || !HAS_PLAYER_PHP.test(html)) return { concrete: null, endpointRef: null };
  const concrete = html.match(CONCRETE);
  const endpointRef = html.match(ENDPOINT);
  return { concrete: concrete ? concrete[1] : null, endpointRef: endpointRef ? endpointRef[1] : null };
}

module.exports = { extractPlayerPhpRefs, LEAD, MIDDLE, TAIL };
