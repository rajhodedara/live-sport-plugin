const MatchAggregator = require('./src/services/MatchAggregator');
const a = new MatchAggregator({providers:[]});

// Test Perth Wildcats with different categories
const cats = ['basketball', 'nbl', 'sports', 'other'];
console.log('--- Perth Wildcats category pairs ---');
let allPerthPass = true;
for(let c1 of cats) for(let c2 of cats) {
  const m1 = {title:'Perth Wildcats vs Adelaide 36ers', category:c1, date:Date.now(), id:'1'};
  const m2 = {title:'Perth Wildcats vs Adelaide 36ers', category:c2, date:Date.now(), id:'2'};
  const result = a.isSameEvent(m1, m2);
  if(!result) { console.log('FAIL:', c1, 'vs', c2); allPerthPass = false; }
}
if(allPerthPass) console.log('All Perth category pairs: PASS');

// Test Azerbaijan GP title variants
const azTitles = [
  'Formula 1 Azerbaijan Grand Prix',
  'Azerbaijan Grand Prix', 
  'F1 Azerbaijan Grand Prix',
  'Formula 1 2026 Azerbaijan Grand Prix',
  'Formula 1 - Azerbaijan Grand Prix',
  'Azerbaijan GP',
];
console.log('\n--- Azerbaijan GP merge matrix ---');
let allAzPass = true;
for(let i=0; i<azTitles.length; i++) for(let j=i+1; j<azTitles.length; j++) {
  const m1 = {title:azTitles[i], category:'motorsport', date:Date.now(), id:''+i};
  const m2 = {title:azTitles[j], category:'motorsport', date:Date.now(), id:''+j};
  const result = a.isSameEvent(m1, m2);
  console.log(result ? 'PASS' : 'FAIL', `"${azTitles[i]}" vs "${azTitles[j]}"`);
  if(!result) allAzPass = false;
}
if(allAzPass) console.log('All Azerbaijan pairs: PASS');

// Safety: confirm these don't merge accidentally
console.log('\n--- Safety: should NOT merge ---');
const m1 = {title:'Formula 1 Monaco Grand Prix', category:'motorsport', date:Date.now(), id:'a'};
const m2 = {title:'Formula 1 Azerbaijan Grand Prix', category:'motorsport', date:Date.now(), id:'b'};
const m3 = {title:'Formula 2 Azerbaijan Grand Prix', category:'motorsport', date:Date.now(), id:'c'};
console.log('Monaco vs Azerbaijan (should be false):', a.isSameEvent(m1, m2) ? 'FAIL - MERGED!' : 'PASS - separate');
console.log('F1 vs F2 Azerbaijan (should be false):', a.isSameEvent(m2, m3) ? 'FAIL - MERGED!' : 'PASS - separate');
