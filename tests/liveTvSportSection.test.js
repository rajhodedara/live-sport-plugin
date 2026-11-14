'use strict';

const LiveTVProvider = require('../src/providers/LiveTVProvider');

const MENU = ['Football', 'Ice Hockey', 'Basketball', 'Table Tennis', 'Handball']
  .map((n) => `<span class="whitetitle">${n}</span>`).join(' ');
const section = (sport, comp, home, away, n = 1) => `
  <table><tr><td><span class="whitetitle">${sport}</span></td></tr></table>
  <a class="main" href="/enx/videotourney/${n}/"><b>${comp}</b></a>
  <table height=27><tr>
    <td><b>${home}&ndash;${away}</b></td>
    <td><font color="#949494"><b>1:0</b></font></td>
    <td><span class="date">20:00</span></td>
    <td><a class="small" href="/enx/showvideo/${n}_x">Highlights</a></td>
  </tr></table>`;
const page = (...parts) => `<html>${MENU}${parts.join('\n')}</html>`;
const parse = (html) => LiveTVProvider.parseArchive(html, '20261113');

describe('LiveTV archive: the sport title decides the category', () => {
  test('"Champions League" follows the sport section it sits in', () => {
    const items = parse(page(
      section('Football', 'Champions League', 'Lille', 'Saarbrucken', 1),
      section('Ice Hockey', 'Champions League', 'Koelner Haie', 'Bili Tygri Liberec', 2),
      section('Basketball', 'Champions League', 'Murcia', 'Bamberg', 3),
      section('Handball', 'Champions League', 'Roskilde', 'Nimes', 4),
      section('Table Tennis', 'Champions League', 'Sokah Hoboken', 'Priego', 5),
    ));
    expect(items.map((i) => i.category).join(',')).toBe('football,hockey,basketball,other,other');
  });

  test('other sport titles map to their category', () => {
    const items = parse(page(
      section('Cricket', 'Big Bash', 'Sydney Sixers', 'Perth Scorchers', 1),
      section('Racing', 'Formula 1', 'Qualifying', 'Race', 2),
      section('Tennis', 'ATP Paris', 'Player A', 'Player B', 3),
    ));
    expect(items.map((i) => i.category).join(',')).toBe('cricket,motorsport,tennis');
  });

  test('without a sport title the old competition-name guess still applies', () => {
    const html = `
      <a class="main" href="/enx/videotourney/1/"><b>Champions League</b></a>
      <table height=27><tr><td><b>A&ndash;B</b></td><td><span class="date">20:00</span></td>
      <td><a class="small" href="/enx/showvideo/1_x">Highlights</a></td></tr></table>
      <a class="main" href="/enx/videotourney/2/"><b>NHL</b></a>
      <table height=27><tr><td><b>C&ndash;D</b></td><td><span class="date">21:00</span></td>
      <td><a class="small" href="/enx/showvideo/2_x">Highlights</a></td></tr></table>`;
    expect(parse(html).map((i) => i.category).join(',')).toBe('football,hockey');
  });

  test('an unknown sport title falls back to the old guess', () => {
    const items = parse(page(section('Kabaddi', 'Pro Kabaddi League', 'Team A', 'Team B', 1)));
    expect(items[0].category).toBe('football');
  });

  test('the sport menu at the top does not leak into the first section', () => {
    const items = parse(page(section('Ice Hockey', 'NHL', 'Vegas Golden Knights', 'Calgary Flames', 1)));
    expect(items[0].category).toBe('hockey');
  });

  test('NBA franchise normalisation still works inside the Basketball section', () => {
    const items = parse(page(section('Basketball', 'NBA', 'Boston', 'Chicago', 1)));
    expect(items[0].category).toBe('basketball');
    expect(items[0].league).toBe('NBA');
  });
});
