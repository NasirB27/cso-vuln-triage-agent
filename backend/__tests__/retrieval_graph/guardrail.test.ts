import { AIMessage } from '@langchain/core/messages';
import { END } from '@langchain/langgraph';
import { executeTool, routeAfterTool } from '../../src/retrieval_graph/graph.js';
import { AgentStateAnnotation } from '../../src/retrieval_graph/state.js';

/**
 * These tests exercise the failure path directly: with no Supabase env vars
 * configured, both the direct-metadata read and the retriever fallback in
 * getCandidateScanDocuments() throw, so executeTool must catch that and
 * produce an honest AIMessage instead of crashing the graph or letting the
 * model hallucinate around a raw error.
 */
describe('executeTool guardrail', () => {
  const originalSupabaseUrl = process.env.SUPABASE_URL;
  const originalSupabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  beforeEach(() => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  afterAll(() => {
    if (originalSupabaseUrl !== undefined) {
      process.env.SUPABASE_URL = originalSupabaseUrl;
    }
    if (originalSupabaseKey !== undefined) {
      process.env.SUPABASE_SERVICE_ROLE_KEY = originalSupabaseKey;
    }
  });

  function stateWithPendingToolCall() {
    const aiMessage = new AIMessage({
      content: '',
      tool_calls: [
        {
          id: 'call_1',
          name: 'queryHardenedImages',
          args: { limit: 20, sortBy: 'severity' },
        },
      ],
    });

    return {
      query: 'what needs urgent attention?',
      route: 'triage',
      messages: [aiMessage],
      toolCallCount: 0,
    } as unknown as typeof AgentStateAnnotation.State;
  }

  it('produces a clear failure message instead of throwing when the vector store is unreachable', async () => {
    const state = stateWithPendingToolCall();

    const update = await executeTool(state, {});

    expect(update.messages).toHaveLength(1);
    const [message] = update.messages as AIMessage[];
    expect(message).toBeInstanceOf(AIMessage);
    expect(String(message.content).toLowerCase()).toContain("couldn't retrieve");
    expect(String(message.content)).not.toMatch(/CVE-\d{4}-\d+/);
  });

  it('caps the tool-call budget so the loop cannot retry indefinitely after a failure', async () => {
    const state = stateWithPendingToolCall();
    const update = await executeTool(state, {});
    expect(update.toolCallCount).toBe(1);
  });

  it('routes straight to END after a guardrail failure instead of looping back to the model', async () => {
    const state = stateWithPendingToolCall();
    const update = await executeTool(state, {});

    const nextState = {
      ...state,
      messages: [...state.messages, ...(update.messages as AIMessage[])],
    } as unknown as typeof AgentStateAnnotation.State;

    expect(routeAfterTool(nextState)).toBe(END);
  });

  it('throws if invoked without a pending tool call (programmer error, not a runtime guardrail case)', async () => {
    const state = {
      query: 'hi',
      route: 'triage',
      messages: [new AIMessage('no tool call here')],
      toolCallCount: 0,
    } as unknown as typeof AgentStateAnnotation.State;

    await expect(executeTool(state, {})).rejects.toThrow(
      /without a pending tool call/,
    );
  });
});
