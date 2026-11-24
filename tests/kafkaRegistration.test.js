'use strict';

const container = require('../src/container');
const KafkaProvider = require('../src/providers/KafkaProvider');
const { TrexCatalogStore } = require('../src/services/TrexCatalogStore');
const { TrexEventSearch } = require('../src/services/TrexEventSearch');

describe('Kafka Container Registration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.KAFKA_ENABLED;
    delete process.env.KAFKA_MANIFEST_URL;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('resolves kafkaProvider singleton from container', () => {
    const provider = container.resolve('kafkaProvider');
    expect(provider).toBeInstanceOf(KafkaProvider);
    expect(provider.sourceName).toBe('kafka');
    expect(provider.name).toBe('Kafka');
  });

  test('disabled by default when environment variables are unset', () => {
    const provider = container.resolve('kafkaProvider');
    expect(provider.configured).toBe(false);
  });

  test('registers the Trex catalog store and event search as singletons', () => {
    const store = container.resolve('trexCatalogStore');
    const eventSearch = container.resolve('trexEventSearch');

    expect(store).toBeInstanceOf(TrexCatalogStore);
    expect(eventSearch).toBeInstanceOf(TrexEventSearch);
    expect(container.resolve('trexCatalogStore')).toBe(store);
    expect(container.resolve('trexEventSearch')).toBe(eventSearch);
  });

  test('injects the store and event search into kafkaProvider', () => {
    const provider = container.resolve('kafkaProvider');

    expect(provider.catalogStore).toBe(container.resolve('trexCatalogStore'));
    expect(provider.eventSearch).toBe(container.resolve('trexEventSearch'));
  });
});
