#!/bin/bash
set -e

echo "============================================"
echo "  Serverless Agentic Image Editor"
echo "  Full Automated Deployment"
echo "============================================"
echo ""

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# --- Auto-install prerequisites ---

if ! command -v node &> /dev/null; then
  echo -e "${YELLOW}Installing Node.js 20 via nvm...${NC}"
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
  nvm install 20
  nvm use 20
else
  echo -e "${GREEN}[OK]${NC} Node.js $(node -v)"
fi

if ! command -v cdk &> /dev/null; then
  echo -e "${YELLOW}Installing AWS CDK CLI...${NC}"
  npm install -g aws-cdk
fi

# Check CDK CLI version is compatible with aws-cdk-lib in package.json
REQUIRED_CDK=$(node -e "console.log(require('./package.json').dependencies['aws-cdk-lib'].replace('^','').replace('~',''))" 2>/dev/null)
INSTALLED_CDK=$(cdk --version 2>/dev/null | cut -d' ' -f1)
if [ -n "$REQUIRED_CDK" ] && [ -n "$INSTALLED_CDK" ]; then
  REQ_MAJOR=$(echo "$REQUIRED_CDK" | cut -d. -f1-2)
  INST_MAJOR=$(echo "$INSTALLED_CDK" | cut -d. -f1-2)
  if [ "$(printf '%s\n' "$REQUIRED_CDK" "$INSTALLED_CDK" | sort -V | head -1)" != "$INSTALLED_CDK" ] || [ "$INSTALLED_CDK" = "$REQUIRED_CDK" ]; then
    echo -e "${GREEN}[OK]${NC} CDK $INSTALLED_CDK"
  else
    echo -e "${YELLOW}CDK CLI $INSTALLED_CDK may be incompatible with aws-cdk-lib $REQUIRED_CDK. Upgrading...${NC}"
    npm install -g aws-cdk
    echo -e "${GREEN}[OK]${NC} CDK $(cdk --version 2>/dev/null | cut -d' ' -f1)"
  fi
else
  echo -e "${GREEN}[OK]${NC} CDK $(cdk --version 2>/dev/null | cut -d' ' -f1)"
fi

if ! command -v jq &> /dev/null; then
  echo -e "${YELLOW}Installing jq...${NC}"
  if command -v brew &> /dev/null; then brew install jq
  elif command -v apt-get &> /dev/null; then sudo apt-get install -y jq
  else echo "Install jq manually"; exit 1; fi
fi
echo -e "${GREEN}[OK]${NC} jq installed"

if ! command -v aws &> /dev/null; then
  echo -e "${YELLOW}Installing AWS CLI...${NC}"
  if [[ "$OSTYPE" == "darwin"* ]]; then
    curl "https://awscli.amazonaws.com/AWSCLIV2.pkg" -o "/tmp/AWSCLIV2.pkg"
    sudo installer -pkg /tmp/AWSCLIV2.pkg -target /
    rm /tmp/AWSCLIV2.pkg
  else
    curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "/tmp/awscliv2.zip"
    unzip -q /tmp/awscliv2.zip -d /tmp/
    sudo /tmp/aws/install
    rm -rf /tmp/aws /tmp/awscliv2.zip
  fi
fi
echo -e "${GREEN}[OK]${NC} AWS CLI installed"

if ! command -v python3 &> /dev/null; then
  echo -e "${RED}Python 3 required. Install from python.org${NC}"; exit 1
fi
echo -e "${GREEN}[OK]${NC} Python $(python3 --version | cut -d' ' -f2)"

echo ""
echo "Checking AWS credentials..."
if ! aws sts get-caller-identity &> /dev/null; then
  echo -e "${RED}AWS credentials not configured or expired. Run: aws configure${NC}"
  exit 1
fi
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=$(aws configure get region 2>/dev/null || echo "us-east-1")
echo -e "${GREEN}[OK]${NC} Account: $ACCOUNT_ID, Region: $REGION"

echo ""
echo "============================================"
echo "  Step 1/6: Install project dependencies"
echo "============================================"
npm install
(cd frontend && rm -rf node_modules && npm install)
if [ ! -d "frontend/node_modules/tailwindcss" ]; then
  echo -e "${RED}[ERROR]${NC} tailwindcss not installed in frontend. Build will fail."
  exit 1
fi

echo ""
echo "============================================"
echo "  Step 2/6: Bundle Lambda dependencies"
echo "============================================"
pip3 install --quiet --target lambda/harness-custom-resource boto3 --upgrade
pip3 install --quiet --target lambda/invoke-harness boto3 --upgrade
echo -e "${GREEN}[OK]${NC} boto3 bundled into Lambda folders"

echo ""
echo "============================================"
echo "  Step 3/6: Bootstrap CDK"
echo "============================================"
cdk bootstrap aws://$ACCOUNT_ID/$REGION 2>/dev/null || echo "Already bootstrapped."

# Pre-deploy cleanup: remove orphaned AgentCore resources and failed stacks
# This prevents ConflictException on fresh deploys after a previous failure
echo ""
echo "Pre-deploy cleanup..."
STACK_STATUS=$(aws cloudformation describe-stacks --stack-name ImageEditorStack --region "$REGION" --query "Stacks[0].StackStatus" --output text 2>/dev/null || echo "NONE")
if [ "$STACK_STATUS" = "ROLLBACK_COMPLETE" ] || [ "$STACK_STATUS" = "DELETE_FAILED" ]; then
  echo "  Removing failed stack ($STACK_STATUS)..."
  aws cloudformation delete-stack --stack-name ImageEditorStack --region "$REGION"
  aws cloudformation wait stack-delete-complete --stack-name ImageEditorStack --region "$REGION" 2>/dev/null || true
fi

for HID in $(aws bedrock-agentcore-control list-harnesses --region "$REGION" --query "harnesses[?starts_with(harnessName,'img_editor')].harnessId" --output text 2>/dev/null); do
  echo "  Cleaning orphaned harness: $HID"
  aws bedrock-agentcore-control delete-harness --harness-id "$HID" --region "$REGION" 2>/dev/null || true
  sleep 5
done

for MID in $(aws bedrock-agentcore-control list-memories --region "$REGION" --output json 2>/dev/null | python3 -c "
import json,sys
data=json.load(sys.stdin)
for m in data.get('memories',[]):
    mid=m.get('id','')
    if 'img_editor' in mid:
        print(mid)
" 2>/dev/null); do
  echo "  Cleaning orphaned memory: $MID"
  aws bedrock-agentcore-control delete-memory --memory-id "$MID" --region "$REGION" 2>/dev/null || true
done
echo -e "${GREEN}[OK]${NC} Pre-deploy cleanup complete"

echo ""
echo "============================================"
echo "  Step 4/6: Deploy CDK stack"
echo "============================================"
cdk deploy --require-approval never --outputs-file cdk-outputs.json

echo ""
echo "============================================"
echo "  Step 5/6: Build and deploy frontend"
echo "============================================"

USER_POOL_ID=$(jq -r '.ImageEditorStack.UserPoolId' cdk-outputs.json)
USER_POOL_CLIENT_ID=$(jq -r '.ImageEditorStack.UserPoolClientId' cdk-outputs.json)
IDENTITY_POOL_ID=$(jq -r '.ImageEditorStack.IdentityPoolId' cdk-outputs.json)
BUCKET_NAME=$(jq -r '.ImageEditorStack.ImageBucketName' cdk-outputs.json)
HARNESS_ID=$(jq -r '.ImageEditorStack.HarnessId' cdk-outputs.json)
INVOKE_FN=$(jq -r '.ImageEditorStack.InvokeHarnessFunctionName' cdk-outputs.json)
APP_URL=$(jq -r '.ImageEditorStack.AmplifyAppUrl' cdk-outputs.json)
AMPLIFY_APP_ID=$(echo "$APP_URL" | sed 's|https://main\.||' | sed 's|\.amplifyapp\.com||')

cat > frontend/.env << ENVFILE
VITE_USER_POOL_ID=$USER_POOL_ID
VITE_USER_POOL_CLIENT_ID=$USER_POOL_CLIENT_ID
VITE_IDENTITY_POOL_ID=$IDENTITY_POOL_ID
VITE_IMAGE_BUCKET_NAME=$BUCKET_NAME
VITE_HARNESS_ID=$HARNESS_ID
VITE_INVOKE_HARNESS_FUNCTION_NAME=$INVOKE_FN
VITE_AWS_REGION=$REGION
ENVFILE

(cd frontend && npm run build)

# Verify CSS was generated (Tailwind processing worked)
if ! ls frontend/dist/assets/*.css 1>/dev/null 2>&1; then
  echo -e "${RED}[ERROR]${NC} No CSS file in build output. Tailwind processing failed."
  exit 1
fi
echo -e "${GREEN}[OK]${NC} Frontend built ($(du -sh frontend/dist/assets/*.css | cut -f1) CSS)"

# Create zip from dist folder
(cd frontend/dist && zip -qr /tmp/fe-deploy.zip .)

DEPLOY_JSON=$(aws amplify create-deployment --app-id "$AMPLIFY_APP_ID" --branch-name main --region "$REGION" --output json)
JOB_ID=$(echo "$DEPLOY_JSON" | jq -r '.jobId')
UPLOAD_URL=$(echo "$DEPLOY_JSON" | jq -r '.zipUploadUrl')

curl -T /tmp/fe-deploy.zip "$UPLOAD_URL" --fail --silent --show-error
aws amplify start-deployment --app-id "$AMPLIFY_APP_ID" --branch-name main --job-id "$JOB_ID" --region "$REGION" > /dev/null

echo "Waiting for Amplify deployment..."
for i in $(seq 1 30); do
  STATUS=$(aws amplify get-job --app-id "$AMPLIFY_APP_ID" --branch-name main --job-id "$JOB_ID" --region "$REGION" --query 'job.summary.status' --output text 2>/dev/null)
  if [ "$STATUS" = "SUCCEED" ]; then echo -e "${GREEN}[OK]${NC} Frontend live!"; break; fi
  if [ "$STATUS" = "FAILED" ]; then echo -e "${RED}Frontend deploy failed${NC}"; exit 1; fi
  sleep 5
done
rm -f /tmp/fe-deploy.zip

echo ""
echo "============================================"
echo "  Step 6/6: Create test user"
echo "============================================"
TEST_PASSWORD="$(openssl rand -base64 12)Aa1!"
aws cognito-idp admin-create-user --user-pool-id "$USER_POOL_ID" --username "demo@example.com" --user-attributes Name=email,Value=demo@example.com Name=email_verified,Value=true --message-action SUPPRESS --region "$REGION" 2>/dev/null || true
aws cognito-idp admin-set-user-password --user-pool-id "$USER_POOL_ID" --username "demo@example.com" --password "$TEST_PASSWORD" --permanent --region "$REGION" 2>/dev/null || true
echo -e "${GREEN}[OK]${NC} Test user ready"

echo ""
echo "============================================"
echo -e "  ${GREEN}DEPLOYMENT COMPLETE${NC}"
echo "============================================"
echo ""
echo "  App URL:   $APP_URL"
echo "  Email:     demo@example.com"
echo "  Password:  $TEST_PASSWORD"
echo ""
echo "  Account:   $ACCOUNT_ID"
echo "  Region:    $REGION"
echo "============================================"
