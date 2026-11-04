'use strict';
const { startTimingSnapshotTimer } = require('../src/services/TimingSnapshotTimer');

test('periodic snapshots are bounded, tolerate errors and stop on cleanup', () => {
  jest.useFakeTimers();
  const report = jest.fn().mockImplementationOnce(() => { throw new Error('diagnostic failure'); });
  try {
    const stop = startTimingSnapshotTimer(report, 30000);
    jest.advanceTimersByTime(29999);
    expect(report).not.toHaveBeenCalled();
    jest.advanceTimersByTime(30001);
    expect(report).toHaveBeenCalledTimes(2);
    stop();
    jest.advanceTimersByTime(60000);
    expect(report).toHaveBeenCalledTimes(2);
  } finally { jest.useRealTimers(); }
});
