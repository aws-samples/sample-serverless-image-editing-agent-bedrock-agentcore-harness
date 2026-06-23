import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as amplify from 'aws-cdk-lib/aws-amplify';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
// Amazon Bedrock AgentCore (AgentCore) for agentic workflows
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import { Construct } from 'constructs';

export interface ImageEditorStackProps extends cdk.StackProps {
  /**
   * Tag applied to all resources in the stack for cost attribution.
   */
  projectTag: string;
}

export class ImageEditorStack extends cdk.Stack {
  /** KMS key used for S3 bucket encryption. */
  public readonly imageStoreKey: kms.Key;

  /** S3 bucket for storing user images, masks, and results. */
  public readonly imageBucket: s3.Bucket;

  /** Cognito User Pool for user registration and authentication. */
  public readonly userPool: cognito.UserPool;

  /** Cognito User Pool Client for the frontend app. */
  public readonly userPoolClient: cognito.UserPoolClient;

  /** Cognito Identity Pool for temporary AWS credential issuance. */
  public readonly identityPool: cognito.CfnIdentityPool;

  /** IAM role assumed by authenticated users via the Identity Pool. */
  public readonly authenticatedRole: iam.Role;

  /** Lambda function for inpainting operations (Stability AI). */
  public readonly inpaintLambda: lambda.Function;

  /** Lambda function for outpainting operations (Stability AI). */
  public readonly outpaintLambda: lambda.Function;

  /** Lambda function for search-and-replace operations (Stability AI). */
  public readonly searchReplaceLambda: lambda.Function;

  /** AgentCore Gateway exposing image editing tools via MCP protocol. */
  public readonly gateway: agentcore.Gateway;

  /** Lambda function that proxies InvokeHarness calls for the frontend. */
  public readonly invokeHarnessLambda: lambda.Function;

  /** Amplify App for hosting the React SPA frontend. */
  public readonly amplifyApp: amplify.CfnApp;

  /** Amplify branch configured for auto-build and deploy. */
  public readonly amplifyBranch: amplify.CfnBranch;

  constructor(scope: Construct, id: string, props: ImageEditorStackProps) {
    super(scope, id, props);

    // Apply project tag to all resources in this stack
    cdk.Tags.of(this).add('Project', props.projectTag);

    // KMS key for S3 bucket encryption with automatic key rotation
    this.imageStoreKey = new kms.Key(this, 'ImageStoreKey', {
      description: 'KMS key for image editor S3 bucket encryption',
      enableKeyRotation: true,
    });

    // Amazon S3 bucket for image storage with SSE-KMS encryption
    this.imageBucket = new s3.Bucket(this, 'ImageStore', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.imageStoreKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT],
          allowedOrigins: ['https://*.amplifyapp.com'],
          allowedHeaders: ['*'],
        },
      ],
    });

    // --- Authentication (Cognito) ---

    // Cognito User Pool with self-sign-up and email verification
    this.userPool = new cognito.UserPool(this, 'ImageEditorUserPool', {
      userPoolName: 'image-editor-user-pool',
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // User Pool Client for the frontend application
    this.userPoolClient = this.userPool.addClient('ImageEditorAppClient', {
      userPoolClientName: 'image-editor-frontend',
      authFlows: {
        userSrp: true,
        userPassword: true,
      },
      preventUserExistenceErrors: true,
    });

    // Cognito Identity Pool linked to the User Pool
    this.identityPool = new cognito.CfnIdentityPool(this, 'ImageEditorIdentityPool', {
      identityPoolName: 'image-editor-identity-pool',
      allowUnauthenticatedIdentities: false,
      cognitoIdentityProviders: [
        {
          clientId: this.userPoolClient.userPoolClientId,
          providerName: this.userPool.userPoolProviderName,
        },
      ],
    });

    // IAM role for authenticated users with least-privilege permissions
    this.authenticatedRole = new iam.Role(this, 'CognitoAuthenticatedRole', {
      description: 'IAM role for authenticated Cognito users in the image editor',
      assumedBy: new iam.FederatedPrincipal(
        'cognito-identity.amazonaws.com',
        {
          StringEquals: {
            'cognito-identity.amazonaws.com:aud': this.identityPool.ref,
          },
          'ForAnyValue:StringLike': {
            'cognito-identity.amazonaws.com:amr': 'authenticated',
          },
        },
        'sts:AssumeRoleWithWebIdentity',
      ),
    });

    // S3 permissions scoped to the user's identity prefix
    this.authenticatedRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['s3:GetObject', 's3:PutObject'],
        resources: [
          this.imageBucket.arnForObjects('users/${cognito-identity.amazonaws.com:sub}/*'),
        ],
      }),
    );

    // KMS permissions to decrypt/encrypt objects in the image store
    this.authenticatedRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
        resources: [this.imageStoreKey.keyArn],
      }),
    );

    // Attach the authenticated role to the Identity Pool
    new cognito.CfnIdentityPoolRoleAttachment(this, 'IdentityPoolRoleAttachment', {
      identityPoolId: this.identityPool.ref,
      roles: {
        authenticated: this.authenticatedRole.roleArn,
      },
    });

    // --- Lambda Functions for Image Editing ---

    // Inpaint Lambda function
    this.inpaintLambda = new lambda.Function(this, 'InpaintLambda', {
      functionName: 'image-editor-inpaint',
      description: 'Invokes Stability AI inpaint model via Bedrock to fill masked image regions',
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'handler.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/inpaint')),
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      environment: {
        IMAGE_BUCKET_NAME: this.imageBucket.bucketName,
        KMS_KEY_ARN: this.imageStoreKey.keyArn,
      },
    });

    // Outpaint Lambda function
    this.outpaintLambda = new lambda.Function(this, 'OutpaintLambda', {
      functionName: 'image-editor-outpaint',
      description: 'Invokes Stability AI outpaint model via Bedrock to extend image boundaries',
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'handler.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/outpaint')),
      timeout: cdk.Duration.seconds(120),
      memorySize: 512,
      environment: {
        IMAGE_BUCKET_NAME: this.imageBucket.bucketName,
        KMS_KEY_ARN: this.imageStoreKey.keyArn,
      },
    });

    // Search and Replace Lambda function
    this.searchReplaceLambda = new lambda.Function(this, 'SearchReplaceLambda', {
      functionName: 'image-editor-search-replace',
      description: 'Invokes Stability AI search-and-replace model to find and replace objects without a mask',
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'handler.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/search-replace')),
      timeout: cdk.Duration.seconds(120),
      memorySize: 512,
      environment: {
        IMAGE_BUCKET_NAME: this.imageBucket.bucketName,
        KMS_KEY_ARN: this.imageStoreKey.keyArn,
      },
    });

    // Grant S3 read/write permissions on the image bucket
    this.imageBucket.grantReadWrite(this.inpaintLambda);
    this.imageBucket.grantReadWrite(this.outpaintLambda);
    this.imageBucket.grantReadWrite(this.searchReplaceLambda);

    // Grant KMS decrypt/encrypt permissions for SSE-KMS encrypted objects
    this.imageStoreKey.grant(this.inpaintLambda, 'kms:Decrypt', 'kms:GenerateDataKey');
    this.imageStoreKey.grant(this.outpaintLambda, 'kms:Decrypt', 'kms:GenerateDataKey');
    this.imageStoreKey.grant(this.searchReplaceLambda, 'kms:Decrypt', 'kms:GenerateDataKey');

    // Grant Bedrock InvokeModel permission scoped to Stability AI foundation models
    const bedrockInvokePolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel'],
      resources: [
        'arn:aws:bedrock:*::foundation-model/stability.*',
        `arn:aws:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:inference-profile/us.stability.*`,
      ],
    });
    this.inpaintLambda.addToRolePolicy(bedrockInvokePolicy);
    this.outpaintLambda.addToRolePolicy(bedrockInvokePolicy);
    this.searchReplaceLambda.addToRolePolicy(bedrockInvokePolicy);

    // --- AgentCore Gateway ---

    this.gateway = new agentcore.Gateway(this, 'ImageEditorGateway', {
      gatewayName: 'image-editor-gateway',
      description: 'Gateway for image editing tools',
      protocolConfiguration: new agentcore.McpProtocolConfiguration({
        instructions: 'Image editing tools for inpainting and outpainting',
        searchType: agentcore.McpGatewaySearchType.SEMANTIC,
      }),
      authorizerConfiguration: agentcore.GatewayAuthorizer.usingAwsIam(),
    });

    // Inpaint tool target
    this.gateway.addLambdaTarget('InpaintTarget', {
      gatewayTargetName: 'inpaint-target',
      lambdaFunction: this.inpaintLambda,
      toolSchema: agentcore.ToolSchema.fromInline([
        {
          name: 'inpaint',
          description: 'Fill masked regions of an image with AI-generated content based on a text prompt. Use when the user wants to edit a specific area of an image.',
          inputSchema: {
            type: agentcore.SchemaDefinitionType.OBJECT,
            properties: {
              source_image_key: {
                type: agentcore.SchemaDefinitionType.STRING,
                description: 'S3 object key of the source image',
              },
              mask_key: {
                type: agentcore.SchemaDefinitionType.STRING,
                description: 'S3 object key of the mask image (white=edit, black=preserve)',
              },
              prompt: {
                type: agentcore.SchemaDefinitionType.STRING,
                description: 'Text description of what to generate in the masked region',
              },
            },
            required: ['source_image_key', 'mask_key', 'prompt'],
          },
        },
      ]),
    });

    // Outpaint tool target
    this.gateway.addLambdaTarget('OutpaintTarget', {
      gatewayTargetName: 'outpaint-target',
      lambdaFunction: this.outpaintLambda,
      toolSchema: agentcore.ToolSchema.fromInline([
        {
          name: 'outpaint',
          description: 'Extend an image beyond its original boundaries with AI-generated content. Use when the user wants to expand or extend the scene.',
          inputSchema: {
            type: agentcore.SchemaDefinitionType.OBJECT,
            properties: {
              source_image_key: {
                type: agentcore.SchemaDefinitionType.STRING,
                description: 'S3 object key of the source image',
              },
              prompt: {
                type: agentcore.SchemaDefinitionType.STRING,
                description: 'Text description of what to generate in the extended area',
              },
              directions: {
                type: agentcore.SchemaDefinitionType.ARRAY,
                items: {
                  type: agentcore.SchemaDefinitionType.STRING,
                  description: 'Direction to extend (left, right, up, or down)',
                },
                description: 'Directions to extend the image',
              },
              extend_pixels: {
                type: agentcore.SchemaDefinitionType.INTEGER,
                description: 'Number of pixels to extend in each specified direction (default 256)',
              },
            },
            required: ['source_image_key', 'prompt', 'directions'],
          },
        },
      ]),
    });

    // Search and Replace tool target
    this.gateway.addLambdaTarget('SearchReplaceTarget', {
      gatewayTargetName: 'search-replace-target',
      lambdaFunction: this.searchReplaceLambda,
      toolSchema: agentcore.ToolSchema.fromInline([
        {
          name: 'search_and_replace',
          description: 'Find an object in the image by description and replace it with something else. Does NOT require a mask - the model automatically segments the object. Use this when the user wants to replace a specific object without drawing a mask.',
          inputSchema: {
            type: agentcore.SchemaDefinitionType.OBJECT,
            properties: {
              source_image_key: {
                type: agentcore.SchemaDefinitionType.STRING,
                description: 'S3 object key of the source image',
              },
              search_prompt: {
                type: agentcore.SchemaDefinitionType.STRING,
                description: 'Short description of the object to find and replace (e.g. "car wheels", "the sky", "the person")',
              },
              prompt: {
                type: agentcore.SchemaDefinitionType.STRING,
                description: 'Description of what to replace it with (e.g. "monster truck wheels", "a sunset sky")',
              },
            },
            required: ['source_image_key', 'search_prompt', 'prompt'],
          },
        },
      ]),
    });

    // --- AgentCore Harness (via Custom Resource) ---

    // IAM execution role that the Harness assumes when running
    const harnessExecutionRole = new iam.Role(this, 'HarnessExecutionRole', {
      description: 'Execution role assumed by the AgentCore Harness at runtime',
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
    });

    // Grant the Harness execution role permission to invoke Nova Lite
    harnessExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [
          `arn:aws:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:inference-profile/us.anthropic.*`,
          `arn:aws:bedrock:${cdk.Aws.REGION}::foundation-model/anthropic.*`,
          `arn:aws:bedrock:*::foundation-model/anthropic.*`,
          `arn:aws:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:inference-profile/us.amazon.*`,
          `arn:aws:bedrock:*::foundation-model/amazon.*`,
        ],
      }),
    );

    // Grant the Harness execution role permission to invoke the Gateway and manage sessions
    harnessExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'bedrock-agentcore:InvokeGateway',
          'bedrock-agentcore:GetGateway',
          'bedrock-agentcore:ListGatewayTargets',
          'bedrock-agentcore:GetMemory',
          'bedrock-agentcore:ListEvents',
          'bedrock-agentcore:PutEvents',
          'bedrock-agentcore:CreateEvent',
          'bedrock-agentcore:CreateSession',
          'bedrock-agentcore:GetSession',
          'bedrock-agentcore:UpdateSession',
          'bedrock-agentcore:DeleteSession',
        ],
        resources: [
          `arn:aws:bedrock-agentcore:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:gateway/*`,
          `arn:aws:bedrock-agentcore:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:runtime/*`,
          `arn:aws:bedrock-agentcore:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:memory/*`,
        ],
      }),
    );

    // Grant the Harness execution role S3 access for post-processing (watermark via shell commands)
    this.imageBucket.grantReadWrite(harnessExecutionRole);
    this.imageStoreKey.grant(harnessExecutionRole, 'kms:Decrypt', 'kms:GenerateDataKey');

    // Custom Resource Lambda for Harness lifecycle management
    // Explicit log group (replaces the deprecated `logRetention` prop) with a
    // one-week retention and DESTROY removal so it is cleaned up with the stack.
    const harnessCrLogGroup = new logs.LogGroup(this, 'HarnessCustomResourceLambdaLogGroup', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const harnessCustomResourceLambda = new lambda.Function(this, 'HarnessCustomResourceLambda', {
      functionName: 'image-editor-harness-cr',
      description: 'Custom Resource handler for AgentCore Harness create/update/delete',
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/harness-custom-resource')),
      timeout: cdk.Duration.minutes(14),
      memorySize: 256,
      logGroup: harnessCrLogGroup,
    });

    // Grant the CR Lambda permission to manage Harness resources.
    // Resource set to '*' because bedrock-agentcore Create* actions validate against
    // collection-level ARNs (e.g. :/harnesses) that differ from the resource-level
    // patterns (e.g. :harness/{id}). Scoped ARN patterns cause AccessDeniedException
    // on fresh deployments. Actions are still limited to specific operations.
    // Security review: 2026-05-15 - confirmed ARN patterns not supported for Create*
    harnessCustomResourceLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'bedrock-agentcore:CreateHarness',
          'bedrock-agentcore:UpdateHarness',
          'bedrock-agentcore:DeleteHarness',
          'bedrock-agentcore:GetHarness',
          'bedrock-agentcore:GetAgentRuntime',
          'bedrock-agentcore:CreateAgentRuntime',
          'bedrock-agentcore:DeleteAgentRuntime',
          'bedrock-agentcore:CreateWorkloadIdentity',
          'bedrock-agentcore:DeleteWorkloadIdentity',
          'bedrock-agentcore:CreateMemory',
          'bedrock-agentcore:DeleteMemory',
          'bedrock-agentcore:GetMemory',
          'bedrock-agentcore:CreateAgentRuntimeEndpoint',
          'bedrock-agentcore:DeleteAgentRuntimeEndpoint',
        ],
        resources: ['*'],
      }),
    );

    // List operations require wildcard resource because the bedrock-agentcore
    // IAM API does not support resource-level permissions for List* actions.
    // These actions enumerate resources across the account and cannot be scoped
    // to a specific ARN pattern. This is documented as an exception to
    // least-privilege principles for this stack.
    // Security review: 2026-05-14 - confirmed List* still requires '*'
    harnessCustomResourceLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'bedrock-agentcore:ListMemories',
          'bedrock-agentcore:ListHarnesses',
        ],
        resources: ['*'],
      }),
    );

    // Grant the CR Lambda permission to pass the execution role to the Harness
    harnessCustomResourceLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['iam:PassRole'],
        resources: [harnessExecutionRole.roleArn],
      }),
    );

    // System prompt for the image editing agent
    const systemPrompt = [
      'You are an AI-powered image editing assistant.',
      'You help users edit images using three tools:',
      '1. SEARCH AND REPLACE (preferred): Automatically finds an object by description and replaces it. No mask needed. Use this when the user describes what to change (e.g. "replace the car with a truck", "change the sky to sunset").',
      '2. INPAINT: Fills a masked region with new content. Only use this when the user has explicitly drawn a mask on the image.',
      '3. OUTPAINT: Extends the image beyond its borders. Use when the user says "extend", "expand", or "make the image wider/taller".',
      'IMPORTANT: Prefer search_and_replace over inpaint when no mask is provided. Do NOT ask the user for a mask if they describe what to change - use search_and_replace instead.',
      'IMPORTANT: When using search_and_replace, be very specific with the search_prompt. Use precise object descriptions (e.g. "the car body paint" not just "the car"). For color changes, set the prompt to describe the exact desired result (e.g. "a car with blue metallic paint, same shape and proportions"). This helps the model preserve the original structure.',
      'IMPORTANT: After a successful edit, you MUST include the result_image_key from the tool response in your reply using this exact format: result_image_key: "users/..." so the frontend can display the image.',
      'Always confirm what operation you performed and describe the result to the user.',
      'FORMATTING: Do NOT use markdown formatting (no **, no ##, no bullet points with -). Write plain text only. Do not use emojis excessively. Keep responses concise and conversational.',
    ].join(' ');

    // Tools configuration referencing the Gateway
    const toolsConfig = JSON.stringify([
      {
        name: 'gateway',
        type: 'agentcore_gateway',
        config: {
          agentCoreGateway: {
            gatewayArn: this.gateway.gatewayArn,
          },
        },
      },
    ]);

    // Harness name derived from stack name to be unique per deployment but stable across updates
    const harnessName = 'img_editor_' + this.node.addr.substring(0, 6);

    // Custom Resource to create the Harness
    const harnessResource = new cdk.CustomResource(this, 'ImageEditorHarness', {
      serviceToken: harnessCustomResourceLambda.functionArn,
      properties: {
        HarnessName: harnessName,
        ExecutionRoleArn: harnessExecutionRole.roleArn,
        ModelId: 'us.anthropic.claude-sonnet-4-6',
        SystemPrompt: systemPrompt,
        Tools: toolsConfig,
        MaxIterations: '10',
        TimeoutSeconds: '300',
      },
    });

    // Ensure the execution role is not deleted before the harness custom resource
    // is deleted. The harness needs the role to tear down its runtime environment.
    harnessResource.node.addDependency(harnessExecutionRole);

    const harnessId = harnessResource.getAttString('HarnessId');

    // --- Invoke Harness Lambda (frontend proxy) ---

    this.invokeHarnessLambda = new lambda.Function(this, 'InvokeHarnessLambda', {
      functionName: 'image-editor-invoke-harness',
      description: 'Proxy Lambda that invokes the AgentCore Harness on behalf of the frontend',
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'handler.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/invoke-harness')),
      timeout: cdk.Duration.seconds(120),
      memorySize: 256,
      environment: {
        HARNESS_ID: harnessId,
        IMAGE_BUCKET_NAME: this.imageBucket.bucketName,
      },
    });

    // Grant the invoke Lambda permission to call InvokeHarness
    this.invokeHarnessLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'bedrock-agentcore:InvokeHarness',
          'bedrock-agentcore:InvokeAgentRuntime',
          'bedrock-agentcore:InvokeAgentRuntimeCommand',
        ],
        resources: [
          `arn:aws:bedrock-agentcore:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:harness/*`,
          `arn:aws:bedrock-agentcore:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:runtime/*`,
        ],
      }),
    );

    // Grant authenticated users permission to invoke the proxy Lambda
    this.authenticatedRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['lambda:InvokeFunction'],
        resources: [this.invokeHarnessLambda.functionArn],
      }),
    );

    // --- Amplify Hosting ---

    // IAM role for Amplify to access resources during build
    const amplifyServiceRole = new iam.Role(this, 'AmplifyServiceRole', {
      description: 'Service role for Amplify app build and deploy',
      assumedBy: new iam.ServicePrincipal('amplify.amazonaws.com'),
    });

    // Amplify App for the React SPA frontend
    this.amplifyApp = new amplify.CfnApp(this, 'ImageEditorAmplifyApp', {
      name: 'image-editor-frontend',
      description: 'React SPA frontend for the serverless agentic image editor',
      iamServiceRole: amplifyServiceRole.roleArn,
      buildSpec: [
        'version: 1',
        'frontend:',
        '  phases:',
        '    preBuild:',
        '      commands:',
        '        - npm ci',
        '    build:',
        '      commands:',
        '        - npm run build',
        '  artifacts:',
        '    baseDirectory: dist',
        '    files:',
        '      - "**/*"',
        '  cache:',
        '    paths:',
        '      - node_modules/**/*',
      ].join('\n'),
      environmentVariables: [
        { name: 'VITE_USER_POOL_ID', value: this.userPool.userPoolId },
        { name: 'VITE_USER_POOL_CLIENT_ID', value: this.userPoolClient.userPoolClientId },
        { name: 'VITE_IDENTITY_POOL_ID', value: this.identityPool.ref },
        { name: 'VITE_IMAGE_BUCKET_NAME', value: this.imageBucket.bucketName },
        { name: 'VITE_HARNESS_ID', value: harnessId },
        { name: 'VITE_INVOKE_HARNESS_FUNCTION_NAME', value: this.invokeHarnessLambda.functionName },
        { name: 'VITE_AWS_REGION', value: cdk.Aws.REGION },
      ],
      platform: 'WEB',
      customRules: [
        {
          source: '/<*>',
          target: '/index.html',
          status: '404-200',
        },
      ],
    });

    // Main branch with auto-build enabled
    this.amplifyBranch = new amplify.CfnBranch(this, 'MainBranch', {
      appId: this.amplifyApp.attrAppId,
      branchName: 'main',
      enableAutoBuild: true,
      stage: 'PRODUCTION',
      description: 'Production branch for the image editor frontend',
    });

    // Add ALLOWED_ORIGIN to the invoke Lambda (using wildcard for Amplify since the URL is dynamic)
    this.invokeHarnessLambda.addEnvironment('ALLOWED_ORIGIN', '*');

    // --- CloudWatch Dashboard ---

    const dashboard = new cloudwatch.Dashboard(this, 'ImageEditorDashboard', {
      dashboardName: 'image-editor-dashboard',
    });

    // Invocation counts for all Lambda functions
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Lambda Invocations',
        left: [
          this.inpaintLambda.metricInvocations({ statistic: 'Sum' }),
          this.outpaintLambda.metricInvocations({ statistic: 'Sum' }),
          this.searchReplaceLambda.metricInvocations({ statistic: 'Sum' }),
        ],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda Errors',
        left: [
          this.inpaintLambda.metricErrors({ statistic: 'Sum' }),
          this.outpaintLambda.metricErrors({ statistic: 'Sum' }),
          this.searchReplaceLambda.metricErrors({ statistic: 'Sum' }),
        ],
        width: 12,
      }),
    );

    // Duration p50 and p99 for Inpaint Lambda
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Inpaint Lambda Latency (p50 / p99)',
        left: [
          this.inpaintLambda.metricDuration({ statistic: 'p50', label: 'p50' }),
          this.inpaintLambda.metricDuration({ statistic: 'p99', label: 'p99' }),
        ],
        width: 8,
      }),
      // Duration p50 and p99 for Outpaint Lambda
      new cloudwatch.GraphWidget({
        title: 'Outpaint Lambda Latency (p50 / p99)',
        left: [
          this.outpaintLambda.metricDuration({ statistic: 'p50', label: 'p50' }),
          this.outpaintLambda.metricDuration({ statistic: 'p99', label: 'p99' }),
        ],
        width: 8,
      }),
      // Duration p50 and p99 for Search and Replace Lambda
      new cloudwatch.GraphWidget({
        title: 'Search-Replace Lambda Latency (p50 / p99)',
        left: [
          this.searchReplaceLambda.metricDuration({ statistic: 'p50', label: 'p50' }),
          this.searchReplaceLambda.metricDuration({ statistic: 'p99', label: 'p99' }),
        ],
        width: 8,
      }),
    );

    // --- CfnOutputs ---

    new cdk.CfnOutput(this, 'AmplifyAppUrl', {
      value: `https://main.${this.amplifyApp.attrDefaultDomain}`,
      description: 'Amplify app default domain URL',
    });

    new cdk.CfnOutput(this, 'CognitoSignInUrl', {
      value: this.userPool.userPoolId,
      description: 'Cognito User Pool ID for Amplify Auth configuration',
    });

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: this.userPool.userPoolId,
      description: 'Cognito User Pool ID for frontend configuration',
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: this.userPoolClient.userPoolClientId,
      description: 'Cognito User Pool Client ID for frontend configuration',
    });

    new cdk.CfnOutput(this, 'IdentityPoolId', {
      value: this.identityPool.ref,
      description: 'Cognito Identity Pool ID for frontend configuration',
    });

    new cdk.CfnOutput(this, 'ImageBucketName', {
      value: this.imageBucket.bucketName,
      description: 'S3 bucket name for image storage',
    });

    new cdk.CfnOutput(this, 'HarnessId', {
      value: harnessId,
      description: 'AgentCore Harness ID for frontend invocation',
    });

    new cdk.CfnOutput(this, 'InvokeHarnessFunctionName', {
      value: this.invokeHarnessLambda.functionName,
      description: 'Lambda function name for invoking the Harness',
    });
  }
}
