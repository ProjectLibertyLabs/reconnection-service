import { DispatchError } from '@polkadot/types/interfaces';

export class EventError extends Error {
  name = '';

  message = '';

  stack?: string = '';

  section?: string = '';

  rawError: DispatchError;

  constructor(source: DispatchError) {
    super();

    if (source.isModule) {
      const decoded = source.registry.findMetaError(source.asModule);
      this.name = decoded.name;
      this.message = decoded.docs.join(' ');
      this.section = decoded.section;
    } else {
      this.name = source.type;
      this.message = source.type;
      this.section = '';
    }
    this.rawError = source;
  }

  public toString() {
    return `${this.section}.${this.name}: ${this.message}`;
  }
}
