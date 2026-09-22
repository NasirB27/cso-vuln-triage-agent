import { StateGraph, START, END } from '@langchain/langgraph';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { RunnableConfig } from '@langchain/core/runnables';
import { z } from 'zod';

import { AgentStateAnnotation } from './state.js';
import { AGENT_SYSTEM_PROMPT, DIRECT_ANSWER_SYSTEM_PROMPT } from './prompts.js';
import { makeQueryHardenedImagesTool } from './tools.js';
import {
  AgentConfigurationAnnotation,
  ensureAgentConfiguration,
} from './configuration.js';
import { loadChatModel } from '../shared/utils.js';

const MAX_TOOL_CALLS = 1;

const INTENT_CLASSIFIER_PROMPT = `You classify a user's question for a hardened-image vulnerability triage assistant.
Respond "triage" if the question is about vulnerabilities, hardened images, CVEs, severities, or what needs attention — anything that would require looking up scan data.
Respond "direct" only for questions that are clearly NOT about this organization's images or scans (e.g. "what does CVSS mean?", general security concepts, small talk).
When in doubt, choose "triage".`;

/**
 * Cheap upfront classification so genuinely non-triage questions (e.g.
 * "what does CVSS mean?") skip the tool-calling loop entirely, while
 * everything else goes through queryHardenedImages.
 */
async function classifyIntent(
  state: typeof AgentStateAnnotation.State,
  config: RunnableConfig,
): Promise<typeof AgentStateAnnotation.Update> {
  const configuration = ensureAgentConfiguration(config);
  const model = await loadChatModel(configuration.queryModel);
  const schema = z.object({ route: z.enum(['triage', 'direct']) });

  const response = await model
    .withStructuredOutput(schema)
    .invoke([
      { role: 'system', content: INTENT_CLASSIFIER_PROMPT },
      { role: 'human', content: state.query },
    ]);

  return { route: response.route };
}

function routeByIntent(
  state: typeof AgentStateAnnotation.State,
): 'agentStep' | 'directAnswer' {
  return state.route === 'direct' ? 'directAnswer' : 'agentStep';
}

/**
 * The tool-calling step: binds queryHardenedImages to the chat model and
 * lets the model decide whether/how to call it, per AGENT_SYSTEM_PROMPT.
 */
async function agentStep(
  state: typeof AgentStateAnnotation.State,
  config: RunnableConfig,
): Promise<typeof AgentStateAnnotation.Update> {
  const configuration = ensureAgentConfiguration(config);
  const model = await loadChatModel(configuration.queryModel);
  const tool = makeQueryHardenedImagesTool(config);
  if (!model.bindTools) {
    throw new Error(
      `Model "${configuration.queryModel}" does not support tool calling.`,
    );
  }
  const modelWithTools = model.bindTools([tool]);

  const isFirstStep = state.messages.length === 0;
  const priorMessages = isFirstStep
    ? [new HumanMessage(state.query)]
    : state.messages;

  const formattedPrompt = await AGENT_SYSTEM_PROMPT.invoke({
    messages: priorMessages,
  });

  const response = await modelWithTools.invoke(formattedPrompt);

  return {
    messages: isFirstStep ? [...priorMessages, response] : [response],
  };
}

/**
 * Executes the queryHardenedImages tool call the model requested. On
 * failure (e.g. the vector store is unreachable), this produces an honest
 * failure message directly instead of handing an error back to the model,
 * which could otherwise be tempted to guess at an answer.
 */
async function executeTool(
  state: typeof AgentStateAnnotation.State,
  config: RunnableConfig,
): Promise<typeof AgentStateAnnotation.Update> {
  const lastMessage = state.messages[state.messages.length - 1] as AIMessage;
  const toolCall = lastMessage.tool_calls?.[0];

  if (!toolCall) {
    throw new Error('executeTool called without a pending tool call.');
  }

  const tool = makeQueryHardenedImagesTool(config);

  try {
    const result = await tool.invoke(toolCall);
    return {
      messages: [result as ToolMessage],
      toolCallCount: state.toolCallCount + 1,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const failureMessage = new AIMessage(
      `I couldn't retrieve the hardened image scan data (${reason}). Please check the vector store connection and try again — I won't guess at severity or CVE details without the underlying scan data.`,
    );
    return {
      messages: [failureMessage],
      toolCallCount: MAX_TOOL_CALLS, // force the loop to stop
    };
  }
}

async function answerQueryDirectly(
  state: typeof AgentStateAnnotation.State,
  config: RunnableConfig,
): Promise<typeof AgentStateAnnotation.Update> {
  const configuration = ensureAgentConfiguration(config);
  const model = await loadChatModel(configuration.queryModel);
  const userHumanMessage = new HumanMessage(state.query);

  const formattedPrompt = await DIRECT_ANSWER_SYSTEM_PROMPT.invoke({
    query: state.query,
  });
  const response = await model.invoke(formattedPrompt);
  return { messages: [userHumanMessage, response] };
}

/**
 * Routes after the agent step: if the model asked to call the tool and we
 * haven't already spent our tool-call budget, execute it; otherwise the
 * model's response is the final answer.
 */
function routeAfterAgent(
  state: typeof AgentStateAnnotation.State,
): 'executeTool' | typeof END {
  const lastMessage = state.messages[state.messages.length - 1] as AIMessage;
  const hasToolCall = (lastMessage.tool_calls?.length ?? 0) > 0;

  if (hasToolCall && state.toolCallCount < MAX_TOOL_CALLS) {
    return 'executeTool';
  }
  return END;
}

/**
 * After executing the tool, let the model turn the ToolMessage into one
 * final natural-language answer — unless executeTool already short-circuited
 * with a guardrail failure message (an AIMessage), which IS the final answer.
 */
function routeAfterTool(
  state: typeof AgentStateAnnotation.State,
): 'agentStep' | typeof END {
  const lastMessage = state.messages[state.messages.length - 1];
  if (lastMessage instanceof AIMessage) {
    return END;
  }
  return 'agentStep';
}

const builder = new StateGraph(
  AgentStateAnnotation,
  AgentConfigurationAnnotation,
)
  .addNode('classifyIntent', classifyIntent)
  .addNode('agentStep', agentStep)
  .addNode('executeTool', executeTool)
  .addNode('directAnswer', answerQueryDirectly)
  .addEdge(START, 'classifyIntent')
  .addConditionalEdges('classifyIntent', routeByIntent, [
    'agentStep',
    'directAnswer',
  ])
  .addConditionalEdges('agentStep', routeAfterAgent, ['executeTool', END])
  .addConditionalEdges('executeTool', routeAfterTool, ['agentStep', END])
  .addEdge('directAnswer', END);

export const graph = builder.compile().withConfig({
  runName: 'RetrievalGraph',
});

// Exported for unit testing individual nodes/routers without invoking a live
// chat model or vector store for every case.
export { executeTool, routeAfterAgent, routeAfterTool, routeByIntent };
