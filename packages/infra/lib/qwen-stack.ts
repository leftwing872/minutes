import { Stack, type StackProps, Duration, CfnOutput } from "aws-cdk-lib";
import type { Construct } from "constructs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sagemaker from "aws-cdk-lib/aws-sagemaker";
import * as appscaling from "aws-cdk-lib/aws-applicationautoscaling";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import { DockerImageAsset, Platform } from "aws-cdk-lib/aws-ecr-assets";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export interface QwenStackProps extends StackProps {
  /** 메인 스택의 데이터 버킷 (오디오 조각 입력 / 결과 출력) */
  dataBucketName: string;
  endpointName: string;
  instanceType: string;
}

/**
 * Qwen3-ASR 를 SageMaker 비동기 추론 엔드포인트로 호스팅.
 * 요청이 없으면 0대로 축소되고, 큐에 요청이 쌓이면 1대 기동 (콜드스타트 수 분).
 */
export class QwenStack extends Stack {
  constructor(scope: Construct, id: string, props: QwenStackProps) {
    super(scope, id, props);
    const data = s3.Bucket.fromBucketName(this, "Data", props.dataBucketName);

    const image = new DockerImageAsset(this, "Image", {
      directory: path.resolve(here, "../../qwen-asr"),
      platform: Platform.LINUX_AMD64,
    });

    const role = new iam.Role(this, "ExecutionRole", {
      assumedBy: new iam.ServicePrincipal("sagemaker.amazonaws.com"),
      description: "minutes Qwen3-ASR SageMaker endpoint execution role",
    });
    image.repository.grantPull(role);
    data.grantReadWrite(role, "meetings/*");
    data.grantReadWrite(role, "qwen-async/*");
    role.addToPolicy(new iam.PolicyStatement({
      actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams", "cloudwatch:PutMetricData", "ecr:GetAuthorizationToken"],
      resources: ["*"],
    }));

    const model = new sagemaker.CfnModel(this, "Model", {
      executionRoleArn: role.roleArn,
      primaryContainer: { image: image.imageUri, environment: { MODEL_ID: "Qwen/Qwen3-ASR-1.7B" } },
    });
    model.node.addDependency(role);

    const variantName = "AllTraffic";
    const endpointConfig = new sagemaker.CfnEndpointConfig(this, "EndpointConfig", {
      productionVariants: [{
        variantName, modelName: model.attrModelName, instanceType: props.instanceType, initialInstanceCount: 1,
        containerStartupHealthCheckTimeoutInSeconds: 1800,
      }],
      asyncInferenceConfig: {
        outputConfig: { s3OutputPath: `s3://${props.dataBucketName}/qwen-async/out/`, s3FailurePath: `s3://${props.dataBucketName}/qwen-async/fail/` },
        clientConfig: { maxConcurrentInvocationsPerInstance: 1 }, // 컨테이너가 추론을 직렬화하므로 2 이상이면 두 번째 요청이 타임아웃으로 실패
      },
    });
    const endpoint = new sagemaker.CfnEndpoint(this, "Endpoint", { endpointName: props.endpointName, endpointConfigName: endpointConfig.attrEndpointConfigName });

    // ---------- 0 ↔ 1 오토스케일 ----------
    const target = new appscaling.ScalableTarget(this, "ScalableTarget", {
      serviceNamespace: appscaling.ServiceNamespace.SAGEMAKER,
      resourceId: `endpoint/${props.endpointName}/variant/${variantName}`,
      scalableDimension: "sagemaker:variant:DesiredInstanceCount",
      minCapacity: 0, maxCapacity: 1,
    });
    target.node.addDependency(endpoint);
    // 큐 길이 기준 추적: 백로그가 없으면 쿨다운 후 0대로
    target.scaleToTrackMetric("Backlog", {
      customMetric: new cloudwatch.Metric({
        namespace: "AWS/SageMaker", metricName: "ApproximateBacklogSizePerInstance",
        dimensionsMap: { EndpointName: props.endpointName }, statistic: "Average", period: Duration.minutes(1),
      }),
      targetValue: 3, scaleInCooldown: Duration.minutes(10), scaleOutCooldown: Duration.minutes(1),
    });
    // 0대 상태에서 요청이 들어오면 1대 기동
    target.scaleOnMetric("ColdStart", {
      metric: new cloudwatch.Metric({
        namespace: "AWS/SageMaker", metricName: "HasBacklogWithoutCapacity",
        dimensionsMap: { EndpointName: props.endpointName }, statistic: "Average", period: Duration.minutes(1),
      }),
      adjustmentType: appscaling.AdjustmentType.CHANGE_IN_CAPACITY,
      scalingSteps: [{ lower: 0, upper: 1, change: 0 }, { lower: 1, change: 1 }],
      cooldown: Duration.minutes(5), evaluationPeriods: 1, datapointsToAlarm: 1,
    });


    new CfnOutput(this, "EndpointName", { value: props.endpointName });
    new CfnOutput(this, "EndpointArn", { value: endpoint.ref });
    new CfnOutput(this, "ImageUri", { value: image.imageUri });
  }
}
