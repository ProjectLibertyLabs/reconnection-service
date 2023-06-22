# Graph Reconnection Service
A microservice to reconnect graphs in DSNP/Frequency

## Overview/Design
The Graph Reconnection Service is designed to be hosted by a Provider inside their own environment. The service will scan the Frequency chain for new delegations to the Provider delegating Graph schema permissions for a user. The service then requests the user's Provider Graph and keys from the Provider, and updates the user's graph on-chain.

The following diagrams are intended as a guide for providers to understand how to work with DSNP's social graph.

For user relationships to be stored in a DSNP social graph, the users on both ends of the relationship must have DSNP accounts\nand have granted graph permission to the provider.

## Provider Flow
```mermaid
flowchart LR
    A(Ask wallet to\nauthorize account\ncreation) --> B(Create DSNP\nacccount)
    B -->|private graph| C(Ask wallet to generate\nsocial graph key and\nstore provider copy) --> E(Announce public key\nto chain) --> D
    B --->|public graph| D(done)
```

## Reconnection Service

### High-level flow
```mermaid
flowchart TD
pub1["Public Friend/Follow"] --- pub2(Create Graph\nData) --> pub3(Compress)
priFollow1["Private Follows"] --- priFollow2(Create Graph\nData) --> priFollow3(Compress) --> priFollow4(Encrypt)
priFriend1["Private Friends"] --- priFriend2(Create Graph\nData) --> priFriend3(Compress) --> priFriend4(Encrypt)
priFriend2 --> priFriend5(Create PRId Data)
```

### Sequence Diagram
```mermaid
sequenceDiagram;
Note left of P:Initial state:<br/>Alice <-MeWe-> Bob<br/>Alice <-MeWe-> Charlie<br/>Bob <-MeWe-> Charlie
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
  S->>+P: Request MeWe's DSNP graph for Alice;
  P->>-S: Provide Alice's Graph encryption keypair<br/>and connection list
  Note over P,S: Returned graph consists of all of Alice's connections<br/>who have migrated & opted in to Graph<br/>(in this case, empty, as neither Bob nor Charlie<br/>have migrated)
  S->>+F: Request Alice's DSNP Graph
  F->>-S: Provide Alice's DSNP Graph
  S->S: Decrypt Alice's Graph
  S->>F: Update & re-encrypt Alice's Graph as appropriate (no updates)
  Note over P:Bob delegates Graph permission to Provider
  P->>F: Add Graph schema permission delegation to Provider for Bob
  F->>S: (Service sees delegation event during chain scan)
  S->>+P: Request MeWe's DSNP graph for Bob;
  P->>-S: Provide Bob's Graph encryption keypair<br/>and connection list
  Note over P,S: Returned graph consists of all of Bob's connections<br/>who have migrated & opted in to Graph<br/>(in this case, [Alice])
  S->>+F: Request Bob's DSNP Graph
  F->>-S: Provide Bob's DSNP Graph
  S->S: Decrypt Bob's Graph
  S->>F: Update & re-encrypt Bob's Graph as appropriate (Alice added)
  Note left of P:State:<br/>Alice -MeWe> Bob<br/>Bob -DSNP> Alice<br/>Alice <-MeWe-> Charlie<br/>Bob <-MeWe-> Charlie
  loop Bob's connections (just Alice here)
  S->>+P: Request MeWe's DSNP graph for Alice
  P->>-S: Provide Alice's encryption keypair<br/>and connection list
  S->>+F: Request Alice's DSNP Graph
  F->>-S: Provide Alice's DSNP Graph
  S->S: Decrypt Alice's Graph
  S->>F: Update & re-encrypt Alice's Graph (Bob added)
  end
  Note left of P:State:<br/>Alice <-DSNP-> Bob<br/>Alice <-MeWe-> Charlie<br/>Bob <-MeWe-> Charlie
  Note over P:Charlie delegates Graph permission to Provider
  P->>F: Add Graph schema permission delegation to Provider for Charlie
  F->>S: (Service sees delegation event during chain scan)
  S->>+P: Request MeWe's DSNP graph for Charlie;
  P->>-S: Provide Charlie's Graph encryption keypair<br/>and connection list
  Note over P,S: Returned graph consists of all of Charlie's connections<br/>who have migrated & opted in to Graph<br/>(in this case, [Alice, Bob])
  S->>+F: Request Charlie's DSNP Graph
  F->>-S: Provide Charlie's DSNP Graph
  S->S: Decrypt Charlie's Graph
  S->>F: Update & re-encrypt Charlie's Graph as appropriate (Alice & Bob added)
  Note left of P:State:<br/>Alice <-DSNP-> Bob<br/>Alice -MeWe-> Charlie<br/>Bob -MeWe-> Charlie<br/>Charlie -DSNP-> Alice<br/>Charlie -DSNP-> Bob
  loop Chalie's connections ([Alice, Bob] here)
  S->>+P: Request MeWe's DSNP graph for <connection>
  P->>-S: Provide <connection>'s encryption keypair<br/>and connection list
  S->>+F: Request <connection>'s DSNP Graph
  F->>-S: Provide <connection>'s DSNP Graph
  S->S: Decrypt <connection>'s Graph
  S->>F: Update & re-encrypt <connection>'s Graph (Charlie added)
  end
  Note left of P:State:<br/>Alice <-DSNP-> Bob<br/>Alice <-DSNP-> Charlie<br/>Bob <-DSNP-> Charlie
```

## Handling External DSNP User Data Changes

```mermaid
flowchart LR
dspn1(Listen for User\nData Changed\nEvents) --> dsnp2{Is the\nowning\nuser on\nthis\nprovider?}
dsnp2 -->|yes| dsnp4{Is the\ntarget user\non this\nprovider?}
dsnp4 -->|yes| dsnp5("Apply deltas to\nprovider graph\n(using GraphSDK)")
dsnp2 -->|no| dsnp6(No action required)
dsnp4 -->|no| dsnp7(Show non-provider\nuser as an external\nDSNP user)
```
