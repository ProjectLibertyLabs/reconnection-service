import Joi from 'joi';
import { ConfigModuleOptions } from '@nestjs/config';
import { mnemonicValidate } from '@polkadot/util-crypto';
import { ValidationError } from 'class-validator';

// eslint-disable-next-line no-useless-escape
const devUriRegEx = /^\/\/(Alice|Bob|Charlie|Dave|Eve|Ferdie)(\/[\/]?\d+)?$/;

const bigintSchema = Joi.custom((value) => {
  const strResult = Joi.string().validate(value);
  if (strResult.error) {
    throw strResult.error;
  }

  const numResult = Joi.number().unsafe().positive().validate(value);
  if (numResult.error) {
    throw numResult.error;
  }

  return BigInt(value);
});

const capacityLimitSchema = Joi.object({
  type: Joi.any().valid('percentage', 'amount').required(),
  value: Joi.any().when('type', { is: 'percentage', then: Joi.number().positive().max(100), otherwise: bigintSchema }),
});

const capacityLimitsSchema = Joi.object({
  serviceLimit: capacityLimitSchema.required(),
  totalLimit: capacityLimitSchema,
});

export const configModuleOptions: ConfigModuleOptions = {
  isGlobal: true,
  validationSchema: Joi.object({
    API_PORT: Joi.number().min(1025).max(65535).default(3000),
    REDIS_URL: Joi.string().uri().required(),
    FREQUENCY_URL: Joi.string().uri().required(),
    PROVIDER_ID: bigintSchema.required(),
    PROVIDER_BASE_URL: Joi.string().uri().required(),
    PROVIDER_ACCESS_TOKEN: Joi.string(),
    BLOCKCHAIN_SCAN_INTERVAL_MINUTES: Joi.number()
      .min(1)
      .default(3 * 60),
    QUEUE_HIGH_WATER: Joi.number().min(100).default(1000),
    PROVIDER_ACCOUNT_SEED_PHRASE: Joi.string()
      .required()
      .custom((value: string, helpers) => {
        if (process.env?.ENVIRONMENT === 'dev' && devUriRegEx.test(value)) {
          return value;
        }
        if (!mnemonicValidate(value)) {
          return helpers.error('any.invalid');
        }
        return value;
      }),
    WEBHOOK_FAILURE_THRESHOLD: Joi.number().min(1).default(3),
    WEBHOOK_RETRY_INTERVAL_SECONDS: Joi.number().min(1).default(10),
    HEALTH_CHECK_SUCCESS_THRESHOLD: Joi.number().min(1).default(10),
    HEALTH_CHECK_MAX_RETRY_INTERVAL_SECONDS: Joi.number().min(1).default(64),
    HEALTH_CHECK_MAX_RETRIES: Joi.number().min(0).default(20),
    GRAPH_ENVIRONMENT_TYPE: Joi.string().required().valid('Mainnet', 'TestnetPaseo', 'Dev'),
    // GRAPH_ENVIRONMENT_DEV_CONFIG is optional, but if it is set, it must be a valid JSON string
    GRAPH_ENVIRONMENT_DEV_CONFIG: Joi.string().when('GRAPH_ENVIRONMENT_TYPE', {
      is: 'Dev',
      then: Joi.string()
        .required()
        .custom((value: string, helpers) => {
          try {
            JSON.parse(value);
          } catch (e) {
            return helpers.error('any.invalid');
          }
          return value;
        }),
    }),
    CAPACITY_LIMIT: Joi.string()
      .custom((value: string, helpers) => {
        try {
          const obj = JSON.parse(value);

          const result1 = capacityLimitSchema.validate(obj);
          const result2 = capacityLimitsSchema.validate(obj);

          if (obj?.type && result1.error) {
            return helpers.error('any.custom', { error: result1.error });
          }

          if (obj?.serviceLimit && result2.error) {
            throw result2.error;
          }

          if (result1.error && result2.error) {
            return helpers.error('any.custom', { error: new Error('JSON object does not conform to the required structure') });
          }
        } catch (e) {
          if (e instanceof ValidationError) {
            throw e;
          }

          return helpers.error('any.custom', { error: e });
        }

        return value;
      })
      .required(),
    FREQUENCY_TX_TIMEOUT_SECONDS: Joi.number().min(12).default(60),
    CONNECTIONS_PER_PROVIDER_RESPONSE_PAGE: Joi.number().min(1).default(100),
  }),
};
