export const config = {
  userPoolId: import.meta.env.VITE_USER_POOL_ID,
  userPoolClientId: import.meta.env.VITE_USER_POOL_CLIENT_ID,
  identityPoolId: import.meta.env.VITE_IDENTITY_POOL_ID,
  imageBucketName: import.meta.env.VITE_IMAGE_BUCKET_NAME,
  harnessId: import.meta.env.VITE_HARNESS_ID,
  invokeHarnessFunctionName: import.meta.env.VITE_INVOKE_HARNESS_FUNCTION_NAME,
  region: import.meta.env.VITE_AWS_REGION || 'us-east-1',
};
