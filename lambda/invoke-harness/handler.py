"""
Thin proxy AWS Lambda function that invokes an AgentCore Harness on behalf of the frontend.

The frontend calls this Lambda (via the Identity Pool credentials), and this Lambda
calls the InvokeHarness API using its execution role.
"""

import json
import logging
import os
import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

HARNESS_ID = os.environ['HARNESS_ID']
AWS_REGION = os.environ.get('AWS_REGION', 'us-east-1')
ACCOUNT_ID = os.environ.get('ACCOUNT_ID', '')
ALLOWED_ORIGIN = os.environ.get('ALLOWED_ORIGIN', '*')

client = boto3.client('bedrock-agentcore')


def handler(event, context):
    """
    Expects event:
    {
        "prompt": "user message text",
        "sessionId": "session ID for multi-turn (must be 33+ chars)",
        "sourceImageKey": "optional S3 key",
        "maskKey": "optional S3 key"
    }
    """
    logger.info(f"Received event: {json.dumps(event, default=str)}")

    # Parse input - support both direct invocation and API Gateway proxy
    if isinstance(event.get('body'), str):
        body = json.loads(event['body'])
    elif isinstance(event.get('body'), dict):
        body = event['body']
    else:
        body = event

    prompt = body.get('prompt', '')
    session_id = body.get('sessionId', '')
    source_image_key = body.get('sourceImageKey')
    mask_key = body.get('maskKey')
    model_override = body.get('modelOverride')
    persona_override = body.get('personaOverride', 'general')

    if not prompt:
        return {
            'statusCode': 400,
            'headers': {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': ALLOWED_ORIGIN},
            'body': json.dumps({'error': 'prompt is required'}),
        }

    if len(prompt) > 2000:
        return {
            'statusCode': 400,
            'headers': {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': ALLOWED_ORIGIN},
            'body': json.dumps({'error': 'prompt must be 2000 characters or fewer'}),
        }

    # Ensure session ID is at least 33 characters (API requirement)
    if len(session_id) < 33:
        session_id = session_id + '-' + '0' * (33 - len(session_id) - 1)

    actor_id = body.get('actorId', 'default-user')

    # Build the input content
    input_parts = [prompt]
    if source_image_key:
        input_parts.append(f'[source_image_key: {source_image_key}]')
    if mask_key:
        input_parts.append(f'[mask_key: {mask_key}]')

    input_text = '\n'.join(input_parts)

    # Construct the Harness ARN from the ID
    account_id = ACCOUNT_ID or context.invoked_function_arn.split(':')[4]
    harness_arn = f'arn:aws:bedrock-agentcore:{AWS_REGION}:{account_id}:harness/{HARNESS_ID}'

    # Build InvokeHarness request
    invoke_params = {
        'harnessArn': harness_arn,
        'runtimeSessionId': session_id,
        'messages': [
            {
                'role': 'user',
                'content': [
                    {'text': input_text}
                ],
            }
        ],
        'actorId': actor_id,
    }

    # Add model override if specified
    if model_override:
        invoke_params['model'] = {
            'bedrockModelConfig': {
                'modelId': model_override
            }
        }

    # Add persona as system prompt override
    PERSONAS = {
        'general': None,
        'real_estate': (
            'You specialize in real estate photography. Help enhance property photos: '
            'brighten rooms, replace cloudy skies with blue skies, remove clutter, '
            'stage empty rooms with virtual furniture, enhance curb appeal, fix dark interiors. '
            'Always suggest improvements that would make a property listing more attractive.'
        ),
        'retail': (
            'You specialize in e-commerce product photography. Help create professional '
            'product images: remove backgrounds, place products on clean white surfaces, '
            'fix product lighting, create lifestyle context, resize for different platforms. '
            'Focus on making products look appealing and professional.'
        ),
        'automotive': (
            'You specialize in automotive photography. Help enhance vehicle photos: '
            'fix paint reflections, clean up backgrounds, enhance interior shots, '
            'add dramatic lighting, remove license plates, create showroom-quality images. '
            'Make vehicles look their absolute best.'
        ),
    }

    persona_text = PERSONAS.get(persona_override)
    if persona_text:
        invoke_params['systemPrompt'] = [{'text': persona_text}]

    logger.info(f"Invoking harness: {harness_arn}, session: {session_id}")

    import time as _time
    start_ts = _time.time()

    try:
        response = client.invoke_harness(**invoke_params)

        # The response is a stream of events
        response_text = ''
        metadata_info = {}
        tool_used = None
        stop_reason = None
        stream = response.get('stream')

        if stream:
            for event in stream:
                if 'messageStart' in event:
                    pass
                elif 'contentBlockStart' in event:
                    # Check if a tool is being called
                    block = event['contentBlockStart']
                    if 'start' in block:
                        start_data = block['start']
                        if 'toolUse' in start_data:
                            tool_used = start_data['toolUse'].get('name', tool_used)
                elif 'contentBlockDelta' in event:
                    delta = event['contentBlockDelta']
                    if 'delta' in delta:
                        d = delta['delta']
                        if 'text' in d:
                            response_text += d['text']
                elif 'contentBlockStop' in event:
                    pass
                elif 'messageStop' in event:
                    stop_data = event['messageStop']
                    stop_reason = stop_data.get('stopReason')
                elif 'metadata' in event:
                    metadata_info = event['metadata']

        elapsed_ms = int((_time.time() - start_ts) * 1000)

        # Extract token usage from metadata
        usage = metadata_info.get('usage', {})
        input_tokens = usage.get('inputTokens', 0)
        output_tokens = usage.get('outputTokens', 0)

        logger.info(f"Harness response received, length: {len(response_text)}, tokens: {input_tokens}/{output_tokens}, tool: {tool_used}")

        # --- Post-processing: Add watermark via InvokeAgentRuntimeCommand ---
        # Runs a shell command on the harness microVM (no model reasoning, no token cost)
        watermarked = False
        if tool_used and 'result_image_key' in response_text:
            try:
                import re
                import base64 as _b64
                key_match = re.search(r'result_image_key:\s*"?([^"\s]+)"?', response_text)
                if key_match:
                    result_key = key_match.group(1)
                    # Validate key matches expected S3 path pattern to prevent injection
                    if not re.match(r'^users/[a-zA-Z0-9:_-]+/results/[a-f0-9-]+\.png$', result_key):
                        logger.warning(f"Invalid result_key pattern, skipping watermark: {result_key}")
                        raise ValueError("Invalid result_key pattern")
                    bucket_name = os.environ.get('IMAGE_BUCKET_NAME', '')

                    # Build the watermark Python script - tiles text across entire image
                    script = '\n'.join([
                        'import subprocess, sys',
                        'subprocess.check_call([sys.executable, "-m", "pip", "install", "-q", "Pillow", "boto3"])',
                        'from PIL import Image, ImageDraw, ImageFont',
                        'import boto3, io',
                        's3 = boto3.client("s3")',
                        f's3_bucket = "{bucket_name}"',
                        f's3_key = "{result_key}"',
                        'obj = s3.get_object(Bucket=s3_bucket, Key=s3_key)',
                        'img = Image.open(io.BytesIO(obj["Body"].read())).convert("RGBA")',
                        'w, h = img.size',
                        'overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))',
                        'draw = ImageDraw.Draw(overlay)',
                        'font_size = max(w // 12, 40)',
                        'try:',
                        '    font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", font_size)',
                        'except:',
                        '    font = ImageFont.load_default()',
                        'text = "AgentCore Harness"',
                        'bbox = draw.textbbox((0, 0), text, font=font)',
                        'tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]',
                        'step_x = tw + 60',
                        'step_y = th + 80',
                        'y = -th',
                        'while y < h + th:',
                        '    x = -tw',
                        '    while x < w + tw:',
                        '        draw.text((x, y), text, fill=(255, 255, 255, 100), font=font)',
                        '        x += step_x',
                        '    y += step_y',
                        'result = Image.alpha_composite(img, overlay).convert("RGB")',
                        'buf = io.BytesIO()',
                        'result.save(buf, format="PNG")',
                        'buf.seek(0)',
                        's3.put_object(Bucket=s3_bucket, Key=s3_key, Body=buf.getvalue(), ContentType="image/png")',
                        'print("watermark_applied")',
                    ])

                    # Base64 encode the script to avoid all shell escaping issues
                    encoded_script = _b64.b64encode(script.encode()).decode()

                    logger.info(f"Running watermark on microVM for key: {result_key}")

                    cmd_response = client.invoke_agent_runtime_command(
                        agentRuntimeArn=harness_arn,
                        runtimeSessionId=session_id,
                        body={'command': f'echo {encoded_script} | base64 -d | python3'},
                    )

                    cmd_output = ''
                    for cmd_event in cmd_response.get('stream', []):
                        chunk = cmd_event.get('chunk', {})
                        if 'contentDelta' in chunk:
                            delta = chunk['contentDelta']
                            cmd_output += delta.get('stdout', '')
                            stderr = delta.get('stderr', '')
                            if stderr:
                                logger.warning(f"Watermark stderr: {stderr}")

                    if 'watermark_applied' in cmd_output:
                        watermarked = True
                        logger.info(f"Watermark applied to {result_key}")
                    else:
                        logger.warning(f"Watermark command output: {cmd_output}")

            except Exception as wm_err:
                logger.warning(f"Watermark post-processing failed (non-fatal): {str(wm_err)}")

        result = {
            'responseText': response_text or 'Agent processed your request.',
            'sessionId': session_id,
            'metadata': {
                'model': model_override or 'us.anthropic.claude-sonnet-4-6',
                'persona': persona_override,
                'toolUsed': tool_used,
                'inputTokens': input_tokens,
                'outputTokens': output_tokens,
                'latencyMs': elapsed_ms,
                'stopReason': stop_reason,
                'watermarked': watermarked,
            },
        }

        return {
            'statusCode': 200,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
                'Access-Control-Allow-Headers': 'Content-Type,Authorization',
            },
            'body': json.dumps(result),
        }

    except Exception as e:
        err_str = str(e)
        logger.error(f"Error invoking harness: {err_str}", exc_info=True)

        # Detect a corrupted conversation history. This happens when two requests
        # run concurrently on the same session and interleave their writes to
        # AgentCore memory, leaving a tool_use block without a matching
        # tool_result. The session can never succeed again, so signal the
        # frontend to start a fresh session rather than retrying this one.
        is_corrupted = (
            'Expected toolResult blocks' in err_str
            or 'tool_use' in err_str and 'tool_result' in err_str
        )
        if is_corrupted:
            return {
                'statusCode': 409,
                'headers': {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
                },
                'body': json.dumps({
                    'error': 'session_corrupted',
                    'message': 'This conversation can no longer be continued. Starting a new session.',
                }),
            }

        return {
            'statusCode': 500,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
            },
            'body': json.dumps({
                'error': 'Internal server error',
                'message': 'Failed to invoke harness',
            }),
        }
