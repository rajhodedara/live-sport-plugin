'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const BroadcasterMatchService = require('../src/services/BroadcasterMatchService');

let fixtureDir;
let service;
const channel = (name, group, id) => ({ name, group, vavooUrl: `https://media.example.test/${id}` });

beforeAll(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcaster-identity-'));
  const catalogPath = path.join(fixtureDir, 'channels.json');
  fs.writeFileSync(catalogPath, JSON.stringify([
    channel('SKY SPORTS F1', 'United Kingdom', 'sky-uk'),
    channel('SKY SPORT F1', 'Italy', 'sky-it'),
    channel('DAZN 1', 'Spain', 'dazn-es'),
    channel('DAZN 1 (MATCH TIME) HD .b', 'Germany', 'dazn-de'),
    channel('BEIN SPORTS 1', 'United Kingdom', 'bein-uk'),
    channel('BEIN SPORTS 1', 'France', 'bein-fr'),
    channel('TNT SPORT 1', 'United Kingdom', 'tnt-1'),
    channel('TNT SPORT 10', 'United Kingdom', 'tnt-10'),
    channel('CANAL+ LIVE 3', 'France', 'canal-3'),
    channel('CANAL+ EXTRA 2', 'Poland', 'canal-extra-2'),
    channel('M+ LALIGA', 'Spain', 'laliga'),
    channel('M.LIGA DE CAMPEONES HD', 'Spain', 'champions'),
    channel('BE SPORTS 1 HD', 'Arabia', 'be-sport'),
    channel('BEINSPORT AR 1', 'Arabia', 'bein-ar'),
    channel('ITV BE', 'United Kingdom', 'itv-be')
  ]));
  service = new BroadcasterMatchService({ catalogPath });
});

afterAll(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));

test.each([
  ['Sky Sport F1 IT', 'Italy', 'sky-it'],
  ['Sky Sport F1 Italy', 'Italy', 'sky-it'],
  ['IT | Sky Sports F1', 'Italy', 'sky-it'],
  ['DAZN 1 DE', 'Germany', 'dazn-de'],
  ['beIN Sports 1 FR', 'France', 'bein-fr'],
  ['Canal+ Live 3 France', 'France', 'canal-3'],
  ['Canal+ Extra 2 Poland', 'Poland', 'canal-extra-2']
])('preserves country and signal for %s', (query, group, id) => {
  expect(service.findChannel(query)).toMatchObject({ group, vavooUrl: `https://media.example.test/${id}` });
});

test.each([
  { countryCode: 'IT' },
  { country: 'Italy' },
  { group: 'Italy' }
])('uses explicit source country context %p', context => {
  expect(service.findChannel('Sky Sport F1', context)).toMatchObject({ group: 'Italy' });
  expect(service.createVavooSource('Sky Sport F1', context)).toMatchObject({ group: 'Italy', id: 'https://media.example.test/sky-it' });
});

test('missing or conflicting regional variants never fall back to a different country', () => {
  expect(service.findChannel('TNT Sports 1 DE')).toBeNull();
  expect(service.findChannel('Sky Sport F1', { country: 'France' })).toBeNull();
  expect(service.findChannel('Sky Sport F1 IT', { countryCode: 'UK' })).toBeNull();
  expect(service.findChannel('Sky Sport F1', { country: 'Italy', countryCode: 'UK' })).toBeNull();
});

test.each(['TNT Sports 1 2', 'TNT Sports 1 News', 'TNT Sports 10 Extra', 'Canal+ Live 3 4'])('does not reinterpret an unknown signal suffix: %s', query => {
  expect(service.findChannel(query)).toBeNull();
});

test('preserves numbered signals, unqualified aliases, and quality-only variants', () => {
  expect(service.findChannel('TNT Sports 1')).toMatchObject({ vavooUrl: 'https://media.example.test/tnt-1' });
  expect(service.findChannel('TNT Sports 10')).toMatchObject({ vavooUrl: 'https://media.example.test/tnt-10' });
  expect(service.findChannel('BT Sport 1')).toMatchObject({ vavooUrl: 'https://media.example.test/tnt-1' });
  expect(service.findChannel('TNT SPORTS 1 (FHD / BACKUP) [UK]')).toMatchObject({ vavooUrl: 'https://media.example.test/tnt-1' });
  expect(service.findChannel('TNT SPORT 1 HD (BACKUP 2) UK')).toMatchObject({ vavooUrl: 'https://media.example.test/tnt-1' });
  expect(service.findChannel('Movistar LaLiga')).toMatchObject({ vavooUrl: 'https://media.example.test/laliga' });
  expect(service.findChannel('Sky Sport F1')).toMatchObject({ group: 'United Kingdom' });
});

test('the committed catalog honors the reported country-code cases', () => {
  const actual = new BroadcasterMatchService();
  expect(actual.findChannel('Sky Sport F1 IT')).toMatchObject({ group: 'Italy' });
  expect(actual.findChannel('DAZN 1 DE')).toMatchObject({ group: 'Germany' });
  expect(actual.findChannel('beIN Sports 1 FR')).toMatchObject({ group: 'France' });
});

test('country-like words intrinsic to known channel names remain part of the brand', () => {
  expect(service.findChannel('Movistar Liga de Campeones')).toMatchObject({ group: 'Spain' });
  expect(service.findChannel('Movistar Liga de Campeones', { country: 'Spain' })).toMatchObject({ group: 'Spain' });
  for (const [query, group] of [['M.LIGA DE CAMPEONES HD', 'Spain'], ['BE SPORTS 1 HD', 'Arabia'], ['BEINSPORT AR 1', 'Arabia'], ['ITV BE', 'United Kingdom']]) {
    expect(service.findChannel(query)).toMatchObject({ group });
  }
});

test('surrounding regional annotations preserve the complete known brand', () => {
  expect(service.findChannel('BE SPORTS 1 HD Arabia')).toMatchObject({ group: 'Arabia' });
  expect(service.findChannel('BE SPORTS 1 MENA')).toMatchObject({ group: 'Arabia' });
  expect(service.findChannel('ITV BE UK')).toMatchObject({ group: 'United Kingdom' });
  expect(service.findChannel('UK ITV BE')).toMatchObject({ group: 'United Kingdom' });
  expect(service.findChannel('UK | ITV BE')).toMatchObject({ group: 'United Kingdom' });
  expect(service.findChannel('Arabia BE SPORTS 1')).toMatchObject({ group: 'Arabia' });
  expect(service.findChannel('BE SPORTS 1 DE')).toBeNull();
});

test('every complete committed catalog name honors its own country context', () => {
  const actual = new BroadcasterMatchService();
  const channels = require('../src/data/vavoo_channels.json');
  for (const channel of channels.filter(ch => ch && ch.name && ch.vavooUrl && ch.group)) {
    expect(actual.findChannel(channel.name, { group: channel.group })).toMatchObject({ group: channel.group });
  }
  expect(actual.findChannel('مصدر غير موجود')).toBeNull();
  expect(actual.findChannel('HD')).toBeNull();
});
