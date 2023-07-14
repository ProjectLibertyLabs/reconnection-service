export namespace env {
  export const providerUrl = process.env.WS_PROVIDER_URL;
  export const verbose = process.env.VERBOSE === 'true' || process.env.VERBOSE === '1';
}
