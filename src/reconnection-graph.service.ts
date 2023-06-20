/*
https://docs.nestjs.com/providers#services
*/

import { Injectable } from '@nestjs/common';
import { ReconnectionConfigService } from './reconnection-config.service';

@Injectable()
export class ReconnectionGraphService {
    constructor(private configService: ReconnectionConfigService) {};

    // TODO
    // Calling out to the provider to obtain a user's Provider graph
    // Calling out to the blockchain to obtain the user's DSNP Graph
    // Import the DSNP Graph into GraphSDK
    // Adding missing connections to the user's DSNP Graph using GraphSDK API
    // Export DSNP Graph changes and send to blockchain
    // Re-import DSNP Graph from chain & verify
    //     (if updating connections as well, do the same for connections--but do not transitively update connections - of - connections)
}
