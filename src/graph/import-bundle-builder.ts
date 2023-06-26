import { GraphKeyType, GraphKeyPair, DsnpKeys, ImportBundle, PageData } from "@dsnp/graph-sdk";

export class ImportBundleBuilder {
    private static dsnpUserId: number;
    private static schemaId: number;
    private static keyPairs: GraphKeyPair[];
    private static dsnpKeys: DsnpKeys;
    private static pages: PageData[];
  
    static setDsnpUserId(dsnpUserId: number): typeof ImportBundleBuilder {
      ImportBundleBuilder.dsnpUserId = dsnpUserId;
      return this;
    }
  
    static setSchemaId(schemaId: number): typeof ImportBundleBuilder {
      ImportBundleBuilder.schemaId = schemaId;
      return this;
    }
  
    static addGraphKeyPair(keyType: GraphKeyType, publicKey: Uint8Array, secretKey: Uint8Array): typeof ImportBundleBuilder {
      ImportBundleBuilder.keyPairs.push({ keyType, publicKey, secretKey });
      return this;
    }
  
    static setDsnpKeys(dsnpKeys: DsnpKeys): typeof ImportBundleBuilder {
      ImportBundleBuilder.dsnpKeys = dsnpKeys;
      return this;
    }
  
    static addPageData(pageId: number, content: Uint8Array, contentHash: number): typeof ImportBundleBuilder {
      ImportBundleBuilder.pages.push({ pageId, content, contentHash });
      return this;
    }
  
    static build(): ImportBundle {
      const importBundle: ImportBundle = {
        dsnpUserId: ImportBundleBuilder.dsnpUserId,
        schemaId: ImportBundleBuilder.schemaId,
        keyPairs: ImportBundleBuilder.keyPairs,
        dsnpKeys: ImportBundleBuilder.dsnpKeys,
        pages: ImportBundleBuilder.pages,
      };
  
      // Reset the static properties for the next build
      ImportBundleBuilder.dsnpUserId = 0;
      ImportBundleBuilder.schemaId = 0;
      ImportBundleBuilder.keyPairs = [];
      ImportBundleBuilder.dsnpKeys = { dsnpUserId: 0, keysHash: 0, keys: [] };
      ImportBundleBuilder.pages = [];
  
      return importBundle;
    }
}
  