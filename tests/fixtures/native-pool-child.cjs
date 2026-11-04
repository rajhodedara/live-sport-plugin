'use strict';

// Synthetic IPC child: no networking and no native transport.
process.once('message', message => {
  if (message.diagnostic) {
    process.send({ type: 'diagnostic', phase: 'request_received' });
    for (const [phase, childElapsedMs] of [['fetch_start', 3], ['response_received', 7], ['body_read_end', 12]]) {
      process.send({ type: 'diagnostic', phase, hop: 0, childElapsedMs });
    }
  }
  process.send({ type: 'result', status: 200, url: 'https://example.test/',
    headers: [], bytes: Buffer.from('fixture') });
});
