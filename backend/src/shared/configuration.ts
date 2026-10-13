/**
 * Define the configurable parameters for the agent.
 */

import { Annotation } from '@langchain/langgraph';
import { RunnableConfig } from '@langchain/core/runnables';

export const RETRIEVER_PROVIDERS = ['supabase', 'pgvector'] as const;
export type RetrieverProvider = (typeof RETRIEVER_PROVIDERS)[number];

/**
 * Resolves the vector store provider: an explicit per-run value wins, then the
 * RETRIEVER_PROVIDER environment variable (how the AWS deployment selects
 * 'pgvector'), then 'supabase'. Unknown values throw instead of silently
 * falling back, so a typo can't point the agent at the wrong store.
 */
export function resolveRetrieverProvider(
  configured?: string,
  env: NodeJS.ProcessEnv = process.env,
): RetrieverProvider {
  const value = configured || env.RETRIEVER_PROVIDER || 'supabase';
  if (!(RETRIEVER_PROVIDERS as readonly string[]).includes(value)) {
    throw new Error(
      `Unsupported retriever provider: ${value}. Expected one of: ${RETRIEVER_PROVIDERS.join(', ')}`,
    );
  }
  return value as RetrieverProvider;
}

/**
 * typeof ConfigurationAnnotation.State class for indexing and retrieval operations.
 *
 * This annotation defines the parameters needed for configuring the indexing and
 * retrieval processes, including user identification, embedding model selection,
 * retriever provider choice, and search parameters.
 */
export const BaseConfigurationAnnotation = Annotation.Root({
  /**
   * The vector store provider to use for retrieval.
   * Options are 'supabase' and 'pgvector' (RDS/Aurora PostgreSQL on AWS); add more providers here
   * and create their own retriever functions.
   */
  retrieverProvider: Annotation<RetrieverProvider>,

  /**
   * Additional keyword arguments to pass to the search function of the retriever for filtering.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  filterKwargs: Annotation<Record<string, any>>,

  /**
   * The number of documents to retrieve.
   */
  k: Annotation<number>,
});

/**
 * Create an typeof BaseConfigurationAnnotation.State instance from a RunnableConfig object.
 *
 * @param config - The configuration object to use.
 * @returns An instance of typeof BaseConfigurationAnnotation.State with the specified configuration.
 */
export function ensureBaseConfiguration(
  config: RunnableConfig,
): typeof BaseConfigurationAnnotation.State {
  const configurable = (config?.configurable || {}) as Partial<
    typeof BaseConfigurationAnnotation.State
  >;
  return {
    retrieverProvider: resolveRetrieverProvider(configurable.retrieverProvider),
    filterKwargs: configurable.filterKwargs || {},
    k: configurable.k || 5,
  };
}
