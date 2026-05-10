# Lambda Patterns for this project

## Standard handler structure
const { getItem, putItem, queryPk, queryGsi1, queryGsi2, updateItem } = require('/opt/nodejs/db');
const { ok, created, badRequest, unauthorized, notFound, error } = require('/opt/nodejs/response');
const { getCaller } = require('/opt/nodejs/auth');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return ok({});
  try {
    const caller = getCaller(event);
    // business logic
  } catch (e) {
    console.error(e);
    return error(e.message);
  }
};

## DynamoDB key construction
Always use f-strings: f"USER#{userId}", f"PROFESSOR#{professorId}", f"SLOT#{date}T{time}"
Never hardcode keys as plain strings.

## Bedrock converse() call
client = boto3.client("bedrock-runtime", region_name=os.environ["BEDROCK_REGION"])
response = client.converse(
    modelId=os.environ["BEDROCK_MODEL_ID"],
    system=[{"text": system_prompt}],
    messages=messages,
    toolConfig={"tools": tools},
    inferenceConfig={"maxTokens": 512}
)
stopReason = response["stopReason"]
content = response["output"]["message"]["content"]