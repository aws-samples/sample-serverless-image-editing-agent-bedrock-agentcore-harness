# Build a Serverless Image Editing Agent with Amazon Bedrock AgentCore Harness

This sample deploys a fully serverless image editing application powered by [Amazon Bedrock AgentCore](https://aws.amazon.com/bedrock/agentcore/) harness. Users interact with a React frontend to edit images using natural language -- the agent autonomously selects the right tool, calls Stability AI models through [Amazon Bedrock](https://aws.amazon.com/bedrock/), and returns the result.

## Architecture

The solution consists of four layers:

1. **Frontend** -- React single-page application hosted on [AWS Amplify](https://aws.amazon.com/amplify/) with [Amazon Cognito](https://aws.amazon.com/cognito/) authentication
2. **Proxy** -- An [AWS Lambda](https://aws.amazon.com/lambda/) function that invokes the AgentCore harness on behalf of authenticated users
3. **Agent** -- An AgentCore harness with built-in memory, tool orchestration, and model routing (no orchestration code required)
4. **Tools** -- Three Lambda functions exposed through an AgentCore Gateway using the Model Context Protocol (MCP):
   - **Inpaint** -- Fill masked regions with AI-generated content
   - **Outpaint** -- Extend images beyond their original boundaries
   - **Search and Replace** -- Find objects by description and replace them (no mask needed)

All image generation uses Stability AI foundation models accessed through Amazon Bedrock.

## Features

- Zero orchestration code -- the harness handles tool selection, iteration, and error recovery
- Conversation memory persists across sessions via AgentCore memory
- Per-invocation model override (Claude Sonnet, Haiku) without redeploying
- Post-processing watermark applied via shell command on the harness microVM (no token cost)
- Encrypted storage with [AWS KMS](https://aws.amazon.com/kms/) and user-scoped [Amazon S3](https://aws.amazon.com/s3/) paths
- Fully automated deployment and teardown scripts

## Prerequisites

- An AWS account with Amazon Bedrock model access enabled for Stability AI models and Anthropic Claude
- [AWS CLI](https://aws.amazon.com/cli/) configured with credentials
- [Node.js](https://nodejs.org/) 18+
- [Python](https://www.python.org/) 3.12+
- [jq](https://jqlang.github.io/jq/)

## Deploy

The deploy script handles everything automatically: installs dependencies, bundles Lambda layers, deploys the CDK stack, builds the frontend, uploads to Amplify, and creates a test user with a random password.

```bash
chmod +x deploy.sh
./deploy.sh
```

After deployment completes, the script prints:
- The Amplify app URL
- A test username and auto-generated password

Open the URL and sign in with the provided credentials.

## Usage

1. **Upload an image** -- Drag and drop or click to upload a source image
2. **Describe your edit** -- Enter a natural-language instruction in the chat (e.g., "change the sky to a sunset", "make the image wider")
3. **Draw a mask for region-specific edits** -- To edit a specific area, draw a mask on the canvas first, then describe what to generate

The agent picks the appropriate tool automatically. Results appear in the chat with a "Behind the Scenes" panel showing model, latency, tokens, and tool used.

## Clean up

**Warning:** Running the destroy script permanently deletes all resources including uploaded images. Back up any data you want to keep before proceeding.

```bash
chmod +x destroy.sh
./destroy.sh
```

## Project structure

```
.
├── bin/                    # CDK app entry point
├── lib/                    # CDK stack definition
├── lambda/
│   ├── inpaint/           # Stability AI inpaint model invocation
│   ├── outpaint/          # Stability AI outpaint model invocation
│   ├── search-replace/    # Stability AI search-and-replace invocation
│   ├── invoke-harness/    # Proxy Lambda for frontend-to-harness calls
│   └── harness-custom-resource/  # CloudFormation CR for harness lifecycle
├── frontend/              # React + Vite + Tailwind SPA
├── deploy.sh              # One-command deployment
├── destroy.sh             # One-command teardown
├── cdk.json               # CDK configuration
└── package.json           # CDK dependencies
```

## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.

## License

This library is licensed under the MIT-0 License. See the [LICENSE](LICENSE) file. 
