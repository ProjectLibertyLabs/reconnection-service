import { GraphKeyType, GraphKeyPair, DsnpKeys, ImportBundle, PageData } from "@dsnp/graph-sdk";

export class ImportBundleBuilder {
  private importBundle: ImportBundle;

  constructor() {
    this.importBundle = {
      dsnpUserId: 0,
      schemaId: 0,
      keyPairs: [],
      dsnpKeys: {
        dsnpUserId: 0,
        keysHash: 0,
        keys: [],
      },
      pages: [],
    };
  }

  public setDsnpUserId(dsnpUserId: number): ImportBundleBuilder {
    this.importBundle.dsnpUserId = dsnpUserId;
    return this;
  }

  public setSchemaId(schemaId: number): ImportBundleBuilder {
    this.importBundle.schemaId = schemaId;
    return this;
  }

  public addGraphKeyPair(keyType: GraphKeyType, publicKey: Uint8Array, secretKey: Uint8Array): ImportBundleBuilder {
    const graphKeyPair: GraphKeyPair = {
      keyType,
      publicKey,
      secretKey,
    };
    this.importBundle.keyPairs.push(graphKeyPair);
    return this;
  }

  public setDsnpKeys(dsnpKeys: DsnpKeys): ImportBundleBuilder {
    this.importBundle.dsnpKeys = dsnpKeys;
    return this;
  }

  public addPageData(pageId: number, content: Uint8Array, contentHash: number): ImportBundleBuilder {
    const pageData: PageData = {
      pageId,
      content,
      contentHash,
    };
    this.importBundle.pages.push(pageData);
    return this;
  }

  public build(): ImportBundle {
    return this.importBundle;
  }
}
