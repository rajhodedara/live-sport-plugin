'use strict';

const ChannelCountryService = require('../src/services/ChannelCountryService');
const ChannelIdentityService = require('../src/services/ChannelIdentityService');
const BroadcasterMatchService = require('../src/services/BroadcasterMatchService');

// Retained names and context from the November 1 real-provider sync catalog.
// These exercise the provider metadata -> identity -> broadcaster lookup path.
test.each([
  ['Movistar Liga de Campeones', null, 'Movistar Liga De Campeones'],
  ['Movistar Liga de Campeones 2', '2', 'Movistar Liga De Campeones 2']
])('preserves Spanish brand words and signal in %s', (channelName, channelNumber, canonicalTitle) => {
  expect(ChannelCountryService.detectChannelCountry(channelName)).toMatchObject({
    country: 'Spain', name: 'ES', language: 'Spanish'
  });
  const identity = ChannelIdentityService.parseChannel(channelName);
  expect(identity).toMatchObject({
    canonicalTitle, channelNumber, country: 'Spain', countryCode: 'ES', language: 'Spanish'
  });
});

test.each([
  ['Digi Sport 3 Romania', 'RO', 'Romania', '3'],
  ['MAX Sport 3 Bulgaria', 'BG', 'Bulgaria', '3'],
  ['Arena Sport 1 Croatia', 'HR', 'Croatia', '1']
])('maps retained %s with its explicit country code', (channelName, country, group, channelNumber) => {
  const service = new BroadcasterMatchService();
  expect(service.findChannel(channelName, { country })).toMatchObject({ group });
  expect(service.findChannel(channelName, { country: group, countryCode: country })).toMatchObject({ group });
  const channel = service.findChannel(channelName, { country });
  expect(ChannelIdentityService.parseChannel(channel.name, { group }).channelNumber).toBe(channelNumber);
  expect(service.findChannel(channelName, { countryCode: 'DE' })).toBeNull();
});

test('the Movistar provider country result can select its Spanish broadcaster', () => {
  const service = new BroadcasterMatchService();
  const country = ChannelCountryService.detectChannelCountry('Movistar Liga de Campeones');
  expect(service.findChannel('Movistar Liga de Campeones', { country: country.name })).toMatchObject({ group: 'Spain' });
});

test.each(['DE', '(DE)', 'DE HD'])('retains an explicit German boundary annotation %s', annotation => {
  expect(ChannelCountryService.detectChannelCountry(`TNT Sports 1 ${annotation}`)).toMatchObject({ country: 'Germany', name: 'DE' });
});

test.each([
  ['Digi Sport 3', 'RO', 'Romania'],
  ['Arena Sport 1', 'HR', 'Croatia'],
  ['MAX Sport 3', 'BG', 'Bulgaria']
])('honors explicit country metadata for %s', (name, country, canonicalCountry) => {
  expect(ChannelIdentityService.parseChannel(name, { country })).toMatchObject({
    country: canonicalCountry, countryCode: country
  });
});

test('keeps explicit country codes authoritative and distinct in the identity cache', () => {
  expect(ChannelIdentityService.parseChannel('Movistar Liga de Campeones', { group: 'Sports Channels', countryCode: 'ES' })).toMatchObject({
    country: 'Spain', countryCode: 'ES', language: 'Spanish'
  });
  expect(ChannelIdentityService.parseChannel('Movistar Liga de Campeones', { group: 'Sports Channels', countryCode: 'DE' })).toMatchObject({
    country: 'Germany', countryCode: 'DE', language: 'German'
  });
  expect(ChannelIdentityService.parseChannel('Arena Sport 1', { group: 'Sports Channels', country: 'HR' })).toMatchObject({
    country: 'Croatia', countryCode: 'HR', language: 'Croatian'
  });
});
