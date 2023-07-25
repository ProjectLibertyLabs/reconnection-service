# Graph Reconnection Service
A microservice to reconnect graphs in DSNP/Frequency

## Overview/Design
The Graph Reconnection Service is designed to be hosted by a Provider inside their own environment. The service will scan the Frequency chain for new delegations to the Provider delegating Graph schema permissions for a user. The service then requests the user's Provider Graph and keys from the Provider, and updates the user's graph on-chain.

The following diagrams are intended as a guide for providers to understand how to work with DSNP's social graph.

For user relationships to be stored in a DSNP social graph, the users on both ends of the relationship must have DSNP accounts and have granted graph permission to the provider.

## Installation and Deployment

For instructions on downloading and installing/deploying the application, see [here](./INSTALLING.md)

## Provider Flow

This flow must be implemented between the Provider and a Wallet. It is outside the purview of the Graph Reconnection Service, but must be completed for a user before that user's graph can be migrated.

```mermaid
flowchart LR
    A(Ask wallet to\nauthorize account\ncreation) --> B(Create DSNP\nacccount)
    B -->|private graph| C(Ask wallet to generate\nsocial graph key and\nstore provider copy) --> E(Announce public key\nto chain) --> D
    B --->|public graph| D(done)
```

## Reconnection Service

### Graph Update Flow to Blockchain
The following diagram illustrates the differences in what is required to update a user's graph on-chain for different types of graphs: Public vs. Private, and Follow vs. Friendship. As shown, Private graph updates require the user's graph encryption keys, as Private graph data is stored encrypted on-chain. An additional requirement for Private Friendship also requires the counterparty's public graph encryption key. This enables the construction of a shared secret, a PRId, which is used to securely represent the connection in a public way. (The PRId is stored publicly on-chain, but the other side of the connection cannot be derived from it.)

```mermaid
flowchart TD
pub1["Public Follow"] --- pub2(Create Graph\nData) --> pub3(Compress)
priFollow1["Private Follows"] --- priFollow2(Create Graph\nData) --> priFollow3(Compress) --> priFollow4(Encrypt)
priFriend1["Private Friends"] --- priFriend2(Create Graph\nData) --> priFriend3(Compress) --> priFriend4(Encrypt)
priFriend2 --> priFriend5(Create PRId Data)
```

### Sequence Diagram
The following sequence diagram illustrates an example event flow where three users (Alice, Bob, and Charlie), who are all mutually friends, onboard to DSNP at different times & have their social graphs migrated to DSNP in stages.
```mermaid
sequenceDiagram;
Note left of P:Initial state:<br/>Alice <-Provider-> Bob<br/>Alice <-Provider-> Charlie<br/>Bob <-Provider-> Charlie
  box Provider Environment
    participant P as Provider;
    participant S as Provider-hosted Reconnection Service;
  end
  box Blockchain
    participant F as Frequency;
  end
  Note over P:Alice delegates Graph permission to Provider<br/>(This may happen during DSNP<br/>migration or subsequently)
  P->>F: Add Graph schema permission delegation to Provider for Alice
  F->>S: (Service sees delegation event during chain scan)
  S->>+P: Request Provider's DSNP graph for Alice;
  P->>-S: Provide Alice's Graph encryption keypair<br/>and connection list
  Note over P,S: Returned graph consists of all of Alice's connections<br/>who have migrated & opted in to Graph<br/>(in this case, empty, as neither Bob nor Charlie<br/>have migrated)
  S->>+F: Request Alice's DSNP Graph
  F->>-S: Provide Alice's DSNP Graph
  S->S: Decrypt Alice's Graph
  S->>F: Update & re-encrypt Alice's Graph as appropriate (no updates)
  Note over P:Bob delegates Graph permission to Provider
  P->>F: Add Graph schema permission delegation to Provider for Bob
  F->>S: (Service sees delegation event during chain scan)
  S->>+P: Request Provider's DSNP graph for Bob;
  P->>-S: Provide Bob's Graph encryption keypair<br/>and connection list
  Note over P,S: Returned graph consists of all of Bob's connections<br/>who have migrated & opted in to Graph<br/>(in this case, [Alice])
  S->>+F: Request Bob's DSNP Graph
  F->>-S: Provide Bob's DSNP Graph
  S->S: Decrypt Bob's Graph
  S->>F: Update & re-encrypt Bob's Graph as appropriate (Alice added)
  Note left of P:State:<br/>Alice -Provider> Bob<br/>Bob -DSNP> Alice<br/>Alice <-Provider-> Charlie<br/>Bob <-Provider-> Charlie
  loop Bob's connections (just Alice here)
  S->>+P: Request Provider's DSNP graph for Alice
  P->>-S: Provide Alice's encryption keypair<br/>and connection list
  S->>+F: Request Alice's DSNP Graph
  F->>-S: Provide Alice's DSNP Graph
  S->S: Decrypt Alice's Graph
  S->>F: Update & re-encrypt Alice's Graph (Bob added)
  end
  Note left of P:State:<br/>Alice <-DSNP-> Bob<br/>Alice <-Provider-> Charlie<br/>Bob <-Provider-> Charlie
  Note over P:Charlie delegates Graph permission to Provider
  P->>F: Add Graph schema permission delegation to Provider for Charlie
  F->>S: (Service sees delegation event during chain scan)
  S->>+P: Request Provider's DSNP graph for Charlie;
  P->>-S: Provide Charlie's Graph encryption keypair<br/>and connection list
  Note over P,S: Returned graph consists of all of Charlie's connections<br/>who have migrated & opted in to Graph<br/>(in this case, [Alice, Bob])
  S->>+F: Request Charlie's DSNP Graph
  F->>-S: Provide Charlie's DSNP Graph
  S->S: Decrypt Charlie's Graph
  S->>F: Update & re-encrypt Charlie's Graph as appropriate (Alice & Bob added)
  Note left of P:State:<br/>Alice <-DSNP-> Bob<br/>Alice -Provider-> Charlie<br/>Bob -Provider-> Charlie<br/>Charlie -DSNP-> Alice<br/>Charlie -DSNP-> Bob
  loop Chalie's connections ([Alice, Bob] here)
  S->>+P: Request Provider's DSNP graph for <connection>
  P->>-S: Provide <connection>'s encryption keypair<br/>and connection list
  S->>+F: Request <connection>'s DSNP Graph
  F->>-S: Provide <connection>'s DSNP Graph
  S->S: Decrypt <connection>'s Graph
  S->>F: Update & re-encrypt <connection>'s Graph (Charlie added)
  end
  Note left of P:State:<br/>Alice <-DSNP-> Bob<br/>Alice <-DSNP-> Charlie<br/>Bob <-DSNP-> Charlie
```

## Other Graph Scenarios
### Handling External DSNP User Data Changes
Though outside the responsibility of the Graph Reconnection Service, it's relevant to understand how a provider application might incorporate changes made by other actors on the blockchain into their own platform.

When a user's graph is modified (whether by themselves or another provider to whom permission has been delegated), a page updated event is published on the blockchain. By correlating the schema ID contained in this event with the known schema IDs for the social graph, a provider can determine whether a user's graph has been updated, and synchronize the authoritative blockchain version of the graph with their own internal representation.

```mermaid
flowchart LR
dspn1(Listen for\nPaginatedPageUpdated\nevents on-chain) --> dsnp2{Is the\nowning\nuser on\nthis\nprovider?}
dsnp2 -->|yes| dsnp3(Read user's graph\nfrom chain\nand import to GraphSDK)
dsnp3 --> dsnp4{Is the\ntarget user\non this\nprovider?}
dsnp4 -->|yes| dsnp5("Apply deltas to\nprovider graph")
dsnp2 -->|no| dsnp6(No action required)
dsnp4 -->|no| dsnp7(Show non-provider\nuser as an external\nDSNP user)
```
