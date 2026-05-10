"use strict";

const path = require("path");
const fs = require("fs");
const { Stack, RemovalPolicy, Duration, CfnOutput } = require("aws-cdk-lib/core");
const dynamodb = require("aws-cdk-lib/aws-dynamodb");
const cognito = require("aws-cdk-lib/aws-cognito");
const lambda = require("aws-cdk-lib/aws-lambda");
const apigw = require("aws-cdk-lib/aws-apigateway");
const s3 = require("aws-cdk-lib/aws-s3");
const s3deploy = require("aws-cdk-lib/aws-s3-deployment");
const cloudfront = require("aws-cdk-lib/aws-cloudfront");
const origins = require("aws-cdk-lib/aws-cloudfront-origins");
const iam = require("aws-cdk-lib/aws-iam");
const events = require("aws-cdk-lib/aws-events");
const targets = require("aws-cdk-lib/aws-events-targets");
const logs = require("aws-cdk-lib/aws-logs");

// Nova models in eu-west-1 are only callable via a cross-region inference
// profile, not as on-demand foundation models. We invoke the EU profile,
// which can route to any of the EU member regions below.
const BEDROCK_MODEL_ID = "eu.amazon.nova-lite-v1:0";
const BEDROCK_REGION = "eu-west-1";
const BEDROCK_FOUNDATION_MODEL = "amazon.nova-lite-v1:0";
const BEDROCK_PROFILE_REGIONS = [
  "eu-west-1",
  "eu-west-3",
  "eu-central-1",
  "eu-north-1",
  "eu-south-1",
  "eu-south-2",
];
// Titan Text Embeddings v2 is on-demand in eu-west-1 (no inference profile),
// so it gets a plain foundation-model ARN. We use it from the chat Lambda to
// compute topic embeddings for semantic group-session matching.
const BEDROCK_EMBED_MODEL_ID = "amazon.titan-embed-text-v2:0";

// DynamoDB IAM action tiers — least-privilege per function. Previously every
// Lambda got dynamodb:* which would allow any function to drop the table.
const DDB_READ_ONLY = ["dynamodb:GetItem", "dynamodb:Query"];
const DDB_READ_WRITE = [...DDB_READ_ONLY, "dynamodb:PutItem", "dynamodb:UpdateItem"];
const DDB_CRUD      = [...DDB_READ_WRITE, "dynamodb:DeleteItem"];
const DDB_FULL      = [...DDB_CRUD,       "dynamodb:TransactWriteItems"];

// Build the Bedrock ARN list. Extracted here so the three functions that
// actually call Bedrock (chat, analytics, daily-report) can share the same
// resource list without duplicating the constants.
function bedrockArns(account) {
  return [
    `arn:aws:bedrock:${BEDROCK_REGION}:${account}:inference-profile/${BEDROCK_MODEL_ID}`,
    ...BEDROCK_PROFILE_REGIONS.map(
      (r) => `arn:aws:bedrock:${r}::foundation-model/${BEDROCK_FOUNDATION_MODEL}`
    ),
    `arn:aws:bedrock:${BEDROCK_REGION}::foundation-model/${BEDROCK_EMBED_MODEL_ID}`,
  ];
}

function toPascal(kebab) {
  return kebab
    .split("-")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}

class UniConsultationsStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    // ---------- DynamoDB ----------
    const table = new dynamodb.Table(this, "ConsultationsTable", {
      tableName: "ConsultationsApp",
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: "ttl",
      removalPolicy: RemovalPolicy.DESTROY,
    });

    table.addGlobalSecondaryIndex({
      indexName: "GSI1",
      partitionKey: { name: "GSI1PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "GSI1SK", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    table.addGlobalSecondaryIndex({
      indexName: "GSI2",
      partitionKey: { name: "GSI2PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "GSI2SK", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ---------- Cognito ----------
    const userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: "uni-consultations-users",
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      mfa: cognito.Mfa.OFF,
      standardAttributes: {
        email: { required: true, mutable: true },
      },
      customAttributes: {
        role: new cognito.StringAttribute({ mutable: true }),
        displayName: new cognito.StringAttribute({ mutable: true }),
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireDigits: true,
        requireUppercase: false,
        requireSymbols: false,
      },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    userPool.addDomain("UserPoolDomain", {
      cognitoDomain: {
        domainPrefix: "uni-consultations-2025",
      },
    });

    // ---------- S3 + CloudFront (OAC) ----------
    // Created up here (before the UserPoolClient) so we can wire its domain
    // name into the Cognito callback / logout URLs without hardcoding the
    // d{...}.cloudfront.net string. That way every redeploy automatically
    // configures Cognito for the freshly-created distribution.
    const siteBucket = new s3.Bucket(this, "SiteBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ---------- S3 (Daily reports archive) ----------
    // One .txt per professor per cron run. Keys are timestamped so we never
    // overwrite — the IfNoneMatch:"*" on PutObject is the second safety net,
    // and bucket versioning is the third. Lifecycle expires after 30 days so
    // the bucket doesn't grow unbounded.
    const reportsBucket = new s3.Bucket(this, "DailyReportsBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        {
          expiration: Duration.days(30),
          noncurrentVersionExpiration: Duration.days(30),
        },
      ],
    });

    // ---------- CloudFront security headers ----------
    // Applied to every response served from the distribution. CSP restricts
    // connections to the SPA's own origin plus the specific AWS service
    // endpoints it talks to so injected third-party scripts can't phone home.
    const securityHeadersPolicy = new cloudfront.ResponseHeadersPolicy(
      this,
      "SecurityHeaders",
      {
        responseHeadersPolicyName: "uni-consultations-security-headers",
        securityHeadersBehavior: {
          contentTypeOptions: { override: true },
          frameOptions: {
            frameOption: cloudfront.HeadersFrameOption.DENY,
            override: true,
          },
          referrerPolicy: {
            referrerPolicy:
              cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
            override: true,
          },
          strictTransportSecurity: {
            accessControlMaxAge: Duration.days(365),
            includeSubdomains: true,
            override: true,
          },
          xssProtection: { protection: true, modeBlock: true, override: true },
          contentSecurityPolicy: {
            contentSecurityPolicy:
              "default-src 'self'; " +
              "script-src 'self' 'unsafe-inline'; " +
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
              "font-src 'self' https://fonts.gstatic.com; " +
              "connect-src 'self' " +
                "https://*.execute-api.eu-west-1.amazonaws.com " +
                "https://cognito-idp.eu-west-1.amazonaws.com " +
                "https://*.auth.eu-west-1.amazoncognito.com; " +
              "img-src 'self' data:;",
            override: true,
          },
        },
      }
    );

    const distribution = new cloudfront.Distribution(this, "SiteDistribution", {
      defaultRootObject: "index.html",
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: securityHeadersPolicy,
      },
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl: Duration.seconds(0),
        },
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl: Duration.seconds(0),
        },
      ],
    });

    const siteUrl = `https://${distribution.distributionDomainName}`;

    // Custom client attributes are NOT writable by default in CDK — we have
    // to explicitly grant the SPA permission to set custom:role and
    // custom:displayName during signUp, and read them back in tokens.
    // custom:role remains writable so the registration form can submit the
    // user's chosen role; the post-confirmation trigger normalises any
    // out-of-allowlist value server-side before it can appear in a JWT.
    const clientReadAttributes = new cognito.ClientAttributes()
      .withStandardAttributes({ email: true, emailVerified: true })
      .withCustomAttributes("role", "displayName");

    const clientWriteAttributes = new cognito.ClientAttributes()
      .withStandardAttributes({ email: true })
      .withCustomAttributes("role", "displayName");

    const userPoolClient = new cognito.UserPoolClient(this, "UserPoolClient", {
      userPool,
      generateSecret: false,
      authFlows: { userSrp: true },
      readAttributes: clientReadAttributes,
      writeAttributes: clientWriteAttributes,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls: [`${siteUrl}/callback`],
        logoutUrls: [`${siteUrl}/`],
      },
    });

    // ---------- Common Lambda layer ----------
    const commonLayer = new lambda.LayerVersion(this, "CommonLayer", {
      layerVersionName: "uni-consultations-common",
      code: lambda.Code.fromAsset(
        path.join(__dirname, "..", "..", "backend", "layers", "common")
      ),
      compatibleRuntimes: [lambda.Runtime.NODEJS_22_X],
      description: "Shared db / response / auth helpers at /opt/nodejs/*",
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // ---------- Lambda factory ----------
    // Base env is on every Lambda. USER_POOL_ID / USER_POOL_CLIENT_ID are
    // added only to functions that are NOT Cognito triggers — otherwise the
    // UserPool -> trigger Lambda -> UserPool env ref creates a CFN cycle.
    // Cognito passes userPoolId to the post-confirmation Lambda in the event.
    const baseEnv = {
      TABLE_NAME: table.tableName,
      BEDROCK_MODEL_ID,
      BEDROCK_REGION,
      BEDROCK_EMBED_MODEL_ID,
    };

    const userPoolEnv = {
      USER_POOL_ID: userPool.userPoolId,
      USER_POOL_CLIENT_ID: userPoolClient.userPoolClientId,
    };

    const functionsRoot = path.join(__dirname, "..", "..", "backend", "functions");

    // `ddbActions` — least-privilege DynamoDB action set for each function.
    // Bedrock is NOT granted here; add it selectively below for the three
    // functions that actually call Bedrock (chat, analytics, daily-report).
    const makeFn = (name, extraEnv = {}, ddbActions = DDB_FULL) => {
      const logGroup = new logs.LogGroup(this, `${toPascal(name)}LogGroup`, {
        logGroupName: `/aws/lambda/uni-${name}`,
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY,
      });

      const fn = new lambda.Function(this, `${toPascal(name)}Fn`, {
        functionName: `uni-${name}`,
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: "handler.handler",
        code: lambda.Code.fromAsset(path.join(functionsRoot, name)),
        layers: [commonLayer],
        environment: { ...baseEnv, ...extraEnv },
        timeout: Duration.seconds(30),
        memorySize: 256,
        logGroup,
      });

      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ddbActions,
          resources: [table.tableArn, `${table.tableArn}/index/*`],
        })
      );

      return fn;
    };

    // Least-privilege DDB grants per function. Reference the tier constants
    // defined at module scope to make the intent at each call site obvious.
    const authPostConfirmationFn  = makeFn("auth-post-confirmation",  {},            ["dynamodb:PutItem"]);
    const chatFn                  = makeFn("chat",                    userPoolEnv,   DDB_FULL);
    const getProfessorsFn         = makeFn("get-professors",          userPoolEnv,   DDB_READ_ONLY);
    const manageSlotsFn           = makeFn("manage-slots",            userPoolEnv,   DDB_FULL);
    const manageScheduleFn        = makeFn("manage-schedule",         userPoolEnv,   DDB_CRUD);
    const getMyConsultationsFn    = makeFn("get-my-consultations",    userPoolEnv,   DDB_READ_ONLY);
    const manageConsultationsFn   = makeFn("manage-consultations",    userPoolEnv,   DDB_FULL);
    const manageBookingsFn        = makeFn("manage-bookings",         userPoolEnv,   DDB_FULL);
    const manageNotificationsFn   = makeFn("manage-notifications",    userPoolEnv,   DDB_CRUD);
    const dailyReportFn           = makeFn("daily-report",            {
      ...userPoolEnv,
      REPORTS_BUCKET: reportsBucket.bucketName,
    },                                                                               ["dynamodb:Query", "dynamodb:PutItem"]);
    const getDailyReportFn        = makeFn("get-daily-report",        userPoolEnv,   DDB_READ_ONLY);
    const analyticsFn             = makeFn("analytics",               userPoolEnv,   [...DDB_READ_ONLY, "dynamodb:PutItem"]);
    const manageWaitlistFn        = makeFn("manage-waitlist",         userPoolEnv,   DDB_CRUD);
    const manageThesisFn          = makeFn("manage-thesis",           userPoolEnv,   DDB_READ_WRITE);

    // Bedrock InvokeModel — only chat, analytics, and daily-report actually
    // call the model. All other Lambdas get no Bedrock access.
    for (const fn of [chatFn, analyticsFn, dailyReportFn]) {
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["bedrock:InvokeModel"],
          resources: bedrockArns(this.account),
        })
      );
    }

    // Only PutObject — the lambda must never be able to delete or overwrite
    // existing reports. Combined with IfNoneMatch:"*" in the handler this
    // makes the archive truly append-only from the cron's perspective.
    reportsBucket.grantPut(dailyReportFn);

    // Allow the post-confirmation trigger to override custom:role back to a
    // valid value if the client supplied something other than "student" or
    // "professor". This closes the role-elevation path where a direct Cognito
    // SignUp API call sets custom:role="admin". The trigger uses the userPoolId
    // from the event (no env var needed — that would create a CFN cycle).
    // Use a wildcard ARN instead of userPool.userPoolArn to break the CFN
    // cycle: UserPool → trigger(AuthPostConfirmationFn) →
    // AuthPostConfirmationFnServiceRoleDefaultPolicy → userPool.userPoolArn
    // → UserPool. Scoped to this account+region so no meaningful privilege
    // is added over the specific ARN.
    authPostConfirmationFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["cognito-idp:AdminUpdateUserAttributes"],
        resources: [
          `arn:aws:cognito-idp:${this.region}:${this.account}:userpool/*`,
        ],
      })
    );

    userPool.addTrigger(
      cognito.UserPoolOperation.POST_CONFIRMATION,
      authPostConfirmationFn
    );

    // ---------- Frontend deployment ----------
    // Ships frontend/dist to the site bucket and busts the CloudFront cache
    // on every `cdk deploy`. Skipped (with a warning) if dist/ has not been
    // built yet so the rest of the stack can still deploy. Run
    //   (cd ../frontend && npm run build)
    // before `cdk deploy` to ship the latest UI through CDK. For fast UI-only
    // iteration use `npm run deploy` from aws-app/frontend instead.
    const frontendDist = path.join(
      __dirname,
      "..",
      "..",
      "frontend",
      "dist"
    );
    if (fs.existsSync(path.join(frontendDist, "index.html"))) {
      new s3deploy.BucketDeployment(this, "SiteDeployment", {
        sources: [s3deploy.Source.asset(frontendDist)],
        destinationBucket: siteBucket,
        distribution,
        distributionPaths: ["/*"],
        prune: true,
        memoryLimit: 512,
      });
    } else {
      console.warn(
        "[UniConsultationsStack] frontend/dist/index.html not found — " +
          "skipping site deployment. Run `npm run build` in aws-app/frontend " +
          "before `cdk deploy` to ship the UI."
      );
    }

    // ---------- API Gateway (REST) ----------
    const authorizer = new apigw.CognitoUserPoolsAuthorizer(this, "ApiAuthorizer", {
      cognitoUserPools: [userPool],
    });

    const api = new apigw.RestApi(this, "Api", {
      restApiName: "uni-consultations-api",
      deployOptions: {
        stageName: "prod",
        // Stage-level default throttle — prevents a single authenticated user
        // from flooding any endpoint. Per-method overrides below apply tighter
        // limits to cost-sensitive routes (Bedrock calls).
        throttlingRateLimit: 50,
        throttlingBurstLimit: 100,
        methodOptions: {
          "/chat/POST": {
            throttlingRateLimit: 10,
            throttlingBurstLimit: 20,
          },
        },
      },
      defaultCorsPreflightOptions: {
        allowOrigins: [siteUrl],
        allowMethods: apigw.Cors.ALL_METHODS,
        allowHeaders: apigw.Cors.DEFAULT_HEADERS,
      },
      defaultMethodOptions: {
        authorizer,
        authorizationType: apigw.AuthorizationType.COGNITO,
      },
    });

    // POST /chat              — multi-turn converse with the assistant
    // GET  /chat/sessions/{id} — replay a stored session (resume after refresh)
    const chatRes = api.root.addResource("chat");
    chatRes.addMethod("POST", new apigw.LambdaIntegration(chatFn, { proxy: true }));
    const chatSessions = chatRes.addResource("sessions");
    const chatSessionById = chatSessions.addResource("{sessionId}");
    chatSessionById.addMethod(
      "GET",
      new apigw.LambdaIntegration(chatFn, { proxy: true })
    );

    // /professors
    const professorsRes = api.root.addResource("professors");
    professorsRes.addMethod(
      "GET",
      new apigw.LambdaIntegration(getProfessorsFn, { proxy: true })
    );

    // /professors/{id}/slots[/{slotSK} | /cancel-day]
    // Static segment "/cancel-day" must be declared BEFORE "{slotSK}" so
    // API Gateway routes /slots/cancel-day to the dedicated handler instead
    // of treating "cancel-day" as a slotSK value.
    const professorById = professorsRes.addResource("{id}");
    const profSlots = professorById.addResource("slots");
    profSlots.addMethod("GET", new apigw.LambdaIntegration(manageSlotsFn, { proxy: true }));
    profSlots.addMethod("POST", new apigw.LambdaIntegration(manageSlotsFn, { proxy: true }));
    profSlots.addResource("cancel-day").addMethod(
      "POST",
      new apigw.LambdaIntegration(manageSlotsFn, { proxy: true })
    );
    const profSlotById = profSlots.addResource("{slotSK}");
    profSlotById.addMethod("PATCH", new apigw.LambdaIntegration(manageSlotsFn, { proxy: true }));
    profSlotById.addMethod("DELETE", new apigw.LambdaIntegration(manageSlotsFn, { proxy: true }));

    // POST /professors/{id}/slots/{slotSK}/waitlist — student joins the
    // waitlist on a full slot. The student-side leave + list endpoints
    // live under /me below.
    profSlotById.addResource("waitlist").addMethod(
      "POST",
      new apigw.LambdaIntegration(manageWaitlistFn, { proxy: true })
    );

    // /professors/{id}/unavailable[/{date}] — emergency days off.
    const profUnavailable = professorById.addResource("unavailable");
    profUnavailable.addMethod(
      "GET",
      new apigw.LambdaIntegration(manageScheduleFn, { proxy: true })
    );
    profUnavailable.addMethod(
      "POST",
      new apigw.LambdaIntegration(manageScheduleFn, { proxy: true })
    );
    const profUnavailableByDate = profUnavailable.addResource("{date}");
    profUnavailableByDate.addMethod(
      "DELETE",
      new apigw.LambdaIntegration(manageScheduleFn, { proxy: true })
    );

    // /professors/{id}/classes[/{classId}] — owner-only class schedule.
    const profClasses = professorById.addResource("classes");
    profClasses.addMethod(
      "GET",
      new apigw.LambdaIntegration(manageScheduleFn, { proxy: true })
    );
    profClasses.addMethod(
      "POST",
      new apigw.LambdaIntegration(manageScheduleFn, { proxy: true })
    );
    const profClassById = profClasses.addResource("{classId}");
    profClassById.addMethod(
      "DELETE",
      new apigw.LambdaIntegration(manageScheduleFn, { proxy: true })
    );

    // /me/consultations
    const meRes = api.root.addResource("me");
    const meConsultations = meRes.addResource("consultations");
    meConsultations.addMethod(
      "GET",
      new apigw.LambdaIntegration(getMyConsultationsFn, { proxy: true })
    );

    // /me/daily-report — latest persisted daily report for the calling
    // professor (read-only; the cron writes these). 404s when the cron
    // hasn't produced one yet.
    meRes.addResource("daily-report").addMethod(
      "GET",
      new apigw.LambdaIntegration(getDailyReportFn, { proxy: true })
    );

    // /me/waitlist[/{slotSK}] — student-side waitlist routes (list + leave).
    const meWaitlist = meRes.addResource("waitlist");
    meWaitlist.addMethod(
      "GET",
      new apigw.LambdaIntegration(manageWaitlistFn, { proxy: true })
    );
    meWaitlist.addResource("{slotSK}").addMethod(
      "DELETE",
      new apigw.LambdaIntegration(manageWaitlistFn, { proxy: true })
    );

    // /me/notifications[/{notifId} | /mark-all-read]
    // Static path segments take priority over `{notifId}` in API Gateway, so
    // /mark-all-read resolves to its dedicated method first.
    const meNotifications = meRes.addResource("notifications");
    meNotifications.addMethod(
      "GET",
      new apigw.LambdaIntegration(manageNotificationsFn, { proxy: true })
    );
    meNotifications.addResource("mark-all-read").addMethod(
      "POST",
      new apigw.LambdaIntegration(manageNotificationsFn, { proxy: true })
    );
    const meNotifById = meNotifications.addResource("{notifId}");
    meNotifById.addMethod(
      "PATCH",
      new apigw.LambdaIntegration(manageNotificationsFn, { proxy: true })
    );
    meNotifById.addMethod(
      "DELETE",
      new apigw.LambdaIntegration(manageNotificationsFn, { proxy: true })
    );

    // /consultations/{id}
    const consultationsRes = api.root.addResource("consultations");
    const consultationById = consultationsRes.addResource("{id}");
    consultationById.addMethod(
      "PATCH",
      new apigw.LambdaIntegration(manageConsultationsFn, { proxy: true })
    );

    // /consultations/{id}/feedback — both roles can hit this endpoint;
    // the server inspects the consultation row to decide which slice
    // (studentFeedback / professorFeedback) to write.
    consultationById.addResource("feedback").addMethod(
      "POST",
      new apigw.LambdaIntegration(manageConsultationsFn, { proxy: true })
    );

    // POST /bookings — manual student-driven reservation. Same DB writes as
    // the chat assistant booking flow (shared via bookSlotCore in the common
    // layer); this Lambda just adds the stricter "untrusted client" guards.
    const bookingsRes = api.root.addResource("bookings");
    bookingsRes.addMethod(
      "POST",
      new apigw.LambdaIntegration(manageBookingsFn, { proxy: true })
    );

    // /thesis/{proposal | me | mentees | mentees/{studentId} | settings}
    // Student creates / inspects, professor lists / decides / configures
    // capacity. The handler dispatches by httpMethod + tail of path.
    const thesisRes = api.root.addResource("thesis");
    thesisRes.addResource("proposal").addMethod(
      "POST",
      new apigw.LambdaIntegration(manageThesisFn, { proxy: true })
    );
    thesisRes.addResource("me").addMethod(
      "GET",
      new apigw.LambdaIntegration(manageThesisFn, { proxy: true })
    );
    const thesisMentees = thesisRes.addResource("mentees");
    thesisMentees.addMethod(
      "GET",
      new apigw.LambdaIntegration(manageThesisFn, { proxy: true })
    );
    thesisMentees.addResource("{studentId}").addMethod(
      "PATCH",
      new apigw.LambdaIntegration(manageThesisFn, { proxy: true })
    );
    const thesisSettings = thesisRes.addResource("settings");
    thesisSettings.addMethod(
      "GET",
      new apigw.LambdaIntegration(manageThesisFn, { proxy: true })
    );
    thesisSettings.addMethod(
      "PATCH",
      new apigw.LambdaIntegration(manageThesisFn, { proxy: true })
    );

    // /analytics/{professor|admin}
    // Single Lambda — internal handler dispatches by event.path so adding
    // a third scope later (e.g. department-level) is just one more route
    // and one more if-branch instead of a brand new function.
    const analyticsRes = api.root.addResource("analytics");
    analyticsRes.addResource("professor").addMethod(
      "GET",
      new apigw.LambdaIntegration(analyticsFn, { proxy: true })
    );
    analyticsRes.addResource("admin").addMethod(
      "GET",
      new apigw.LambdaIntegration(analyticsFn, { proxy: true })
    );

    // API Gateway strips CORS headers from responses that come from the
    // Cognito authorizer (401) or from integration errors (5xx) because
    // defaultCorsPreflightOptions only covers OPTIONS preflight.
    // GatewayResponses inject the header on every error class so the
    // browser can read the status code instead of seeing a CORS block.
    const corsHeaders = {
      "Access-Control-Allow-Origin": `'${siteUrl}'`,
      "Access-Control-Allow-Headers": "'*'",
    };
    new apigw.GatewayResponse(this, "Cors4xx", {
      restApi: api,
      type: apigw.ResponseType.DEFAULT_4XX,
      responseHeaders: corsHeaders,
    });
    new apigw.GatewayResponse(this, "Cors5xx", {
      restApi: api,
      type: apigw.ResponseType.DEFAULT_5XX,
      responseHeaders: corsHeaders,
    });

    // ---------- EventBridge ----------
    new events.Rule(this, "DailyReportRule", {
      schedule: events.Schedule.expression("cron(0 19 * * ? *)"),
      targets: [new targets.LambdaFunction(dailyReportFn)],
    });

    // ---------- Outputs ----------
    new CfnOutput(this, "ApiUrl", { value: api.url });
    new CfnOutput(this, "CloudFrontUrl", {
      value: `https://${distribution.distributionDomainName}`,
    });
    new CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: userPoolClient.userPoolClientId });
    new CfnOutput(this, "UserPoolDomain", {
      value: "uni-consultations-2025.auth.eu-west-1.amazoncognito.com",
    });
    new CfnOutput(this, "SiteBucketName", { value: siteBucket.bucketName });
    new CfnOutput(this, "DistributionId", { value: distribution.distributionId });
    new CfnOutput(this, "TableName", { value: table.tableName });
    new CfnOutput(this, "ReportsBucketName", { value: reportsBucket.bucketName });
  }
}

module.exports = { UniConsultationsStack };
