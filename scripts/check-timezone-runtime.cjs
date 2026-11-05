'use strict';

// Offline candidate-build check. Never imports the addon or changes its cache,
// clock, environment, installed timezone data, or running processes.
const reference = require('../tests/fixtures/timezone-runtime.json');
const fields = ['year', 'month', 'day', 'hour', 'minute', 'second'];

function numericParts(intl, zone, utc) {
  const parts = new intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
    timeZone: zone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(utc));
  return Object.fromEntries(fields.map(field => {
    const part = parts.find(item => item.type === field);
    if (!part || !/^\d+$/.test(part.value)) throw new Error('INVALID_INTL_PARTS');
    return [field, Number(part.value)];
  }));
}

function runRuntimeCheck({ cases = reference.cases, intl = Intl, runtime = process } = {}) {
  let defaultZone = null;
  try { defaultZone = new intl.DateTimeFormat().resolvedOptions().timeZone; } catch (_) { /* reported by cases */ }
  const results = cases.map(item => {
    try {
      const observed = numericParts(intl, item.zone, item.utc);
      const matches = fields.every(field => observed[field] === item.expected[field]);
      return { ...item, observed, status: matches ? 'PASS' : 'FAIL' };
    } catch (_) {
      return { ...item, status: 'FAIL', error: 'UNSUPPORTED_TIMEZONE_OR_INTL' };
    }
  });
  const failures = results.filter(item => item.status === 'FAIL').length;
  return {
    reference: reference.reference,
    runtime: {
      node: runtime.version, execPath: runtime.execPath,
      icu: runtime.versions?.icu ?? null, tz: runtime.versions?.tz ?? null,
      defaultZone
    },
    cases: results.length,
    failures,
    status: failures ? 'FAIL' : 'PASS',
    ...(failures ? {
      action: 'Use a supported full-ICU Node runtime or compatible ICU data that passes these controls. Verify the actual PM2/container interpreter before rollout; do not apply a global hour offset.'
    } : {}),
    results
  };
}

if (require.main === module) {
  const report = runRuntimeCheck();
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.failures ? 1 : 0;
}

module.exports = { runRuntimeCheck, numericParts };
