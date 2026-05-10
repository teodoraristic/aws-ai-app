"use strict";

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");

const TABLE = process.env.TABLE_NAME;

const base = new DynamoDBClient({});
const doc = DynamoDBDocumentClient.from(base, {
  marshallOptions: { removeUndefinedValues: true },
});

async function getItem(pk, sk) {
  const out = await doc.send(
    new GetCommand({ TableName: TABLE, Key: { PK: pk, SK: sk } })
  );
  return out.Item || null;
}

async function putItem(item) {
  await doc.send(new PutCommand({ TableName: TABLE, Item: item }));
  return item;
}

async function deleteItem(pk, sk) {
  await doc.send(
    new DeleteCommand({ TableName: TABLE, Key: { PK: pk, SK: sk } })
  );
}

// Query a partition. `options` is optional and supports:
//   - limit:        DDB Limit (max items)
//   - scanForward:  false to get items in DESC SK order (newest-first when
//                   the SK encodes a timestamp prefix, like NOTIF#<epoch>)
async function queryPk(pk, skPrefix = null, options = {}) {
  const params = {
    TableName: TABLE,
    KeyConditionExpression: "PK = :pk",
    ExpressionAttributeValues: { ":pk": pk },
  };
  if (skPrefix) {
    params.KeyConditionExpression += " AND begins_with(SK, :prefix)";
    params.ExpressionAttributeValues[":prefix"] = skPrefix;
  }
  if (options.limit) params.Limit = options.limit;
  if (options.scanForward === false) params.ScanIndexForward = false;
  const out = await doc.send(new QueryCommand(params));
  return out.Items || [];
}

async function queryGsi1(gsi1pk, gsi1skPrefix = null) {
  const params = {
    TableName: TABLE,
    IndexName: "GSI1",
    KeyConditionExpression: "GSI1PK = :pk",
    ExpressionAttributeValues: { ":pk": gsi1pk },
  };
  if (gsi1skPrefix) {
    params.KeyConditionExpression += " AND begins_with(GSI1SK, :prefix)";
    params.ExpressionAttributeValues[":prefix"] = gsi1skPrefix;
  }
  const out = await doc.send(new QueryCommand(params));
  return out.Items || [];
}

async function queryGsi1Page(gsi1pk, gsi1skPrefix = null, { limit, exclusiveStartKey } = {}) {
  const params = {
    TableName: TABLE,
    IndexName: "GSI1",
    KeyConditionExpression: "GSI1PK = :pk",
    ExpressionAttributeValues: { ":pk": gsi1pk },
  };
  if (gsi1skPrefix) {
    params.KeyConditionExpression += " AND begins_with(GSI1SK, :prefix)";
    params.ExpressionAttributeValues[":prefix"] = gsi1skPrefix;
  }
  if (limit) params.Limit = limit;
  if (exclusiveStartKey) params.ExclusiveStartKey = exclusiveStartKey;
  const out = await doc.send(new QueryCommand(params));
  return { items: out.Items || [], lastEvaluatedKey: out.LastEvaluatedKey || null };
}

async function queryGsi2(gsi2pk, gsi2skPrefix = null) {
  const params = {
    TableName: TABLE,
    IndexName: "GSI2",
    KeyConditionExpression: "GSI2PK = :pk",
    ExpressionAttributeValues: { ":pk": gsi2pk },
  };
  if (gsi2skPrefix) {
    params.KeyConditionExpression += " AND begins_with(GSI2SK, :prefix)";
    params.ExpressionAttributeValues[":prefix"] = gsi2skPrefix;
  }
  const out = await doc.send(new QueryCommand(params));
  return out.Items || [];
}

async function updateItem(pk, sk, updates, condition = null) {
  const names = {};
  const values = {};
  const sets = [];
  for (const [key, value] of Object.entries(updates)) {
    const nameRef = `#${key}`;
    const valueRef = `:${key}`;
    names[nameRef] = key;
    values[valueRef] = value;
    sets.push(`${nameRef} = ${valueRef}`);
  }
  if (sets.length === 0) {
    throw new Error("updateItem: updates object is empty");
  }
  const params = {
    TableName: TABLE,
    Key: { PK: pk, SK: sk },
    UpdateExpression: `SET ${sets.join(", ")}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    ReturnValues: "ALL_NEW",
  };
  if (condition) {
    params.ConditionExpression = condition.expression;
    if (condition.names) Object.assign(params.ExpressionAttributeNames, condition.names);
    if (condition.values) Object.assign(params.ExpressionAttributeValues, condition.values);
  }
  const out = await doc.send(new UpdateCommand(params));
  return out.Attributes;
}

// All-or-nothing multi-item write. Each entry of `items` is shaped exactly
// like the DDB DocumentClient's TransactWriteCommand input — one of
// `{ Put | Update | Delete | ConditionCheck }`. We pre-fill `TableName` so
// callers can stay terse:
//
//   transactWrite([
//     { Put: { Item: { PK, SK, ... } } },
//     { Update: { Key: { PK, SK }, ... } },
//   ])
//
// Throws on any condition-check failure — the caller distinguishes
// concurrent-claim vs duplicate-row failures by inspecting
// `e.CancellationReasons` (DDB sets a per-item `Code: "ConditionalCheckFailed"`
// for the offending row).
async function transactWrite(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("transactWrite: items must be a non-empty array");
  }
  const TransactItems = items.map((entry) => {
    if (entry.Put) return { Put: { TableName: TABLE, ...entry.Put } };
    if (entry.Update) return { Update: { TableName: TABLE, ...entry.Update } };
    if (entry.Delete) return { Delete: { TableName: TABLE, ...entry.Delete } };
    if (entry.ConditionCheck)
      return { ConditionCheck: { TableName: TABLE, ...entry.ConditionCheck } };
    throw new Error("transactWrite: unsupported entry shape");
  });
  await doc.send(new TransactWriteCommand({ TransactItems }));
}

module.exports = {
  getItem,
  putItem,
  deleteItem,
  queryPk,
  queryGsi1,
  queryGsi1Page,
  queryGsi2,
  updateItem,
  transactWrite,
};
