# CDK Patterns for this project

- Always use PayPerRequest for DynamoDB billing
- Lambda runtime: Runtime.PYTHON_3_12
- Always grant table.grantReadWriteData(lambda) + explicit bedrock policy
- API Gateway: use LambdaIntegration with proxy: true
- CORS: enable on every route, allow origin *
- Cognito authorizer: attach to RestApi, use as default authorizer
- CloudFront + S3: always use OAC not OAI
- EventBridge: use Rule with Schedule.cron()
- Never use VPC for Lambda (cost)
- removalPolicy: DESTROY on everything (demo)
- Stack outputs: print API URL, CloudFront URL, UserPoolId, ClientId