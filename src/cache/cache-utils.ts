import { EventEmitter2 } from '@nestjs/event-emitter';
import { RedisClient } from 'bullmq';

export const NUMBER_OF_NONCE_KEYS_TO_CHECK = 50;
/**
 * Nonce keys have to get expired shortly so that if any of nonce numbers get skipped we would still have a way to
 * submit them after expiration
 */
export const NONCE_KEY_EXPIRE_SECONDS = 2;
const CHAIN_NONCE_KEY = 'chain:nonce';

export function getNonceKey(suffix: string) {
  return `${CHAIN_NONCE_KEY}:${suffix}`;
}

export function redisEventsToEventEmitter(client: RedisClient, eventEmitter: EventEmitter2) {
  client.on('error', (err) => {
    eventEmitter.emit('redis.error', err);
  });
  client.on('ready', () => {
    eventEmitter.emit('redis.ready');
  });
  client.on('close', () => {
    eventEmitter.emit('redis.close');
  });
}
