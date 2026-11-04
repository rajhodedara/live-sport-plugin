'use strict';
const { EventEmitter } = require('node:events');
const { createTimingOutput } = require('../src/services/TimingOutput');

test('write false accepts that row, rejects subsequent rows until drain and resumes', () => {
  const writable = new EventEmitter(), lines = [];
  writable.write = jest.fn((line, callback) => { lines.push(line); callback(); return false; });
  const sink = createTimingOutput(writable);
  expect(sink.write('native_timing', { type: 'fixture' })).toBe(true);
  expect(sink.write('native_timing', { type: 'dropped' })).toBe(false);
  expect(writable.write).toHaveBeenCalledTimes(1);
  writable.emit('drain');
  writable.write.mockImplementation((line, callback) => { lines.push(line); callback(); return true; });
  expect(sink.write('stream_timing', { type: 'resumed' })).toBe(true);
  expect(sink.stats).toEqual({ accepted: 2, rejected: 1, failed: 0 });
  expect(JSON.parse(lines[0])).toMatchObject({ kind: 'native_timing', type: 'fixture', pid: process.pid });
  expect(JSON.parse(lines[0]).sessionId).toMatch(/^[a-f0-9]{32}$/);
});

test('closed output and failed write callbacks are counted separately', () => {
  const writable = new EventEmitter();
  writable.write = (_line, callback) => { callback(new Error('closed')); return true; };
  const sink = createTimingOutput(writable);
  expect(sink.write('native_timing', { type: 'fixture' })).toBe(true);
  writable.emit('error', new Error('closed'));
  expect(sink.write('native_timing', { type: 'fixture' })).toBe(false);
  expect(sink.stats).toEqual({ accepted: 1, rejected: 1, failed: 1 });
});

test('a reentrant write cannot bypass backpressure before write returns', () => {
  const writable = new EventEmitter();
  let sink;
  writable.write = jest.fn(() => {
    expect(sink.write('native_timing', { type: 'nested' })).toBe(false);
    return false;
  });
  sink = createTimingOutput(writable);
  expect(sink.write('native_timing', { type: 'first' })).toBe(true);
  expect(writable.write).toHaveBeenCalledTimes(1);
  expect(sink.stats).toEqual({ accepted: 1, rejected: 1, failed: 0 });
});
