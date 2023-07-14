import { SchemaId, SchemaResponse } from '@frequency-chain/api-augment/interfaces';
import { AnyNumber } from '@polkadot/types/types';
import { KeyringPair } from '@polkadot/keyring/types';
import { firstValueFrom } from 'rxjs';
import { ModelTypeStr, PayloadLocationStr, Schema, SchemaSettingStr } from './schema';
import { ExtrinsicHelper } from './extrinsicHelpers';
import { devAccounts } from './helpers';

export interface ISchemaBuilder {
  id?: SchemaId | AnyNumber;
  model?: {};
  modelType?: ModelTypeStr;
  payloadLocation?: PayloadLocationStr;
  setting?: SchemaSettingStr;
  autodetectExisting?: boolean;
}

export class SchemaBuilder {
  private values: ISchemaBuilder = {};

  private existingSchemaMap: Map<number, SchemaResponse> = new Map();

  constructor(values?: ISchemaBuilder) {
    if (values !== undefined) {
      Object.assign(this.values, values);
    }
  }

  public withModel(model: {}): SchemaBuilder {
    return new SchemaBuilder({ ...this.values, id: undefined, model });
  }

  public withModelType(modelType: ModelTypeStr): SchemaBuilder {
    return new SchemaBuilder({ ...this.values, id: undefined, modelType });
  }

  public withPayloadLocation(payloadLocation: PayloadLocationStr): SchemaBuilder {
    return new SchemaBuilder({ ...this.values, id: undefined, payloadLocation });
  }

  public withSetting(setting: SchemaSettingStr): SchemaBuilder {
    return new SchemaBuilder({ ...this.values, id: undefined, setting });
  }

  // eslint-disable-next-line class-methods-use-this
  public withExistingSchemaId(id: SchemaId | AnyNumber): SchemaBuilder {
    return new SchemaBuilder({ id });
  }

  public withAutoDetectExistingSchema(autodetectExisting = true) {
    return new SchemaBuilder({ ...this.values, autodetectExisting });
  }

  private schemaMatches(schema: SchemaResponse): boolean {
    const settings = schema.settings.toArray();
    const settingsStr = JSON.stringify(settings);
    const thisStr = JSON.stringify(this.values.setting ? [this.values.setting] : []);
    return (
      schema.model.toUtf8() === JSON.stringify(this.values.model) &&
      schema.model_type.type === this.values.modelType &&
      schema.payload_location.type === this.values.payloadLocation &&
      JSON.stringify(schema.settings.toArray()) === JSON.stringify(this.values.setting ? [this.values.setting] : [])
    );
  }

  public async build(delegatorKeys: KeyringPair): Promise<Schema> {
    // If no id, we're creating a new schema on-chain
    if (this.values.id === undefined) {
      if ([this.values.model, this.values.modelType, this.values.payloadLocation].some((attr) => attr === undefined)) {
        throw new Error('Missing attribute(s) for schema creation');
      }

      let event: any;

      // Try to auto-detect ID of existing schema
      if (this.values.autodetectExisting) {
        const maxSchemas = (await firstValueFrom(ExtrinsicHelper.api.query.schemas.currentSchemaIdentifierMaximum())).toNumber();
        for (let i = 1; i <= maxSchemas; i += 1) {
          let schema: SchemaResponse;
          if (!this.existingSchemaMap.has(i)) {
            // eslint-disable-next-line no-await-in-loop
            schema = (await firstValueFrom(ExtrinsicHelper.api.rpc.schemas.getBySchemaId(i))).unwrap();
            this.existingSchemaMap.set(i, schema);
          } else {
            schema = this.existingSchemaMap.get(i)!;
          }

          if (this.schemaMatches(schema)) {
            return new Schema(schema.schema_id, schema.model, schema.model_type.type, schema.payload_location.type, []);
          }
        }
      }

      if (this.values.setting !== undefined) {
        [event] = await ExtrinsicHelper.createSchemaWithSettingsGov(
          delegatorKeys,
          devAccounts[0].keys,
          this.values.model,
          this.values.modelType!,
          this.values.payloadLocation!,
          this.values.setting!,
        ).sudoSignAndSend();
      } else {
        [event] = await ExtrinsicHelper.createSchema(delegatorKeys, this.values.model, this.values.modelType!, this.values.payloadLocation!).fundAndSend();
      }
      if (!event || !ExtrinsicHelper.api.events.schemas.SchemaCreated.is(event)) {
        throw new Error('Schema not created');
      }

      return new Schema(event.data.schemaId, this.values.model!, this.values.modelType!, this.values.payloadLocation!, this.values.setting ? [this.values.setting] : []);
    }

    // otherwise, use an existing schema id to retrieve the details of a schema from the chain
    const response = await firstValueFrom(ExtrinsicHelper.api.rpc.schemas.getBySchemaId(this.values.id));
    if (response.isEmpty) {
      throw new Error(`No schema with id ${this.values.id}`);
    }
    const schema: SchemaResponse = response.unwrap();
    return new Schema(
      schema.schema_id,
      schema.model,
      schema.model_type.type,
      schema.payload_location.type,
      schema.settings.toArray().map((setting) => setting.type),
    );
  }
}
