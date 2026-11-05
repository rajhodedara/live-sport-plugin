'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const acorn = require('acorn');

const html = fs.readFileSync(path.join(__dirname, '../public/configure.html'), 'utf8');
const script = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
  .map(match => match[1]).find(source => source.includes('const popularTimezones'));
const ast = acorn.parse(script, { ecmaVersion: 'latest' });
let population;
function walk(node) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'TryStatement' && node.block.body.some(statement =>
    statement.type === 'VariableDeclaration' && statement.declarations.some(declaration =>
      declaration.id.name === 'popularTimezones'))) population = script.slice(node.start, node.end);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') walk(value);
  }
}
walk(ast);
if (!population) throw new Error('No timezone population block found in configure.html');

function optionsFor(timezone) {
  const options = [];
  vm.runInNewContext(population, {
    existingConfig: { timezone }, Intl,
    Date: class { getTimezoneOffset() { throw new Error('Browser offset must not label an IANA zone'); } },
    timezoneSelect: {
      firstChild: null,
      appendChild: option => options.push(option),
      insertBefore: option => options.unshift(option)
    },
    document: { createElement: () => ({}) },
    console: { warn(error, cause) { throw cause || new Error(error); } }
  }, { timeout: 1000 });
  return options;
}

test.each(['Asia/Kathmandu', 'America/Edmonton', 'America/New_York', 'Australia/Sydney'])(
  'restores %s as an IANA value without a fixed GMT claim', timezone => {
    const options = optionsFor(timezone);
    const selected = options.filter(option => option.selected);
    expect(selected).toHaveLength(1);
    expect(selected[0].value).toBe(timezone);
    expect(selected[0].textContent).toContain(`(${timezone})`);
    expect(options.every(option => !/GMT[+-]/.test(option.textContent))).toBe(true);
    expect(options.filter(option => option.value === timezone)).toHaveLength(1);
  }
);

test('all 25 preset values remain usable IANA timezone identifiers', () => {
  const options = optionsFor('America/New_York');
  expect(options).toHaveLength(25);
  expect(new Set(options.map(option => option.value)).size).toBe(25);
  options.forEach(option => {
    expect(() => new Intl.DateTimeFormat('en-US', { timeZone: option.value })).not.toThrow();
    expect(option.textContent).toContain(`(${option.value})`);
  });
});
