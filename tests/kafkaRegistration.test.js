'use strict';

const container = require('../src/container');
const KafkaProvider = require('../src/providers/KafkaProvider');

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
});
