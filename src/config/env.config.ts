import Joi from 'joi';
import { ConfigModuleOptions } from '@nestjs/config';

export const configModuleOptions: ConfigModuleOptions = {
  isGlobal: true,
  validationSchema: Joi.object({
    REDIS_URL: Joi.string().uri().required(),
    FREQUENCY_URL: Joi.string().uri().required(),
    PROVIDER_BASE_URL: Joi.string().uri().required(),
    PROVIDER_USER_GRAPH_ENDPOINT: Joi.string().required(),
    PROVIDER_ACCESS_TOKEN: Joi.string().required(),
    BLOCKCHAIN_SCAN_INTERVAL_MINUTES: Joi.number()
      .min(1)
      .default(3 * 60),
    QUEUE_HIGH_WATER: Joi.number().min(100).default(1000),
  }),
};
