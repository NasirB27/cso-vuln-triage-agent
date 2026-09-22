import { Annotation } from '@langchain/langgraph';
import { RunnableConfig } from '@langchain/core/runnables';
import {
  BaseConfigurationAnnotation,
  ensureBaseConfiguration,
} from '../shared/configuration.js';

// Directory of mock hardened-image vulnerability scan JSON records, generated
// by `src/scripts/generate_mock_scans.ts`. See that script for provenance —
// this data is synthetic and for demo purposes only.
const DEFAULT_SCANS_DIRECTORY = './src/sample_scans';

/**
 * The configuration for the indexing process.
 */
export const IndexConfigurationAnnotation = Annotation.Root({
  ...BaseConfigurationAnnotation.spec,

  /**
   * Path to a directory of hardened-image vulnerability scan JSON files to index.
   */
  scansDirectory: Annotation<string>,
  useSampleScans: Annotation<boolean>,
});

/**
 * Create an typeof IndexConfigurationAnnotation.State instance from a RunnableConfig object.
 *
 * @param config - The configuration object to use.
 * @returns An instance of typeof IndexConfigurationAnnotation.State with the specified configuration.
 */
export function ensureIndexConfiguration(
  config: RunnableConfig,
): typeof IndexConfigurationAnnotation.State {
  const configurable = (config?.configurable || {}) as Partial<
    typeof IndexConfigurationAnnotation.State
  >;

  const baseConfig = ensureBaseConfiguration(config);

  return {
    ...baseConfig,
    scansDirectory: configurable.scansDirectory || DEFAULT_SCANS_DIRECTORY,
    useSampleScans: configurable.useSampleScans || false,
  };
}
