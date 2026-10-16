const { generateMatchCardSvg } = require('../src/services/MinimalistPosterService');
const { matchCardUrl } = require('../src/services/ImageService');
const { usesLiveEventArtwork } = require('../src/services/LiveEventArtwork');
const spec = { category:'tennis', status:'upcoming', artwork:'event-v3', team1:'Kimberly Birrell', team2:'Katie Volynets', league:'WTA', time:'8:30 AM' };
test.each(['live','upcoming'])('tennis %s uses readable player rows without initial plates', status => {
  const svg=generateMatchCardSvg({...spec,status});
  expect(svg).toContain('data-artwork="live-event-v3"'); expect(svg).toContain('>BIRRELL<'); expect(svg).toContain('>VOLYNETS<');
  expect(svg).not.toContain('<circle'); expect(svg).not.toContain('<image'); expect(svg).toContain(status.toUpperCase());
});
test.each(['replay','247',''])('%s retains the legacy composer', status => {
  expect(generateMatchCardSvg({...spec,status})).not.toContain('live-event-v3');
});
test.each(['football','cricket','motorsport','networks'])('%s remains outside the redesign', category => {
  expect(generateMatchCardSvg({...spec,category})).not.toContain('live-event-v3');
});
test('legacy URLs and portrait cards retain their composer', () => {
  expect(generateMatchCardSvg({...spec,artwork:undefined})).not.toContain('live-event-v3');
  const svg=generateMatchCardSvg({...spec,shape:'poster'}); expect(svg).toContain('width="600" height="889"'); expect(svg).not.toContain('live-event-v3');
});
test.each(['Sara Sorribes Tormo','Alex de Minaur','María Camila Osorio','王 欣瑜','Naomi Ōsaka'])('preserves every token of %s', name => {
  const svg=generateMatchCardSvg({...spec,team1:name});
  for(const word of name.toUpperCase().split(' ')) expect(svg).toContain(word);
});
test('doubles preserves all four players without interpreting them as scores', () => {
  const svg=generateMatchCardSvg({...spec,team1:'Ellen Perez / Demi Schuurs',team2:'Marie Bouzkova / Sara Sorribes Tormo'});
  for(const name of ['ELLEN','PEREZ','DEMI','SCHUURS','MARIE','BOUZKOVA','SARA','SORRIBES TORMO']) expect(svg).toContain(name);
  expect(svg).toContain('DOUBLES'); expect(svg).not.toContain('Score');
});
test('single-name competitors remain meaningful', () => {
  const svg=generateMatchCardSvg({...spec,team1:'Zhang',team2:'Osaka'}); expect(svg).toContain('>ZHANG<'); expect(svg).toContain('>OSAKA<');
});
test.each([{}, {team1:'',team2:'Opponent'}, {team1:'A/B/C',team2:'D/E'}])('incomplete or unsupported participants use the supplied title', fields => {
  const svg=generateMatchCardSvg({...spec,team1:null,team2:null,...fields,title:'Tennis Exhibition'});
  expect(svg).toContain('TENNIS EXHIBITION'); expect(svg).not.toMatch(/undefined|NaN/);
});
test('long Unicode labels are bounded without splitting surrogate pairs', () => {
  const svg=generateMatchCardSvg({...spec,team1:'Player '+'W'.repeat(200),team2:'😀'.repeat(200)});
  expect(svg).toContain('…'); expect(svg).not.toContain('W'.repeat(100)); expect(svg).not.toContain('\uFFFD');
});
test('XML metacharacters are escaped in labels', () => {
  const svg=generateMatchCardSvg({...spec,team1:'A <script>evil</script>',team2:'B & "quote"'});
  expect(svg).not.toMatch(/<script>/i); expect(svg).toContain('&lt;SCRIPT&gt;'); expect(svg).toContain('&amp;'); expect(svg).toContain('&quot;');
});
test('live score is preserved only when supplied, never invented', () => {
  expect(generateMatchCardSvg({...spec,status:'live',score:'6-3 2-1'})).toContain('SCORE 6-3 2-1');
  expect(generateMatchCardSvg({...spec,status:'live'})).not.toContain('SCORE');
});
test('golf leads with the event title even if a channel mark is supplied', () => {
  const svg=generateMatchCardSvg({...spec,category:'golf',title:'Tour Championship - Round 2',league:'PGA Tour',channelMark:'https://fixture.invalid/logo.png',team1:null,team2:null});
  expect(svg).toContain('TOUR CHAMPIONSHIP'); expect(svg).toContain('ROUND 2'); expect(svg).not.toContain('<image'); expect(svg).not.toContain('fixture.invalid');
});
test('golf missing title uses metadata fallback without inventing a round or venue', () => {
  const svg=generateMatchCardSvg({...spec,category:'golf',team1:null,team2:null,title:null,league:null,time:null,channel:'Golf Channel'});
  expect(svg).toContain('GOLF EVENT'); expect(svg).toContain('GOLF CHANNEL'); expect(svg).not.toMatch(/ROUND|COURSE/);
});
test('only opted-in qualifying URLs get a new cache identity', () => {
  const url=new URL(matchCardUrl('https://addon.test',spec)); expect(url.searchParams.get('v')).toBe('3'); expect(url.searchParams.get('art')).toBe('event-v3');
  for(const fields of [{artwork:undefined},{status:'replay'},{status:'247'},{shape:'poster'},{category:'football'}]){
    const legacy=new URL(matchCardUrl('https://addon.test',{...spec,...fields})); expect(legacy.searchParams.get('v')).toBe('2'); expect(legacy.searchParams.has('art')).toBe(false);
  }
  expect(usesLiveEventArtwork(spec)).toBe(true);
});
