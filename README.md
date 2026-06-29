# Build a Serverless Image Editing Agent with Amazon Bedrock AgentCore harness

Building an AI agent that edits images based on natural language requires an orchestration loop, tool routing, memory management, and a compute environment to run it all. [Amazon Bedrock AgentCore harness](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness.html) handles that entire stack with configuration. You declare what the agent does, and the harness runs it in a stateful, isolated microVM with built-in memory, tool routing, and observability.

This post walks through building a serverless image editor where users upload a photo, describe an edit in plain English, and receive the result in seconds. The agent runs on AgentCore harness without custom orchestration code. We deploy the full solution, including authentication, encrypted storage, three image editing tools, and a React frontend, with a single deployment command. The infrastructure is defined using [AWS Cloud Development Kit (AWS CDK)](https://aws.amazon.com/cdk/).

## Image editing application

The application accepts prompts like "change the car color to blue" or "extend the image 200 pixels to the right." An agent powered by [Claude Sonnet 4.6](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-4-6.html) breaks the requirement into a series of steps and orchestrates the tool calling, each associated with a different [Stability AI](https://docs.aws.amazon.com/bedrock/latest/userguide/model-cards-stability-ai.html) model. Then it executes the edit, applies a watermark using a shell command on the microVM (no token cost), and returns the result.

This application demonstrates the following AgentCore harness capabilities:

- **Configuration-driven agent creation.** The agent is defined entirely through API parameters. No Python orchestration code, no framework, no container.
- **Per-invocation model switching.** The frontend routes basic chat to [Claude Haiku 4.5](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-haiku-4-5.html) and edits to Claude Sonnet 4.6. The agent preserves conversation context across model switches.
- **Per-invocation persona override.** Users select industry personas (Real Estate, Retail, Automotive) that inject domain-specific system prompts without redeploying.
- **AgentCore memory** stores conversation history in the AgentCore service for 30 days. The agent retains full context across turns within a session, so it can reference prior edits without the frontend re-sending history. This sample persists the session ID in `localStorage`, so conversations survive browser refresh. Clearing browser data starts a new session on the frontend, but the conversation history remains available in AgentCore through the `ListEvents` API.
- **[AgentCore Gateway](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway.html) with MCP.** Three AWS Lambda-backed tools are exposed through Model Context Protocol (MCP) with semantic routing. The agent selects the right tool based on the prompt.
- **InvokeAgentRuntimeCommand.** After each edit, a Python script runs directly on the AgentCore runtime microVM to add a watermark. No model reasoning, no tokens consumed.

## Solution overview

The architecture of the image editing application has four layers.

1. A React frontend hosted on [AWS Amplify](https://aws.amazon.com/amplify/) where users upload images, draw masks, and enter editing instructions.
2. An [AWS Lambda](https://aws.amazon.com/lambda/) proxy that acts as a security boundary between browser credentials and the harness API, and controls which system prompts are allowed.
3. An [Amazon Bedrock AgentCore](https://aws.amazon.com/bedrock/agentcore/) harness agent with [AgentCore Memory](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-memory.html) for conversation persistence.
4. Three tool Lambda functions calling Stability AI foundation models through [Amazon Bedrock](https://aws.amazon.com/bedrock/) for image generation.

<img width="3480" height="2250" alt="architecture-diagram-inline" src="https://github.com/user-attachments/assets/7a5a59b5-c2f8-49f2-8b8a-8088c500e38d" />

## Creating the agent using configuration

With an AgentCore harness, the agent definition is a set of parameters passed to the `create_harness` API. Here is the core of our provisioning code that creates the agent during `cdk deploy`.

```python
harness_params = {
    'harnessName': 'img_editor',
    'executionRoleArn': execution_role_arn,
    'model': {'bedrockModelConfig': {'modelId': 'us.anthropic.claude-sonnet-4-6'}},
    'systemPrompt': [{'text': system_prompt}],
    'tools': [{'type': 'agentcore_gateway', 'name': 'gateway',
        'config': {'agentCoreGateway': {'gatewayArn': gateway_arn}}}],
    # Scope the agent to exactly the three tools the gateway exposes
    # rather than allowing every tool with a wildcard.
    'allowedTools': [
        'inpaint-target___inpaint',
        'outpaint-target___outpaint',
        'search-replace-target___search_and_replace',
    ],
    'maxIterations': 10,
    'timeoutSeconds': 300,
}

# Attach memory for conversation persistence
```

That is the entire agent. No orchestration loop, no tool execution logic, no streaming handler, no error retry code. The AgentCore harness handles all of it.

## Declaring tools through AgentCore Gateway

Giving an agent access to tools normally requires writing code that receives tool calls from the model, parses arguments, invokes the target function, handles errors, and passes results back. With the harness, you skip all of that. You declare the tool schema on an [AgentCore Gateway](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway.html) and point it at a Lambda function. The harness discovers the tools, presents them to the model during reasoning, invokes the selected tool through the Gateway, and feeds the result back into the conversation automatically.

Here is how we declared the search-and-replace tool in the CDK stack.

```typescript
this.gateway.addLambdaTarget('SearchReplaceTarget', {
  gatewayTargetName: 'search-replace-target',
  lambdaFunction: this.searchReplaceLambda,
  toolSchema: agentcore.ToolSchema.fromInline([{
    name: 'search_and_replace',
    description: 'Find an object in the image by description and replace it. '
      + 'Does NOT require a mask. Use when the user wants to replace a specific object',
    inputSchema: {
      type: agentcore.SchemaDefinitionType.OBJECT,
      properties: {
        source_image_key: { type: agentcore.SchemaDefinitionType.STRING },
        search_prompt: { type: agentcore.SchemaDefinitionType.STRING },
        prompt: { type: agentcore.SchemaDefinitionType.STRING },
      },
      required: ['source_image_key', 'search_prompt', 'prompt'],
    },
  }]),
});
```

The agent reads these tool descriptions and selects the right one based on the user prompt. No routing logic is required. The harness handles tool selection through the model's reasoning.

## Per-invocation model and persona switching

The harness accepts a model parameter on every invocation. Passing a different model ID changes which foundation model handles that turn. The harness automatically loads the full conversation history from AgentCore Memory and formats it for the new model, so context carries over without additional code. You do not need to write model-switching logic, history retrieval, or input formatting. The harness manages all of that internally based on a single parameter change.

The Lambda proxy uses this to route basic chat to Haiku and image edits to Sonnet.

```python
invoke_params = {
    'harnessArn': harness_arn,
    'runtimeSessionId': session_id,
    'messages': [{'role': 'user', 'content': [{'text': input_text}]}],
    'actorId': actor_id,
}

# Switch model per invocation (Haiku for chat, Sonnet for edits)
if model_override:
    invoke_params['model'] = {
        'bedrockModelConfig': {'modelId': model_override}
    }

# Switch persona per invocation (Real Estate, Retail, Automotive)
if persona_text:
    invoke_params['systemPrompt'] = [{'text': persona_text}]

response = client.invoke_harness(**invoke_params)
```

The frontend determines which model to use based on whether the prompt contains editing keywords. Short messages like "hi" or "what can you do" go to Haiku for lower latency. Edits go to Sonnet for higher quality tool selection. The user can also manually select a model from a menu.

AgentCore Memory preserves the full conversation history regardless of configured model changes in the harness. When Haiku receives "how about blue?" after Sonnet handled "change the car to black," it knows "blue" refers to the car because Memory feeds the complete history to whatever model is active.

## Post-processing with shell commands (no token cost)

After the agent generates an image, we run a Python script directly on the harness microVM to add a watermark. This uses InvokeAgentRuntimeCommand, which gives you shell access to the agent's environment without going through the model.

```python
# Build a Python script and base64 encode it to avoid shell escaping issues
script = '\n'.join([
    'from PIL import Image, ImageDraw, ImageFont',
    'import boto3, io',
    's3 = boto3.client("s3")',
    f'obj = s3.get_object(Bucket="{bucket_name}", Key="{result_key}")',
    'img = Image.open(io.BytesIO(obj["Body"].read())).convert("RGBA")',
    '# ... tile watermark text across the image ...',
    's3.put_object(Bucket=bucket, Key=key, Body=buf.getvalue())',
])

encoded_script = base64.b64encode(script.encode()).decode()

# Run on the microVM: no model reasoning, no tokens consumed
client.invoke_agent_runtime_command(
        agentRuntimeArn=harness_arn,
        runtimeSessionId=session_id,
        body={'command': f'echo {encoded_script} | base64 -d | python3'},
)
```

This pattern is useful for deterministic post-processing. Resize images before sending to a model (save input tokens), run validation on agent output, extract structured data, or apply business logic. The microVM has Python and bash available by default, and you can install additional packages at runtime.

Because the harness is configuration-only, there is no agent script where you can add custom logic. InvokeAgentRuntimeCommand is the way to run your own code on the same microVM where the agent runs, but outside the agent loop. The Lambda proxy calls it after the agent finishes its turn. The command executes, does the work, and returns. The agent does not know it had happened.

## Prerequisites

To deploy this solution, you need the following.

- An [AWS account](https://signin.aws.amazon.com/signin?redirect_uri=https%3A%2F%2Fportal.aws.amazon.com%2Fbilling%2Fsignup%2Fresume&client_id=signup) with permissions to create AWS Identity and Access Management (IAM) roles, Lambda functions, Amazon Simple Storage Service (Amazon S3) buckets, Amazon Cognito pools, and AgentCore resources.
- [Node.js](https://nodejs.org/) 20.x or later.
- [Python 3.13](https://www.python.org/downloads/) or later (for Lambda function runtimes).
- [AWS Command Line Interface (AWS CLI)](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) 2.x configured with credentials.
- Access to Anthropic Claude models (Sonnet, Haiku) in Amazon Bedrock.
- Access to Stability AI models in Amazon Bedrock.

Estimated deployment time is 3 to 5 minutes.

## Deploy the solution

The deploy script handles everything end-to-end. It installs prerequisites, bundles Lambda dependencies, deploys the CDK stack, builds the frontend, uploads it to Amplify, and creates a test user.

Clone the [GitHub repository](https://github.com/aws-samples/sample-serverless-image-editing-agent-bedrock-agentcore-harness) and navigate into the project directory.

```bash
git clone https://github.com/aws-samples/sample-serverless-image-editing-agent-bedrock-agentcore-harness.git
cd sample-serverless-image-editing-agent-bedrock-agentcore-harness
```

Run the deployment script.

```bash
./deploy.sh
```

At the end, it prints the live URL and login credentials.

The CDK stack creates all resources in a single [AWS CloudFormation](https://aws.amazon.com/cloudformation/) stack. The solution uses Amazon Cognito with both a user pool and identity pool to handle authentication. Images are stored in an Amazon S3 bucket protected by AWS Key Management Service (AWS KMS) encryption. The image editing capabilities are powered by three Lambda functions, which are exposed as MCP tools through an AgentCore Gateway. These tools are orchestrated by an AgentCore harness agent equipped with memory, accessed via a Lambda proxy. On the frontend, an AWS Amplify application serves the React-based user interface.

## Walkthrough

After signing in, the editor presents a canvas on the left and a chat interface on the right.

1. **Upload an image.** The image uploads to S3 under the user's identity-scoped prefix.
2. **Describe your edit.** Enter a natural-language instruction in the chat input. For object replacement ("change the sky to a sunset"), the agent uses search-and-replace automatically.
3. **Draw a mask for region-specific edits.** To edit a specific area of the image, draw a mask on the canvas to define the region, then enter what to generate in the masked area.
4. **View the result.** The edited image appears in the chat thread with a tiled watermark applied by the microVM shell command. The "Behind the Scenes" panel shows which model was used, which tool was called, token counts, latency, and whether the watermark was applied.
5. **Optionally switch models or personas.** Use the menus at the top of the chat to change the reasoning model or switch to an industry-specific persona. The change takes effect on the next message without losing conversation history.

https://github.com/user-attachments/assets/eff61cba-aad8-49f8-a5ae-20ad274341ab

## What the harness specifically reduced for this project

The solution does not require lines of agent orchestration code. No model call loop, no tool execution handler, no streaming parser, no error retry logic, no container image.

What we did write.

- A Lambda proxy (80 lines) that acts as a security boundary and controls which system prompts reach the harness.
- Three tool Lambda functions (one per Stability AI model) that do the actual image processing.
- A provisioning script that calls the `create_harness` API during deployment (AgentCore harness is in preview and does not yet have a native CDK construct).

The agent itself is configuration. Changing its behavior (different model, new tool, updated instructions) is an API call, not a code deployment.

## When to use AgentCore Runtime instead

AgentCore harness works well for agents with straightforward tool-calling patterns. The agent receives a prompt, picks a tool, calls it, and returns the result. If your agent needs custom orchestration logic, such as pre-processing inputs between turns, running a LangGraph state machine, or executing arbitrary Python before and after each model call, [AgentCore Runtime](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime.html) gives you full control.

Both the harness and AgentCore Runtime run on the same underlying infrastructure (microVMs, Memory, Gateway, Observability). You can start with the harness and move to AgentCore Runtime as complexity grows.

## Clean up

Running the destroy script permanently deletes all resources including the S3 bucket and uploaded images. Back up any data you want to keep before proceeding.

Delete the stack:

```bash
./destroy.sh
```

## Conclusion

AgentCore harness lets us build a production-ready image editing agent without writing orchestration code. The agent handles tool selection, model switching, persona customization, conversation persistence, and deterministic post-processing through configuration and per-invocation parameters. Each session runs in an isolated microVM where we can execute shell commands at no token cost for tasks like watermarking.

For agents with straightforward tool-calling patterns, the harness removes operational overhead and you can iterate behavior at the speed of a configuration change. The full source code and one-command deployment script are available on [GitHub](https://github.com/aws-samples/sample-serverless-image-editing-agent-bedrock-agentcore-harness).

To get started with AgentCore harness, visit the [AgentCore harness documentation](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness.html) or explore the [Amazon Bedrock AgentCore product page](https://aws.amazon.com/bedrock/agentcore/) for pricing and availability details.

## About the authors

**Salman Ahmed** is a Senior Technical Account Manager at AWS, specializing in helping customers design, implement, and optimize their AWS environments. He combines deep networking expertise with a passion for exploring emerging technologies to help organizations get the most out of their cloud investments. Outside of work, he enjoys photography, traveling, and watching his favorite sports teams.

**Sergio Barraza** is a Senior Technical Account Manager at AWS, helping customers design and optimize cloud solutions. With more than 25 years in software development, he guides customers through AWS services adoption. Outside work, Sergio is a multi-instrument musician playing guitar, piano, and drums, and he also practices Wing Chun Kung Fu.

**Ravi Kumar** is a Senior Technical Account Manager in AWS Enterprise Support who helps customers in the travel and hospitality industry to streamline their cloud operations on AWS. He is a results-driven IT professional with over 20 years of experience. Ravi is passionate about generative AI and actively explores its applications in cloud computing. Outside of work, Ravi enjoys creative activities like painting. He also likes playing cricket and traveling to new places.

## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.

## License

This library is licensed under the MIT-0 License. See the [LICENSE](LICENSE) file. 
