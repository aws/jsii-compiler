import { JsiiError } from './utils';

/**
 * Indicates which warnings are currently enabled. By default all warnings are
 * enabled, and can be silenced through the --silence-warning option.
 */
export const enabledWarnings = {
  'metadata/missing-readme': true,
  'metadata/missing-peer-dependency': true,
  'metadata/missing-dev-dependency': true,
  'jsii-directive/missing-argument': true,
  'jsii-directive/struct-on-non-interface': true,
  'jsii-directive/unknown': true,
  'typescript-config/disabled-tsconfig-validation': true,
  'language-compatibility/reserved-word': true,
  'language-compatibility/member-name-conflicts-with-type-name': true,
  'documentation/non-existent-parameter': true,
};

export const silenceWarnings = (warnings: string[]): void => {
  const legacyWarningKeyReplacement: { [key: string]: string } = {
    'reserved-word': 'language-compatibility/reserved-word',
  };
  const legacyWarningKeys = Object.keys(legacyWarningKeyReplacement);

  for (const key of warnings) {
    if (!(key in enabledWarnings) && !legacyWarningKeys.includes(key)) {
      throw new JsiiError(
        `Unknown warning type ${key as any}. Must be one of: ${Object.keys(enabledWarnings).join(', ')}`,
      );
    }

    if (legacyWarningKeys.includes(key)) {
      enabledWarnings[legacyWarningKeyReplacement[key] as keyof typeof enabledWarnings] = false;
    } else {
      enabledWarnings[key as keyof typeof enabledWarnings] = false;
    }
  }
};
