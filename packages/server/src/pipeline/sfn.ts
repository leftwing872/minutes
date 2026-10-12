import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import type { PipelineStarter } from "../store/types.js";

/** Step Functions 실행 시작 (배포 환경) */
export class SfnPipelineStarter implements PipelineStarter {
  private sfn = new SFNClient({});
  constructor(private stateMachineArn: string) {}
  async start(meetingId: string) { await this.exec({ meetingId, mode: "full" }); }
  async regenerate(meetingId: string) { await this.exec({ meetingId, mode: "summarize" }); }
  private async exec(input: { meetingId: string; mode: string }) {
    await this.sfn.send(new StartExecutionCommand({
      stateMachineArn: this.stateMachineArn, input: JSON.stringify(input),
      name: `${input.mode}-${input.meetingId}-${Date.now()}`.slice(0, 80),
    }));
  }
}
