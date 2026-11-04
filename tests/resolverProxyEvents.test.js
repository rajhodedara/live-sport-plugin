'use strict';
const { EventEmitter } = require('node:events');
const { createResolverProxyEvents } = require('../src/services/ResolverProxyEvents');

function response(headersSent = false) {
  const res = new EventEmitter();
  res.headersSent = headersSent; res.writableEnded = false; res.destroyed = false;
  res.send = jest.fn(); res.status = jest.fn(() => res); res.destroy = jest.fn();
  return res;
}

test('a later conflict destroys an in-flight upstream request and returns a generic 503', () => {
  const controller = new AbortController(), events = createResolverProxyEvents({ signal: () => controller.signal });
  const upstream = { destroy: jest.fn() }, res = response();
  events.proxyReq(upstream, { url: '/private?token=secret' }, res);
  controller.abort();
  expect(upstream.destroy).toHaveBeenCalledTimes(1);
  expect(res.status).toHaveBeenCalledWith(503);
  expect(res.send).toHaveBeenCalledWith('Internal stream resolver unavailable.');
  expect(JSON.stringify(res.send.mock.calls)).not.toMatch(/private|secret/);
});

test('an already detected conflict cancels immediately, including a started response', () => {
  const controller = new AbortController(); controller.abort();
  const events = createResolverProxyEvents({ signal: () => controller.signal });
  const upstream = { destroy: jest.fn() }, res = response(true);
  events.proxyReq(upstream, {}, res);
  expect(upstream.destroy).toHaveBeenCalledTimes(1);
  expect(res.destroy).toHaveBeenCalledTimes(1);
  expect(res.status).not.toHaveBeenCalled();
});

test('a completed response removes its cancellation listener', () => {
  const controller = new AbortController(), events = createResolverProxyEvents({ signal: () => controller.signal });
  const upstream = { destroy: jest.fn() }, res = response();
  events.proxyReq(upstream, {}, res);
  res.emit('close'); controller.abort();
  expect(upstream.destroy).not.toHaveBeenCalled();
});

test('an already closed client response stops the upstream request', () => {
  const events = createResolverProxyEvents({ signal: () => new AbortController().signal });
  const upstream = { destroy: jest.fn() }, res = response();
  res.destroyed = true;
  events.proxyReq(upstream, {}, res);
  expect(upstream.destroy).toHaveBeenCalledTimes(1);
  expect(res.listenerCount('close')).toBe(0);
});

test('a failing upstream destroy still returns a generic response', () => {
  const controller = new AbortController(), events = createResolverProxyEvents({ signal: () => controller.signal });
  const upstream = { destroy: jest.fn(() => { throw new Error('secret'); }) }, res = response();
  events.proxyReq(upstream, {}, res);
  expect(() => controller.abort()).not.toThrow();
  expect(res.status).toHaveBeenCalledWith(503);
  expect(JSON.stringify(res.send.mock.calls)).not.toContain('secret');
});

test('an invalid conflict signal fails closed without exposing its error', () => {
  const events = createResolverProxyEvents({ signal: () => null });
  const upstream = { destroy: jest.fn() }, res = response();
  expect(() => events.proxyReq(upstream, {}, res)).not.toThrow();
  expect(upstream.destroy).toHaveBeenCalledTimes(1);
  expect(res.status).toHaveBeenCalledWith(503);
});

test('proxy errors do not expose request URL or raw error message', () => {
  const events = createResolverProxyEvents({ signal: () => new AbortController().signal });
  const res = response();
  events.error(new Error('secret error'), { url: '/private?token=secret' }, res);
  expect(res.status).toHaveBeenCalledWith(502);
  expect(res.send).toHaveBeenCalledWith('Bad Gateway: Internal stream resolver is not responding.');
  expect(JSON.stringify(res.send.mock.calls)).not.toMatch(/secret|private/);
});
