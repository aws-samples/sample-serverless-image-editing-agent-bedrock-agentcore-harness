#!/bin/bash
set -e

echo "============================================"
echo "  Serverless Agentic Image Editor - Destroy"
echo "============================================"
echo ""

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Check AWS credentials
echo "Checking AWS credentials..."
if ! aws sts get-caller-identity &> /dev/null; then
  echo -e "${RED}[ERROR]${NC} AWS credentials not configured or expired."
  echo "Please configure AWS credentials before destroying the stack."
  exit 1
fi

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=$(aws configure get region 2>/dev/null || echo "us-east-1")
echo -e "${GREEN}[OK]${NC} AWS credentials valid. Account: $ACCOUNT_ID, Region: $REGION"

echo ""
echo -e "${YELLOW}WARNING: This will destroy the following resources:${NC}"
echo "  - Amplify App (frontend hosting)"
echo "  - Cognito User Pool and Identity Pool (all user accounts)"
echo "  - AgentCore Runtime and Gateway"
echo "  - Lambda functions (Inpaint and Outpaint)"
echo "  - CloudWatch Dashboard"
echo "  - KMS Key"
echo ""
echo -e "${YELLOW}NOTE: The S3 image bucket will be RETAINED (not deleted) for data safety.${NC}"
echo "  To delete it manually: aws s3 rb s3://image-editor-store-$ACCOUNT_ID-$REGION --force"
echo ""

read -p "Are you sure you want to destroy the stack? (yes/no) " CONFIRM
if [ "$CONFIRM" != "yes" ]; then
  echo "Aborted."
  exit 0
fi

echo ""
echo "Destroying stack..."
echo ""

cdk destroy --force

echo ""
echo "============================================"
echo -e "  ${GREEN}Stack destroyed successfully.${NC}"
echo "============================================"
echo ""
echo "Retained resources:"
echo "  - S3 bucket: image-editor-store-$ACCOUNT_ID-$REGION"
echo ""
echo "To delete the retained S3 bucket:"
echo "  aws s3 rm s3://image-editor-store-$ACCOUNT_ID-$REGION --recursive"
echo "  aws s3 rb s3://image-editor-store-$ACCOUNT_ID-$REGION"
echo ""

# Clean up local artifacts
if [ -f cdk-outputs.json ]; then
  rm cdk-outputs.json
  echo "Removed local cdk-outputs.json"
fi

echo "Done."
