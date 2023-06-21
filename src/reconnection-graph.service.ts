/*
https://docs.nestjs.com/providers#services
*/

import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ReconnectionConfigService } from './reconnection-config.service';
import { options } from "@frequency-chain/api-augment";
import { ApiPromise, HttpProvider, WsProvider } from '@polkadot/api';
import { u64 } from "@polkadot/types"

@Injectable()
export class ReconnectionGraphService implements OnApplicationBootstrap, OnApplicationShutdown {
    private api: ApiPromise;
    private logger: Logger;
    private type DsnpUserId = u64;

    constructor(private configService: ReconnectionConfigService) {
        this.logger = new Logger(ReconnectionGraphService.name);
    };

    async onApplicationBootstrap() {
        const chainUrl = this.configService.frequencyUrl;
        let provider: any;
        if (/^ws/.test(chainUrl.toString())) {
            provider = new WsProvider(chainUrl.toString());
        } else if (/^http/.test(chainUrl.toString())) {
            provider = new HttpProvider(chainUrl.toString());
        } else {
            this.logger.error(`Unrecognized chain URL type: ${chainUrl.toString()}`);
            throw "Unrecognized chain URL type";
        }
        this.api = await ApiPromise.create({ provider, ...options });
        await this.api.isReady;
        this.logger.log('Blockchain API ready.');
    }

    async onApplicationShutdown() {
        await this.api.disconnect();
    }

    update_user_graph(dsnpUserId: DsnpUserId, providerId: ProviderId, update_connections: bool) {

    }

    // TODO
    // Calling out to the provider to obtain a user's Provider graph
    // Calling out to the blockchain to obtain the user's DSNP Graph
    // Import the DSNP Graph into GraphSDK
    // Adding missing connections to the user's DSNP Graph using GraphSDK API
    // Export DSNP Graph changes and send to blockchain
    // Re-import DSNP Graph from chain & verify
    //     (if updating connections as well, do the same for connections--but do not transitively update connections - of - connections)
}
