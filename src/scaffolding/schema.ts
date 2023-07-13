/* eslint-disable no-underscore-dangle */
import { SchemaId } from '@frequency-chain/api-augment/interfaces';

export type ModelTypeStr = 'AvroBinary' | 'Parquet';
export type PayloadLocationStr = 'OnChain' | 'Ipfs' | 'Itemized' | 'Paginated';
export type SchemaSettingStr = 'AppendOnly' | 'SignatureRequired';

export class Schema {
  private _id: SchemaId;

  private _model: {};

  private _modelType: ModelTypeStr;

  private _payloadLocation: PayloadLocationStr;

  private _settings: SchemaSettingStr[];

  constructor(id: SchemaId, model: {}, modelType: ModelTypeStr, payloadLocation: PayloadLocationStr, settings?: SchemaSettingStr[]) {
    this._model = model;
    this._modelType = modelType;
    this._payloadLocation = payloadLocation;
    this._settings = settings ?? [];
    this._id = id;
  }

  public get id() {
    return this._id;
  }

  public get model() {
    return this._model;
  }

  public get modelType() {
    return this._modelType;
  }

  public get payloadLocation() {
    return this._payloadLocation;
  }

  public get settings() {
    return this._settings;
  }
}
