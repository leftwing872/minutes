import { Stack, type StackProps, Duration, RemovalPolicy, CfnOutput, Fn, Size } from "aws-cdk-lib";
import type { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3n from "aws-cdk-lib/aws-s3-notifications";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as logs from "aws-cdk-lib/aws-logs";
import * as cr from "aws-cdk-lib/custom-resources";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverSrc = path.resolve(here, "../../server/src");
const webDist = path.resolve(here, "../../web/dist");
const ffmpegLayerDir = path.resolve(here, "../layers/ffmpeg");

export interface MinutesStackProps extends StackProps {
  adminEmail: string;
  qwenAsrUrl: string;
  /** SageMaker 비동기 엔드포인트 이름 (MinutesQwen 스택). 비면 정밀 전사 생략 */
  qwenEndpointName: string;
  bedrockModelId: string;
}

export class MinutesStack extends Stack {
  constructor(scope: Construct, id: string, props: MinutesStackProps) {
    super(scope, id, props);
    if (!props.adminEmail) throw new Error("context adminEmail 이 필요합니다 (cdk.json 또는 -c adminEmail=...)");

    // ---------- 저장소 ----------
    const data = new s3.Bucket(this, "Data", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      // presigned URL 로만 접근하므로 origin 은 열어 둔다 (인증은 서명이 담당)
      cors: [{ allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET, s3.HttpMethods.HEAD], allowedOrigins: ["*"], allowedHeaders: ["*"], exposedHeaders: ["ETag"], maxAge: 3000 }],
      lifecycleRules: [{ abortIncompleteMultipartUploadAfter: Duration.days(1) }],
    });
    const web = new s3.Bucket(this, "Web", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, encryption: s3.BucketEncryption.S3_MANAGED, enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY, autoDeleteObjects: true,
    });
    const table = new dynamodb.Table(this, "Table", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });
    table.addGlobalSecondaryIndex({
      indexName: "gsi1",
      partitionKey: { name: "gsi1pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "gsi1sk", type: dynamodb.AttributeType.STRING },
    });

    // ---------- 인증 ----------
    const pool = new cognito.UserPool(this, "Users", {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true }, fullname: { required: false, mutable: true } },
      passwordPolicy: { minLength: 12, requireLowercase: true, requireUppercase: true, requireDigits: true, requireSymbols: true, tempPasswordValidity: Duration.days(7) },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      userInvitation: {
        emailSubject: "미팅 노트에 초대되었습니다",
        emailBody: "미팅 노트에 초대되었습니다.<br><br>아이디: {username}<br>임시 비밀번호: {####}<br><br>첫 로그인 시 새 비밀번호를 정하게 됩니다. 7일 안에 로그인해 주세요.",
      },
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const adminGroup = new cognito.CfnUserPoolGroup(this, "AdminsGroup", { userPoolId: pool.userPoolId, groupName: "admins", description: "미팅 노트 관리자" });
    const domain = pool.addDomain("Domain", { cognitoDomain: { domainPrefix: `minutes-${this.account}` } });

    // ---------- Lambda 공통 ----------
    const ffmpegLayer = new lambda.LayerVersion(this, "FfmpegLayer", {
      code: lambda.Code.fromAsset(ffmpegLayerDir),
      compatibleArchitectures: [lambda.Architecture.X86_64],
      compatibleRuntimes: [lambda.Runtime.NODEJS_22_X],
      description: "ffmpeg/ffprobe static (johnvansickle amd64)",
    });
    const commonEnv = {
      S3_BUCKET: data.bucketName,
      TABLE_NAME: table.tableName,
      USER_POOL_ID: pool.userPoolId,
      BEDROCK_MODEL_ID: props.bedrockModelId,
      QWEN_ASR_URL: props.qwenAsrUrl,
      QWEN_ENDPOINT_NAME: props.qwenEndpointName,
      QWEN_MODE: props.qwenEndpointName ? "sagemaker" : props.qwenAsrUrl ? "http" : "off",
      TRANSCRIBE_LANGUAGE: "ko-KR",
      NODE_OPTIONS: "--enable-source-maps",
    };
    const fn = (name: string, entry: string, extra: Partial<ConstructorParameters<typeof NodejsFunction>[2]> = {}) =>
      new NodejsFunction(this, name, {
        entry: path.join(serverSrc, entry),
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.X86_64,
        memorySize: 1024,
        timeout: Duration.seconds(29),
        logRetention: logs.RetentionDays.ONE_MONTH,
        environment: commonEnv,
        bundling: {
          format: OutputFormat.ESM, target: "node22", sourceMap: true, minify: false,
          mainFields: ["module", "main"],
          banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
          externalModules: [],
        },
        ...extra,
      });

    const bedrockPolicy = new iam.PolicyStatement({ actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"], resources: ["*"] });
    const transcribePolicy = new iam.PolicyStatement({ actions: ["transcribe:StartTranscriptionJob", "transcribe:GetTranscriptionJob"], resources: ["*"] });

    // ---------- 파이프라인 (Step Functions) ----------
    const pipelineFn = fn("PipelineFn", "lambda/pipeline.ts", {
      timeout: Duration.minutes(15), memorySize: 3008, ephemeralStorageSize: Size.gibibytes(4), layers: [ffmpegLayer],
    });
    data.grantReadWrite(pipelineFn);
    table.grantReadWriteData(pipelineFn);
    pipelineFn.addToRolePolicy(bedrockPolicy);
    pipelineFn.addToRolePolicy(transcribePolicy);
    if (props.qwenEndpointName) {
      pipelineFn.addToRolePolicy(new iam.PolicyStatement({
        actions: ["sagemaker:InvokeEndpointAsync"],
        resources: [`arn:aws:sagemaker:${this.region}:${this.account}:endpoint/${props.qwenEndpointName}`],
      }));
    }

    const invoke = (id: string, step: string, extraPayload: Record<string, unknown> = {}, resultPath: string = sfn.JsonPath.DISCARD) =>
      new tasks.LambdaInvoke(this, id, {
        lambdaFunction: pipelineFn,
        payload: sfn.TaskInput.fromObject({ step, meetingId: sfn.JsonPath.stringAt("$.meetingId"), ...extraPayload }),
        payloadResponseOnly: true,
        resultPath,
        retryOnServiceExceptions: true,
      });

    const startTranscribe = invoke("StartTranscribe", "startTranscribe");
    const waitTranscribe = new sfn.Wait(this, "WaitTranscribe", { time: sfn.WaitTime.duration(Duration.seconds(20)) });
    const checkTranscribe = invoke("CheckTranscribe", "checkTranscribe", {}, "$.check");
    const refinePrepare = invoke("RefinePrepare", "refinePrepare", {}, "$.prep");
    const waitQwen = new sfn.Wait(this, "WaitQwen", { time: sfn.WaitTime.duration(Duration.seconds(60)) });
    const qwenCheck = invoke("QwenCheck", "qwenCheck", {}, "$.prep");
    const refineWindow = invoke("RefineWindow", "refineWindow", { index: sfn.JsonPath.numberAt("$.index") });
    refineWindow.addRetry({ errors: ["States.TaskFailed"], maxAttempts: 2, interval: Duration.seconds(15), backoffRate: 2 });
    const refineMap = new sfn.Map(this, "RefineWindows", {
      itemsPath: "$.prep.windows", maxConcurrency: 4, resultPath: sfn.JsonPath.DISCARD,
      itemSelector: { meetingId: sfn.JsonPath.stringAt("$.meetingId"), index: sfn.JsonPath.numberAt("$$.Map.Item.Value") },
    }).itemProcessor(refineWindow);
    const refineMerge = invoke("RefineMerge", "refineMerge", { count: sfn.JsonPath.arrayLength(sfn.JsonPath.listAt("$.prep.windows")) });
    const summarize = invoke("Summarize", "summarize");
    summarize.addRetry({ errors: ["States.TaskFailed"], maxAttempts: 2, interval: Duration.seconds(20), backoffRate: 2 });

    const hasWindows = new sfn.Choice(this, "HasWindows?")
      .when(sfn.Condition.isPresent("$.prep.windows[0]"), refineMap.next(refineMerge).next(summarize))
      .otherwise(summarize);
    // Qwen 비동기 결과 대기 루프 (콜드스타트 포함 최대 수십 분)
    const qwenPending = new sfn.Choice(this, "QwenPending?")
      .when(sfn.Condition.booleanEquals("$.prep.pending", true), waitQwen.next(qwenCheck).next(
        new sfn.Choice(this, "QwenDone?")
          .when(sfn.Condition.booleanEquals("$.prep.pending", true), waitQwen)
          .otherwise(hasWindows)))
      .otherwise(hasWindows);

    const transcribeLoop = startTranscribe.next(waitTranscribe).next(checkTranscribe).next(
      new sfn.Choice(this, "TranscribeDone?")
        .when(sfn.Condition.booleanEquals("$.check.done", true), refinePrepare.next(qwenPending))
        .otherwise(waitTranscribe));

    const body = new sfn.Parallel(this, "Pipeline", { resultPath: sfn.JsonPath.DISCARD }).branch(
      new sfn.Choice(this, "Mode?")
        .when(sfn.Condition.stringEquals("$.mode", "summarize"), summarize)
        .otherwise(transcribeLoop),
    );
    const markFailed = new tasks.LambdaInvoke(this, "MarkFailed", {
      lambdaFunction: pipelineFn, payloadResponseOnly: true, resultPath: sfn.JsonPath.DISCARD,
      payload: sfn.TaskInput.fromObject({ step: "fail", meetingId: sfn.JsonPath.stringAt("$.meetingId"), error: sfn.JsonPath.objectAt("$.error") }),
    }).next(new sfn.Fail(this, "Failed"));
    body.addCatch(markFailed, { resultPath: "$.error" });

    const stateMachine = new sfn.StateMachine(this, "StateMachine", {
      definitionBody: sfn.DefinitionBody.fromChainable(body.next(new sfn.Succeed(this, "Done"))),
      timeout: Duration.hours(6),
      logs: { destination: new logs.LogGroup(this, "SfnLogs", { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY }), level: sfn.LogLevel.ERROR },
    });

    // ---------- API ----------
    const apiFn = fn("ApiFn", "lambda/api.ts", { environment: { ...commonEnv, STATE_MACHINE_ARN: stateMachine.stateMachineArn } });
    data.grantReadWrite(apiFn);
    table.grantReadWriteData(apiFn);
    stateMachine.grantStartExecution(apiFn);
    apiFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["cognito-idp:ListUsers", "cognito-idp:ListUsersInGroup", "cognito-idp:AdminCreateUser", "cognito-idp:AdminSetUserPassword",
        "cognito-idp:AdminAddUserToGroup", "cognito-idp:AdminRemoveUserFromGroup", "cognito-idp:AdminDeleteUser", "cognito-idp:AdminGetUser"],
      resources: [pool.userPoolArn],
    }));
    const httpApi = new apigw.HttpApi(this, "HttpApi", { defaultIntegration: new HttpLambdaIntegration("ApiIntegration", apiFn) });

    // S3 업로드 완료 이벤트 → 파이프라인
    const s3EventFn = fn("S3EventFn", "lambda/s3event.ts", { environment: { ...commonEnv, STATE_MACHINE_ARN: stateMachine.stateMachineArn } });
    table.grantReadWriteData(s3EventFn);
    stateMachine.grantStartExecution(s3EventFn);
    data.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.LambdaDestination(s3EventFn), { prefix: "meetings/" });

    // ---------- CloudFront ----------
    const apiDomain = Fn.select(2, Fn.split("/", httpApi.apiEndpoint));
    const distribution = new cloudfront.Distribution(this, "Cdn", {
      defaultRootObject: "index.html",
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(web),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      additionalBehaviors: {
        "/api/*": {
          origin: new origins.HttpOrigin(apiDomain),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: "/index.html", ttl: Duration.seconds(0) },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: "/index.html", ttl: Duration.seconds(0) },
      ],
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      comment: "minutes web + api",
    });
    const siteUrl = `https://${distribution.distributionDomainName}/`;

    // ---------- Cognito 앱 클라이언트 (콜백 URL 에 배포 도메인 필요) ----------
    const client = pool.addClient("WebClient", {
      generateSecret: false,
      authFlows: { userSrp: true },
      preventUserExistenceErrors: true,
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [siteUrl, "http://localhost:5173/"],
        logoutUrls: [siteUrl, "http://localhost:5173/"],
      },
      idTokenValidity: Duration.hours(1), accessTokenValidity: Duration.hours(1), refreshTokenValidity: Duration.days(30),
    });

    // ---------- 웹 배포 ----------
    const cognitoDomainUrl = `https://${domain.domainName}.auth.${this.region}.amazoncognito.com`;
    new s3deploy.BucketDeployment(this, "WebAssets", {
      destinationBucket: web, distribution, distributionPaths: ["/*"],
      sources: [s3deploy.Source.asset(webDist, { exclude: ["index.html"] })],
      cacheControl: [s3deploy.CacheControl.maxAge(Duration.days(365)), s3deploy.CacheControl.immutable()],
      prune: false,
    });
    new s3deploy.BucketDeployment(this, "WebIndex", {
      destinationBucket: web, distribution, distributionPaths: ["/index.html", "/config.json"],
      sources: [
        s3deploy.Source.asset(webDist, { exclude: ["*", "!index.html"] }),
        s3deploy.Source.jsonData("config.json", {
          region: this.region, userPoolId: pool.userPoolId, clientId: client.userPoolClientId,
          cognitoAuthority: `https://cognito-idp.${this.region}.amazonaws.com/${pool.userPoolId}`,
          cognitoDomain: cognitoDomainUrl, redirectUri: siteUrl, apiBase: "/api",
        }),
      ],
      cacheControl: [s3deploy.CacheControl.noCache()],
      prune: false,
    });

    // ---------- 최초 관리자 ----------
    const adminUser = new cr.AwsCustomResource(this, "AdminUser", {
      onCreate: {
        service: "@aws-sdk/client-cognito-identity-provider", action: "AdminCreateUserCommand",
        parameters: {
          UserPoolId: pool.userPoolId, Username: props.adminEmail, DesiredDeliveryMediums: ["EMAIL"],
          UserAttributes: [{ Name: "email", Value: props.adminEmail }, { Name: "email_verified", Value: "true" }, { Name: "name", Value: props.adminEmail.split("@")[0] }],
        },
        physicalResourceId: cr.PhysicalResourceId.of(`admin-${props.adminEmail}`),
        ignoreErrorCodesMatching: "UsernameExistsException",
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: [pool.userPoolArn] }),
      installLatestAwsSdk: false,
    });
    const adminMembership = new cr.AwsCustomResource(this, "AdminMembership", {
      onCreate: {
        service: "@aws-sdk/client-cognito-identity-provider", action: "AdminAddUserToGroupCommand",
        parameters: { UserPoolId: pool.userPoolId, Username: props.adminEmail, GroupName: adminGroup.groupName },
        physicalResourceId: cr.PhysicalResourceId.of(`admin-group-${props.adminEmail}`),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: [pool.userPoolArn] }),
      installLatestAwsSdk: false,
    });
    adminMembership.node.addDependency(adminUser, adminGroup);

    // ---------- 출력 ----------
    new CfnOutput(this, "SiteUrl", { value: siteUrl });
    new CfnOutput(this, "ApiEndpoint", { value: httpApi.apiEndpoint });
    new CfnOutput(this, "UserPoolId", { value: pool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: client.userPoolClientId });
    new CfnOutput(this, "DataBucket", { value: data.bucketName });
    new CfnOutput(this, "TableName", { value: table.tableName });
    new CfnOutput(this, "StateMachineArn", { value: stateMachine.stateMachineArn });
    new CfnOutput(this, "AdminEmail", { value: props.adminEmail });
  }
}
