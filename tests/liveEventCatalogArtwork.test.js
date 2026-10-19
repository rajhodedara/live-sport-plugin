jest.mock('../src/container',()=>({resolve:jest.fn()}));
jest.mock('../src/streams',()=>({prewarmMatch:jest.fn()}));
jest.mock('../src/config',()=>({BASE_URL:'https://addon.test'}));
jest.mock('../src/timezone',()=>({parseTimezone:value=>Date.parse(value)}));
jest.mock('../src/services/ChannelLogoService',()=>({getChannelLogo:()=>null}));
jest.mock('../src/services/MainstreamRankingService',()=>({getMatchTier:()=>1}));
jest.mock('../src/services/ReplayFilterService',()=>({filterReplayMatches:x=>x}));
const container=require('../src/container');
const {mapMatchToMetaPreview}=require('../src/catalog');
let clock;
beforeAll(()=>{clock=jest.spyOn(Date,'now').mockReturnValue(Date.parse('2026-10-13T12:00:00Z'));});
afterAll(()=>clock.mockRestore());
beforeEach(()=>container.resolve.mockImplementation(()=>{throw new Error('fixture no services');}));
const fixture=fields=>({id:'fixture',title:'WTA - Singles: Kimberly Birrell vs Katie Volynets',category:'tennis',date:'2026-10-13T13:00:00Z',status:'upcoming',team1:{name:'Kimberly Birrell'},team2:{name:'Katie Volynets'},sources:[{source:'fixture',channelName:'Tennis HD'}],...fields});
test.each(['poster','logo','thumbnail_url'])('event design takes precedence over provider %s', field=>{
  const meta=mapMatchToMetaPreview(fixture({[field]:'https://fixture.invalid/art.png'})); const url=new URL(meta.poster);
  expect(url.pathname).toBe('/img/match'); expect(url.searchParams.get('art')).toBe('event-v3'); expect(url.searchParams.get('v')).toBe('3');
  for(const key of ['b1','b2','lb','cb','cm'])expect(url.searchParams.has(key)).toBe(false);
});
test('dated golf event leads to the event card instead of channel artwork',()=>{
  const meta=mapMatchToMetaPreview(fixture({category:'golf',title:'Tour Championship - Round 2',team1:null,team2:null,logo:'https://fixture.invalid/channel.png'}));
  const url=new URL(meta.poster); expect(url.pathname).toBe('/img/match'); expect(url.searchParams.get('title')).toBe('Tour Championship - Round 2'); expect(url.searchParams.get('art')).toBe('event-v3');
});
test.each([{date:'0',status:'live'},{date:null,status:'live'},{date:'invalid',status:'upcoming'},{status:'finished'},{status:'cancelled'},{status:'postponed'}])('non-event metadata retains provider artwork: %j', fields=>{
  const meta=mapMatchToMetaPreview(fixture({...fields,poster:'https://fixture.invalid/legacy.png'})); const url=new URL(meta.poster); expect(url.pathname).toBe('/img'); expect(url.searchParams.get('url')).toBe('https://fixture.invalid/legacy.png');
});
test('replay retains provider artwork and series shape',()=>{
  const meta=mapMatchToMetaPreview(fixture({date:'2026-10-12T13:00:00Z',status:'finished',sources:[{source:'replayzone'}],poster:'https://fixture.invalid/replay.png'}),{},'series');
  expect(new URL(meta.poster).pathname).toBe('/img'); expect(meta.posterShape).toBe('regular');
});
test('portrait event and other sports preserve their provider priority',()=>{
  for(const [fields,type] of [[{},'series'],[{category:'football'},'tv']]){
    const meta=mapMatchToMetaPreview(fixture({...fields,poster:'https://fixture.invalid/legacy.png'}),{},type); expect(new URL(meta.poster).pathname).toBe('/img');
  }
});
test('editorial artwork does not initiate crest discovery',()=>{
  const lookup={getCachedLogo:jest.fn(()=>null),findTeamLogo:jest.fn(async()=>null),getLeagueLogo:jest.fn(()=>null)};
  container.resolve.mockReturnValue(lookup); mapMatchToMetaPreview(fixture({logo:'https://fixture.invalid/logo.png'})); expect(lookup.findTeamLogo).not.toHaveBeenCalled(); expect(lookup.getLeagueLogo).not.toHaveBeenCalled();
});
