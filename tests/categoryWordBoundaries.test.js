const BaseProvider = require('../src/providers/BaseProvider');
const skTech = require('../src/resolver/sktech/SkTechMatchResolver');
const { normalizeCategory: liveTv } = require('../src/providers/LiveTVProvider');

const base = (t) => Object.create(BaseProvider.prototype).normalizeCategory(t);

describe('BaseProvider.normalizeCategory: cricket codes are whole words', () => {
  test('"T2026" in a padel title is not T20', () => {
    expect(base("Premier Padel. Dubai (T2026): Women's Quarter-Finals")).not.toBe('cricket');
  });
  test('real cricket labels still classify', () => {
    for (const l of ['Cricket', 'IPL', 'IPL 2026', 'T20 World Cup', 'T20I Series', 'ODI Series', 'BBL', 'PSL 2026', 'CPL', 'Big Bash cricket']) {
      expect(base(l)).toBe('cricket');
    }
  });
  test('a code buried inside another word is not cricket', () => {
    for (const l of ['Melodies Live', 'Modi Cup', 'Tipple Open']) expect(base(l)).not.toBe('cricket');
  });
  test('other sports are untouched', () => {
    expect(base('NFL')).toBe('american_football');
    expect(base('Tennis')).toBe('tennis');
    expect(base('Golf')).toBe('golf');
    expect(base('Mixed Martial Arts')).toBe('mma');
  });
});

describe('SkTech normalizeCategory: whole-word cricket hints', () => {
  test('"Championship" is not "Champions"', () => {
    expect(skTech.normalizeCategory('', 'DP World Tour Championship Dubai - Day 2')).not.toBe('cricket');
  });
  test('"T2026" is not T20', () => {
    expect(skTech.normalizeCategory('', "Premier Padel. Dubai (T2026)")).not.toBe('cricket');
  });
  test('Champions League is football, Champions Trophy is cricket', () => {
    expect(skTech.normalizeCategory('', 'Champions League: Real Madrid vs Bayern')).toBe('football');
    expect(skTech.normalizeCategory('', 'AFC Champions League')).toBe('football');
    expect(skTech.normalizeCategory('', 'Champions Hockey League')).toBe('hockey');
    expect(skTech.normalizeCategory('', 'Basketball Champions League')).toBe('basketball');
    expect(skTech.normalizeCategory('', 'ICC Champions Trophy')).toBe('cricket');
  });
  test('real cricket hints still classify', () => {
    expect(skTech.normalizeCategory('', 'Champions Trophy Final')).toBe('cricket');
    expect(skTech.normalizeCategory('IPL', 'Match 12')).toBe('cricket');
    expect(skTech.normalizeCategory('', '2nd ODI Namibia v Uganda')).toBe('cricket');
    expect(skTech.normalizeCategory('Cricket', 'anything')).toBe('cricket');
    expect(skTech.normalizeCategory('', 'T20I Series')).toBe('cricket');
  });
});

describe('LiveTV normalizeCategory: "del" is not the German hockey league', () => {
  test('Copa del Rey is football', () => {
    expect(liveTv('Spain. Copa del Rey')).toBe('football');
  });
  test('German DEL still hockey', () => {
    expect(liveTv('Germany. DEL')).toBe('hockey');
    expect(liveTv('DEL')).toBe('hockey');
  });
  test('other hockey codes unchanged', () => {
    expect(liveTv('Russia. KHL')).toBe('hockey');
    expect(liveTv('Alps Hockey League')).toBe('hockey');
  });
});
