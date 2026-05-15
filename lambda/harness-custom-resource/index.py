"""
CloudFormation Custom Resource handler for Amazon Bedrock AgentCore Harness lifecycle.

Handles Create, Update, and Delete events to manage an Amazon Bedrock AgentCore Harness
via the bedrock-agentcore-control API.
"""

import json
import logging
import urllib.request
import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

SUCCESS = "SUCCESS"
FAILED = "FAILED"

client = boto3.client('bedrock-agentcore-control')


def send_cfn_response(event, context, status, data, physical_resource_id=None):
    """Send response to CloudFormation via the pre-signed S3 URL."""
    response_body = json.dumps({
        "Status": status,
        "Reason": f"See CloudWatch Log Stream: {context.log_stream_name}",
        "PhysicalResourceId": physical_resource_id or context.log_stream_name,
        "StackId": event["StackId"],
        "RequestId": event["RequestId"],
        "LogicalResourceId": event["LogicalResourceId"],
        "Data": data or {},
    }).encode("utf-8")

    req = urllib.request.Request(
        event["ResponseURL"],
        data=response_body,
        headers={"Content-Type": ""},
        method="PUT",
    )
    if not event["ResponseURL"].startswith("https://"):
        raise ValueError("ResponseURL must be HTTPS")
    urllib.request.urlopen(req)  # nosec B310 - URL is validated HTTPS from CloudFormation


def handler(event, context):
    """CloudFormation Custom Resource handler."""
    request_type = event['RequestType']
    props = event['ResourceProperties']

    logger.info(f"Request type: {request_type}")
    logger.info(f"Properties: {json.dumps(props, default=str)}")

    try:
        if request_type == 'Create':
            return _create_harness(event, context, props)
        elif request_type == 'Update':
            return _update_harness(event, context, props)
        elif request_type == 'Delete':
            return _delete_harness(event, context)
        else:
            send_cfn_response(event, context, FAILED, {
                'Error': f'Unknown request type: {request_type}'
            })
    except Exception as e:
        logger.error(f"Error handling {request_type}: {str(e)}", exc_info=True)
        send_cfn_response(event, context, FAILED, {'Error': str(e)})


def _create_harness(event, context, props):
    """Create a new AgentCore Harness."""
    import time

    tools = json.loads(props['Tools']) if isinstance(props['Tools'], str) else props['Tools']

    # Create Memory for conversation persistence
    memory_name = props['HarnessName'] + '_mem'
    logger.info(f"Creating memory: {memory_name}")

    memory_arn = None
    try:
        memory_response = client.create_memory(
            name=memory_name,
            eventExpiryDuration=30,  # 30 days
            description='Conversation memory for image editor',
        )
        memory_arn = memory_response['memory']['arn']
        logger.info(f"Created memory: {memory_arn}")
    except client.exceptions.ValidationException as e:
        # Memory already exists - look it up
        if 'already exists' in str(e):
            logger.info(f"Memory {memory_name} already exists, looking up ARN")
            memories = client.list_memories()
            for mem in memories.get('memories', []):
                if mem.get('name') == memory_name or memory_name in mem.get('id', ''):
                    memory_arn = mem['arn']
                    logger.info(f"Found existing memory: {memory_arn}")
                    break
        else:
            logger.warning(f"Could not create memory: {str(e)}")
    except Exception as e:
        logger.warning(f"Could not create memory: {str(e)}")

    # Build harness params
    harness_params = {
        'harnessName': props['HarnessName'],
        'executionRoleArn': props['ExecutionRoleArn'],
        'model': {'bedrockModelConfig': {'modelId': props['ModelId']}},
        'systemPrompt': [{'text': props['SystemPrompt']}],
        'tools': tools,
        'allowedTools': ['*'],
        'maxIterations': int(props.get('MaxIterations', 10)),
        'timeoutSeconds': int(props.get('TimeoutSeconds', 120)),
    }

    # Attach memory if created successfully
    if memory_arn:
        harness_params['memory'] = {
            'agentCoreMemoryConfiguration': {
                'arn': memory_arn,
            }
        }

    # Retry with backoff for IAM propagation delay on fresh deployments
    max_retries = 5
    response = None
    for attempt in range(max_retries):
        try:
            response = client.create_harness(**harness_params)
            break
        except client.exceptions.ConflictException:
            # Harness already exists (orphaned from previous deploy) - look it up
            logger.info(f"Harness {props['HarnessName']} already exists, looking up ID")
            harnesses = client.list_harnesses()
            for h in harnesses.get('harnesses', []):
                if h.get('harnessName') == props['HarnessName']:
                    harness_id = h['harnessId']
                    logger.info(f"Found existing harness: {harness_id}")
                    send_cfn_response(event, context, SUCCESS, {
                        'HarnessId': harness_id,
                    }, harness_id)
                    return
            # If we can't find it, delete and retry
            raise
        except client.exceptions.AccessDeniedException as e:
            if attempt < max_retries - 1:
                wait = 2 ** attempt * 5  # 5, 10, 20, 40, 80 seconds
                logger.warning(f"AccessDenied on attempt {attempt + 1}, retrying in {wait}s (IAM propagation)")
                time.sleep(wait)
            else:
                raise

    harness_id = response['harness']['harnessId']
    logger.info(f"Created harness: {harness_id}")

    send_cfn_response(event, context, SUCCESS, {
        'HarnessId': harness_id,
    }, harness_id)


def _update_harness(event, context, props):
    """Update harness configuration in place."""
    old_harness_id = event.get('PhysicalResourceId')
    logger.info(f"Updating harness: {old_harness_id}")

    try:
        tools = json.loads(props['Tools']) if isinstance(props['Tools'], str) else props['Tools']

        update_params = {
            'harnessId': old_harness_id,
            'model': {'bedrockModelConfig': {'modelId': props['ModelId']}},
            'systemPrompt': [{'text': props['SystemPrompt']}],
            'tools': tools,
            'allowedTools': ['*'],
            'maxIterations': int(props.get('MaxIterations', 10)),
            'timeoutSeconds': int(props.get('TimeoutSeconds', 120)),
        }

        client.update_harness(**update_params)
        logger.info(f"Updated harness: {old_harness_id}")

        send_cfn_response(event, context, SUCCESS, {
            'HarnessId': old_harness_id,
        }, old_harness_id)

    except Exception as e:
        logger.error(f"Error updating harness: {str(e)}")
        # If update fails, keep the old resource
        send_cfn_response(event, context, FAILED, {'Error': str(e)}, old_harness_id)


def _delete_harness(event, context):
    """Delete an existing AgentCore Harness."""
    harness_id = event.get('PhysicalResourceId')

    if not harness_id or harness_id == 'NONE':
        logger.warning("No PhysicalResourceId found, nothing to delete")
        send_cfn_response(event, context, SUCCESS, {}, 'NONE')
        return

    try:
        client.delete_harness(harnessId=harness_id)
        logger.info(f"Deleted harness: {harness_id}")
    except Exception as e:
        logger.warning(f"Error deleting harness {harness_id}: {str(e)}")

    # Try to delete associated memory
    props = event.get('ResourceProperties', {})
    memory_name = props.get('HarnessName', '') + '_mem'
    try:
        memories = client.list_memories()
        for mem in memories.get('memories', []):
            if mem.get('name') == memory_name:
                client.delete_memory(memoryId=mem['id'])
                logger.info(f"Deleted memory: {mem['id']}")
                break
    except Exception as e:
        logger.warning(f"Could not delete memory {memory_name}: {str(e)}")

    send_cfn_response(event, context, SUCCESS, {}, harness_id)
