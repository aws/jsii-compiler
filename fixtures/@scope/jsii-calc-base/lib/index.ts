// NOTE: Intentionally mixing type imports with value imports. This syntax form
//       was added in TypeScript 4.5, and requires declarations down-leveling to
//       be supported by TypeScript 3.9 / jsii 1.x.
import {
  type IVeryBaseInterface,
  type VeryBaseProps,
  StaticConsumer as StaticConsumerBase,
} from '@scope/jsii-calc-base-of-base';

/**
 * A base class.
 */
export abstract class Base {
  /**
   * @returns the name of the class (to verify native type names are created for derived classes).
   */
  public typeName() {
    return (this.constructor as any).name;
  }
}

export interface BaseProps extends VeryBaseProps {
  readonly bar: string;
}

export interface IBaseInterface extends IVeryBaseInterface {
  bar(): void;
}

/**
 * Hides the transitive dependency of base-of-base
 */
export class StaticConsumer {
  public static consume(...args: any[]) {
    return StaticConsumerBase.consume(...args);
  }
}
