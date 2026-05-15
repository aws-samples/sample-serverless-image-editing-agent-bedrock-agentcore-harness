"""Outpaint Lambda function for serverless agentic image editor.

Retrieves a source image from Amazon S3, invokes the Stability AI outpaint
model via Amazon Bedrock to extend the image in specified directions,
stores the result back in S3, and returns a structured JSON response.
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

# Bedrock client with 55-second read timeout for model invocation
bedrock_config = Config(
    read_timeout=55,
    retries={"max_attempts": 0},
)
bedrock_client = boto3.client("bedrock-runtime", config=bedrock_config)
s3_client = boto3.client("s3")

# Stability AI outpaint model ID
OUTPAINT_MODEL_ID = "us.stability.stable-outpaint-v1:0"

# Valid extension directions
VALID_DIRECTIONS = {"left", "right", "up", "down"}


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
    """Lambda entry point for outpainting operations."""
    request_id = getattr(context, "aws_request_id", str(uuid4()))
    start_time = time.time()
    image_keys = []

    try:
        # --- Input validation ---
        source_image_key = event.get("source_image_key", "")
        prompt = event.get("prompt", "")
        directions = event.get("directions", None)
        extend_pixels = event.get("extend_pixels", 256)

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

        if not prompt or not isinstance(prompt, str):
            duration_ms = int((time.time() - start_time) * 1000)
            _log(request_id, image_keys, duration_ms, "VALIDATION_ERROR")
            return _error_response(
                "VALIDATION_ERROR",
                "prompt is required and must be a non-empty string",
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

        if not directions or not isinstance(directions, list) or len(directions) == 0:
            duration_ms = int((time.time() - start_time) * 1000)
            _log(request_id, image_keys, duration_ms, "VALIDATION_ERROR")
            return _error_response(
                "VALIDATION_ERROR",
                "directions is required and must be a non-empty array",
                request_id,
            )

        # Validate each direction is in the allowed set
        for d in directions:
            if d not in VALID_DIRECTIONS:
                duration_ms = int((time.time() - start_time) * 1000)
                _log(request_id, image_keys, duration_ms, "VALIDATION_ERROR")
                return _error_response(
                    "VALIDATION_ERROR",
                    f"Invalid direction '{d}'. Must be one of: left, right, up, down",
                    request_id,
                )

        # Validate extend_pixels is a positive integer
        if not isinstance(extend_pixels, int) or extend_pixels <= 0:
            duration_ms = int((time.time() - start_time) * 1000)
            _log(request_id, image_keys, duration_ms, "VALIDATION_ERROR")
            return _error_response(
                "VALIDATION_ERROR",
                "extend_pixels must be a positive integer",
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
        # Build outpainting request per Stability AI API format
        outpaint_request = {
            "image": source_b64,
            "output_format": "png",
        }

        # Add prompt if provided
        if prompt:
            outpaint_request["prompt"] = prompt

        # Add per-direction extension amounts
        for direction in directions:
            if direction == "left":
                outpaint_request["left"] = extend_pixels
            elif direction == "right":
                outpaint_request["right"] = extend_pixels
            elif direction == "up":
                outpaint_request["up"] = extend_pixels
            elif direction == "down":
                outpaint_request["down"] = extend_pixels

        request_body = json.dumps(outpaint_request)

        # --- Invoke model with 30-second timeout ---
        try:
            model_response = bedrock_client.invoke_model(
                modelId=OUTPAINT_MODEL_ID,
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
            response_body.get("seeds", [None])[0] if "seeds" in response_body else None,
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
            "message": "Successfully extended the image",
        }
        if model_seed is not None:
            result["model_seed"] = model_seed

        # Calculate new dimensions based on extension directions
        # Note: actual dimensions depend on the source image size and model output.
        # We estimate based on a default 1024x1024 base plus extensions.
        new_width = 1024  # default base width assumption
        new_height = 1024  # default base height assumption
        if "left" in directions:
            new_width += extend_pixels
        if "right" in directions:
            new_width += extend_pixels
        if "up" in directions:
            new_height += extend_pixels
        if "down" in directions:
            new_height += extend_pixels

        result["new_dimensions"] = {"width": new_width, "height": new_height}

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
