import { Annotation, MessagesAnnotation } from '@langchain/langgraph';

/**
 * Represents the state of the retrieval graph / agent.
 */
export const AgentStateAnnotation = Annotation.Root({
  query: Annotation<string>(),
  route: Annotation<string>(),
  ...MessagesAnnotation.spec,

  /**
   * Set to true once the tool-calling loop has made one round trip, so the
   * graph caps itself at a single tool call and stays deterministic for demo
   * purposes rather than looping indefinitely.
   */
  toolCallCount: Annotation<number>({
    default: () => 0,
    reducer: (_prev, next) => next,
  }),

  // Additional attributes can be added here as needed
});
