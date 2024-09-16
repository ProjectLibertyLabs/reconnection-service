# Graph Reconnection Service

Reconnection Service provides a way for Providers who are _migrating_ their userbase to [Frequency](https://www.frequency.xyz) to easily handle the graph updates as users opt into the migration.

The service scans the Frequency chain for new delegations for the Provider. It then requests, via a Provider's API, the user's Graph keys and the Provider's graph and proceeds to update the migrated user's graph **and** the graph of previously migrated users connected to the newly migrated user.

See [https://github.com/ProjectLibertyLabs/reconnection-service](https://github.com/ProjectLibertyLabs/reconnection-service) for more details and information.

## Docker Tags

### `apponly`

Requires an external Redis server setup and configured with the Environment variable: `REDIS_URL`.

### `standalone`

Has a built in Redis server and you must *NOT* override via `REDIS_URL`.

## Environment Variables

The complete set of environment variables is [documented here](https://github.com/ProjectLibertyLabs/reconnection-service/blob/main/ENVIRONMENT.md), and there is a [sample environment file](https://github.com/ProjectLibertyLabs/reconnection-service/blob/main/env.template).
