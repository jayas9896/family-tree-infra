// lambda/api-handler.ts
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDB } from 'aws-sdk';
import { create } from 'domain';

const dynamodb = new DynamoDB.DocumentClient();

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Credentials': true,
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Content-Length, X-Requested-With, X-Amz-Date, X-Api-Key, X-Amz-Security-Token',
  'Content-Type': 'application/json',
};

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    console.log('Event:', JSON.stringify(event, null, 2));
    // Basic router
    const path = event.path;
    const method = event.httpMethod;

    // Basic Routing
    switch (`${method} ${path}`) {
      case 'POST /api/person':
        return await createPerson(event);
      case 'GET /api/person':
        return await getPerson(event);
      default:
        return {
          statusCode: 404,
          headers: headers,
          body: JSON.stringify({ error: 'Not Found' }),
        };
    }
  } catch (error) {
    return {
      statusCode: 500,
      headers: headers,
      body: JSON.stringify({ error: 'Internal Server Error' }),
    };
  }
}

async function createPerson(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestBody = JSON.parse(event.body || '{}');
  const { id, name, age } = requestBody;

  if (!id || !name || !age) {
    return {
      statusCode: 400,
      headers: headers,
      body: JSON.stringify({ error: 'Missing required fields' }),
    };
  }

  const item = {
    id: Date.now().toString(),
    ...requestBody,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }

  const params = {
    TableName: process.env.PERSONS_TABLE! as string,
    Item: item,
  };

  try {
    await dynamodb.put(params).promise();
    return {
      statusCode: 201,
      headers: headers,
      body: JSON.stringify({ message: 'Person created successfully' }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: headers,
      body: JSON.stringify({ error: 'Could not create person' }),
    };
  }
}

async function getPerson(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const personId = event.queryStringParameters?.id;

  if (!personId) {
    return {
      statusCode: 400,
      headers: headers,
      body: JSON.stringify({ error: 'Missing person ID' }),
    };
  }

  const params = {
    TableName: 'Persons',
    Key: {
      id: personId,
    },
  };

  try {
    const result = await dynamodb.get(params).promise();
    if (!result.Item) {
      return {
        statusCode: 404,
        headers: headers,
        body: JSON.stringify({ error: 'Person not found' }),
      };
    }
    return {
      statusCode: 200,
      headers: headers,
      body: JSON.stringify(result.Item),
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: headers,
      body: JSON.stringify({ error: 'Could not retrieve person' }),
    };
  }
}
