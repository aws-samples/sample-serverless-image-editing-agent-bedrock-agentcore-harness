#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ImageEditorStack } from '../lib/image-editor-stack';

const app = new cdk.App();

const projectTag = app.node.tryGetContext('projectTag') || 'serverless-agentic-image-editor';

new ImageEditorStack(app, 'ImageEditorStack', {
  projectTag,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
