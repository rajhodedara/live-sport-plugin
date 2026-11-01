'use strict';

const MatchAggregator = require('../src/services/MatchAggregator');

describe('MatchAggregator Football Club Aliases and Variants', () => {
  const agg = new MatchAggregator({});

  test('merges Lyon across full official name (Olympique Lyonnais) and short name', () => {
    const e1 = { id: 'spk1', title: 'Lyon vs. Crystal Palace', category: 'football', date: '1792082700000' };
    const e2 = { id: 'dlv1', title: 'Olympique Lyonnais vs Crystal Palace', category: 'football', date: '1792082700000' };
    expect(agg.isSameEvent(e1, e2)).toBe(true);
  });

  test('merges AC Milan and bare Milan when paired with Salzburg / RB Salzburg', () => {
    const e1 = { id: 'spk2', title: 'RB Salzburg vs. AC Milan', category: 'football', date: '1792082700000' };
    const e2 = { id: 'dlv2', title: 'Salzburg vs Milan', category: 'football', date: '1792082700000' };
    expect(agg.isSameEvent(e1, e2)).toBe(true);
  });

  test('merges Czech Praha and English Prague (Sparta Praha vs Lillestrom)', () => {
    const e1 = { id: 'spk3', title: 'Sparta Prague vs. Lillestrom', category: 'football', date: '1792082700000' };
    const e2 = { id: 'dlv3', title: 'Sparta Praha vs Lillestrøm', category: 'football', date: '1792082700000' };
    expect(agg.isSameEvent(e1, e2)).toBe(true);
  });

  test('merges AZ and AZ Alkmaar (AZ vs Hapoel Be\'er Sheva)', () => {
    const e1 = { id: 'spk4', title: 'AZ Alkmaar vs. Hapoel Be\'er', category: 'football', date: '1792082700000' };
    const e2 = { id: 'dlv4', title: 'AZ vs Hapoel Be\'er Sheva', category: 'football', date: '1792082700000' };
    expect(agg.isSameEvent(e1, e2)).toBe(true);
  });

  test('merges Portuguese Sporting variants (Sporting CP vs Sporting Lisbon)', () => {
    const e1 = { id: 'spk5', title: 'Sporting CP vs Arsenal', category: 'football', date: '1792082700000' };
    const e2 = { id: 'dlv5', title: 'Sporting Lisbon vs Arsenal', category: 'football', date: '1792082700000' };
    expect(agg.isSameEvent(e1, e2)).toBe(true);
  });

  test('merges Spanish Athletic Club vs Athletic Bilbao', () => {
    const e1 = { id: 'spk6', title: 'Athletic Club vs Barcelona', category: 'football', date: '1792082700000' };
    const e2 = { id: 'dlv6', title: 'Athletic Bilbao vs Barcelona', category: 'football', date: '1792082700000' };
    expect(agg.isSameEvent(e1, e2)).toBe(true);
  });

  test('merges Dutch Eredivisie clubs (PSV vs PSV Eindhoven, Feyenoord vs Feyenoord Rotterdam)', () => {
    const e1 = { id: 'spk7', title: 'PSV vs Feyenoord', category: 'football', date: '1792082700000' };
    const e2 = { id: 'dlv7', title: 'PSV Eindhoven vs Feyenoord Rotterdam', category: 'football', date: '1792082700000' };
    expect(agg.isSameEvent(e1, e2)).toBe(true);
  });

  test('negative guard: Olimpia Milano (basketball) must NOT merge with AC Milan (football)', () => {
    const e1 = { id: 'bball1', title: 'Olimpia Milano vs Real Madrid', category: 'basketball', date: '1792082700000' };
    const e2 = { id: 'foot1', title: 'AC Milan vs Real Madrid', category: 'football', date: '1792082700000' };
    expect(agg.isSameEvent(e1, e2)).toBe(false);
  });

  test('negative guard: Sporting Gijon must NOT merge with Sporting CP', () => {
    const e1 = { id: 'spk8', title: 'Sporting Gijon vs Real Oviedo', category: 'football', date: '1792082700000' };
    const e2 = { id: 'dlv8', title: 'Sporting CP vs Real Oviedo', category: 'football', date: '1792082700000' };
    expect(agg.isSameEvent(e1, e2)).toBe(false);
  });

  test('merges Bayer Leverkusen across official name and short name (Bayer Leverkusen vs Leverkusen)', () => {
    const e1 = { id: 'sf_4785', title: 'Bayer Leverkusen vs VfB Stuttgart', category: 'football', date: '1793460600000', status: 'finished' };
    const e2 = { id: 'livetv_1', title: 'Leverkusen vs Stuttgart', category: 'football', date: '1793460600000', status: 'finished' };
    expect(agg.isSameEvent(e1, e2)).toBe(true);
  });
});
