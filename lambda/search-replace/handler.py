"""Search and Replace Lambda function for serverless agentic image editor.

Retrieves a source image from Amazon S3, invokes the Stability AI search-and-replace
model via Amazon Bedrock to find an object by description and replace it
(no mask needed), stores the result back in S3, and returns a structured
JSON response.
"""

import base64
import json
import os
import time
import traceback
from uuid import uuid4

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError, ReadTimeoutError

# Environment variables
IMAGE_BUCKET_NAME = os.environ.get("IMAGE_BUCKET_NAME", "")
KMS_KEY_ARN = os.environ.get("KMS_KEY_ARN", "")

# Bedrock client with 30-second read timeout for model invocation
bedrock_config = Config(
    read_timeout=30,
    retries={"max_attempts": 0},
)
bedrock_client = boto3.client("bedrock-runtime", config=bedrock_config)
s3_client = boto3.client("s3")

# Stability AI search-and-replace model ID
SEARCH_REPLACE_MODEL_ID = "us.stability.stable-image-search-replace-v1:0"


def _log(request_id, image_keys, duration_ms, outcome, stack_trace=None):
    """Emit a structured JSON log entry to stdout."""
    entry = {
        "request_id": request_id,
        "image_keys": image_keys,
        "duration_ms": duration_ms,
        "outcome": outcome,
    }
    if stack_trace is not None:
        entry["stack_trace"] = stack_trace
    print(json.dumps(entry), flush=True)


def _error_response(error_category, message, request_id=None):
    """Build a structured error response dict."""
    resp = {
        "error": True,
        "error_category": error_category,
        "message": message,
    }
    if request_id:
        resp["request_id"] = request_id
    return resp


def _extract_identity_id(source_image_key):
    """Extract the identity_id segment from a key like users/{identity_id}/uploads/{uuid}.png."""
    parts = source_image_key.split("/")
    if len(parts) >= 2 and parts[0] == "users":
        return parts[1]
    return None


def handler(event, context):
    """Lambda entry point for search-and-replace operations."""
    request_id = getattr(context, "aws_request_id", str(uuid4()))
    start_time = time.time()
    image_keys = []

    try:
        # --- Input validation ---
        source_image_key = event.get("source_image_key", "")
        search_prompt = event.get("search_prompt", "")
        prompt = event.get("prompt", "")

        if not source_image_key or not isinstance(source_image_key, str):
            duration_ms = int((time.time() - start_time) * 1000)
            _log(request_id, image_keys, duration_ms, "VALIDATION_ERROR")
            return _error_response(
                "VALIDATION_ERROR",
                "source_image_key is required and must be a non-empty string",
                request_id,
            )

        # Validate S3 key pattern to prevent path traversal
        import re
        _KEY_PATTERN = re.compile(r'^users/[a-zA-Z0-9:_-]+/(uploads|masks|results)/[a-f0-9-]+\.(png|jpg)$')
        if not _KEY_PATTERN.match(source_image_key):
            duration_ms = int((time.time() - start_time) * 1000)
            _log(request_id, image_keys, duration_ms, "VALIDATION_ERROR")
            return _error_response("VALIDATION_ERROR", "Invalid source_image_key format", request_id)

        if not search_prompt or not isinstance(search_prompt, str):
            duration_ms = int((time.time() - start_time) * 1000)
            _log(request_id, image_keys, duration_ms, "VALIDATION_ERROR")
            return _error_response(
                "VALIDATION_ERROR",
                "search_prompt is required and must be a non-empty string",
                request_id,
            )

        if not prompt or not isinstance(prompt, str):
            duration_ms = int((time.time() - start_time) * 1000)
            _log(request_id, image_keys, duration_ms, "VALIDATION_ERROR")
            return _error_response(
                "VALIDATION_ERROR",
                "prompt is required and must be a non-empty string",
                request_id,
            )

        if len(search_prompt) > 500:
            duration_ms = int((time.time() - start_time) * 1000)
            _log(request_id, image_keys, duration_ms, "VALIDATION_ERROR")
            return _error_response(
                "VALIDATION_ERROR",
                "search_prompt must be 500 characters or fewer",
                request_id,
            )

        if len(prompt) > 2000:
            duration_ms = int((time.time() - start_time) * 1000)
            _log(request_id, image_keys, duration_ms, "VALIDATION_ERROR")
            return _error_response(
                "VALIDATION_ERROR",
                "prompt must be 2000 characters or fewer",
                request_id,
            )

        image_keys = [source_image_key]

        # --- Retrieve source image from S3 ---
        try:
            source_response = s3_client.get_object(
                Bucket=IMAGE_BUCKET_NAME, Key=source_image_key
            )
            source_image_bytes = source_response["Body"].read()
        except ClientError as e:
            duration_ms = int((time.time() - start_time) * 1000)
            _log(request_id, image_keys, duration_ms, "STORAGE_ERROR")
            return _error_response(
                "STORAGE_ERROR",
                f"Failed to retrieve source image: {str(e)}",
                request_id,
            )

        # --- Base64 encode image ---
        source_b64 = base64.b64encode(source_image_bytes).decode("utf-8")

        # --- Construct Bedrock InvokeModel request ---
        request_body = json.dumps({
            "prompt": prompt,
            "image": source_b64,
            "search_prompt": search_prompt,
            "negative_prompt": "distorted, deformed, extra limbs, extra wheels, duplicate parts, blurry, low quality, artifacts",
            "output_format": "png",
        })

        # --- Invoke model with 30-second timeout ---
        try:
            model_response = bedrock_client.invoke_model(
                modelId=SEARCH_REPLACE_MODEL_ID,
                contentType="application/json",
                accept="application/json",
                body=request_body,
            )
        except ReadTimeoutError:
            duration_ms = int((time.time() - start_time) * 1000)
            _log(request_id, image_keys, duration_ms, "TIMEOUT_ERROR")
            return _error_response(
                "TIMEOUT_ERROR",
                "Model invocation timed out after 30 seconds",
                request_id,
            )
        except ClientError as e:
            duration_ms = int((time.time() - start_time) * 1000)
            _log(request_id, image_keys, duration_ms, "MODEL_ERROR")
            return _error_response(
                "MODEL_ERROR",
                f"Model invocation failed: {str(e)}",
                request_id,
            )

        # --- Parse model response ---
        response_body = json.loads(model_response["body"].read())

        # Extract result image (base64-encoded)
        if "images" in response_body and len(response_body["images"]) > 0:
            result_b64 = response_body["images"][0]
        elif "image" in response_body:
            result_b64 = response_body["image"]
        else:
            duration_ms = int((time.time() - start_time) * 1000)
            _log(request_id, image_keys, duration_ms, "MODEL_ERROR")
            return _error_response(
                "MODEL_ERROR",
                "Model response did not contain a result image",
                request_id,
            )

        # Decode result image
        result_image_bytes = base64.b64decode(result_b64)

        # Extract model seed if available
        model_seed = response_body.get(
            "seed",
            response_body.get("seeds", [None])[0]
            if "seeds" in response_body
            else None,
        )

        # --- Store result in S3 ---
        identity_id = _extract_identity_id(source_image_key)
        result_uuid = str(uuid4())

        if identity_id:
            result_image_key = f"users/{identity_id}/results/{result_uuid}.png"
        else:
            result_image_key = f"results/{result_uuid}.png"

        try:
            put_params = {
                "Bucket": IMAGE_BUCKET_NAME,
                "Key": result_image_key,
                "Body": result_image_bytes,
                "ContentType": "image/png",
            }
            s3_client.put_object(**put_params)
        except ClientError as e:
            duration_ms = int((time.time() - start_time) * 1000)
            _log(request_id, image_keys, duration_ms, "STORAGE_ERROR")
            return _error_response(
                "STORAGE_ERROR",
                f"Failed to store result image: {str(e)}",
                request_id,
            )

        # --- Success response ---
        image_keys.append(result_image_key)
        duration_ms = int((time.time() - start_time) * 1000)
        _log(request_id, image_keys, duration_ms, "SUCCESS")

        result = {
            "result_image_key": result_image_key,
            "message": f"Successfully replaced '{search_prompt}' with '{prompt}'",
        }
        if model_seed is not None:
            result["model_seed"] = model_seed

        return result

    except Exception as e:
        # --- Global exception handler ---
        duration_ms = int((time.time() - start_time) * 1000)
        stack = traceback.format_exc()
        _log(request_id, image_keys, duration_ms, "ERROR", stack_trace=stack)
        return _error_response(
            "MODEL_ERROR",
            f"Unexpected error: {str(e)}",
            request_id,
        )
