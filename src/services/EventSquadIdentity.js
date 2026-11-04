'use strict';

const { extractTeamsFromTitle } = require('./TeamNameExtractor');
const fold = value => String(value || '').normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '').toLowerCase();

function canonicalizeAge(text) {
  return String(text || '').replace(/\b(?:u[\s-]?|under[\s-]?)(\d{1,2})\b/gi,
    (whole, age) => Number(age) >= 8 && Number(age) <= 23 ? `U${Number(age)}` : whole);
}

// Missing qualifiers are deliberately not evidence of an adult/first team.
// Keep those listings separate from explicitly qualified ones. This can create
// duplicate cards when a provider omits metadata, but prevents source mixing.
function markers(raw, names = [], competition = '') {
  const gender = new Set(), age = new Set(), squad = new Set();
  const text = fold(raw);
  if (/\b(?:women(?:['’]s)?|womens|female|ladies)\b|\(\s*w\s*\)|\[\s*w\s*\]/.test(text)) gender.add('women');
  if (/\b(?:men(?:['’]s)?|mens|male)\b/.test(text)) gender.add('men');
  if (/\b(?:wnba|wta)\b/.test(competition)) gender.add('women');
  if (/\b(?:nba|atp)\b/.test(competition)) gender.add('men');
  for (const match of canonicalizeAge(text).matchAll(/\bu(\d{1,2})\b/gi)) age.add(match[1]);
  if (/\b(?:reserves?|second team)\b/.test(text)) squad.add('reserve2');
  if (/\b(?:first team|senior team)\b/.test(text)) squad.add('first');
  for (const name of names) {
    if (/\b(?:II|B)\s*\)?\s*$/i.test(name)) squad.add('reserve2');
    if (/\b(?:III|C)\s*\)?\s*$/i.test(name)) squad.add('reserve3');
  }
  return [gender, age, squad];
}
const signature = values => values.map(set => [...set].sort().join(',')).join('|');

function eventSquadIdentity(event) {
  const metadataTeams = [event.team1?.name || '', event.team2?.name || ''];
  // The aggregator also accepts a spaced dash as the fixture separator.
  const splitTitle = String(event.title || '').split(/\s(?:vs?\.?|@|[-–—])\s/i);
  const titleTeams = extractTeamsFromTitle(event.title) || (splitTitle.length === 2 ? splitTitle : []);
  const competition = fold([event.category, event.league].join(' '));
  const allNames = [...titleTeams, ...metadataTeams].filter(Boolean);
  const global = markers([event.title, event.league, ...metadataTeams].join(' '), allNames, competition);
  let titleContext = '';
  if (titleTeams.length === 2) {
    titleContext = String(event.title || '');
    for (const name of titleTeams) titleContext = titleContext.replace(name, '');
  }
  const inherited = markers([event.league, titleContext].join(' '), [], competition);
  let teamKeys = null, conflicting = false;
  if (titleTeams.length === 2 || metadataTeams.every(Boolean)) {
    teamKeys = [0, 1].map(index => {
      const names = [titleTeams[index], metadataTeams[index]].filter(Boolean);
      const team = markers(names.join(' '), names);
      // Only event-wide qualifiers can apply to both participants. A marker
      // attached to one team must not migrate to its opponent.
      team.forEach((set, dimension) => {
        if (set.size === 0 && inherited[dimension].size === 1) {
          for (const value of inherited[dimension]) set.add(value);
        }
        if (set.size > 1) conflicting = true;
      });
      return signature(team);
    });
  }
  return { key: signature(global), teamKeys, conflicting };
}

module.exports = { eventSquadIdentity, canonicalizeAge };
