export namespace CacheUtils {
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
}
