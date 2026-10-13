import type { MeetingStore, PipelineStarter } from "../store/types.js";
import { stepStartTranscribe, stepCheckTranscribe, stepRefinePrepare, stepQwenCheck, stepRefineWindow, stepRefineMerge, stepSummarize, markFailed } from "./steps.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 로컬 인프로세스 러너. 배포 시에는 Step Functions 가 같은 step 들을 실행한다. */
export class LocalPipelineRunner implements PipelineStarter {
  private running = new Set<string>();
  private queue: string[] = [];
  private active = 0;
  constructor(private store: MeetingStore, private concurrency = 2) {}

  async resumeAll() { for (const m of await this.store.listInProgress()) this.enqueue(m.meetingId); }
  async start(id: string) { this.enqueue(id); }
  async regenerate(id: string) { this.enqueue(id); }

  private enqueue(id: string) {
    if (this.running.has(id) || this.queue.includes(id)) return;
    this.queue.push(id); this.pump();
  }
  private pump() {
    while (this.active < this.concurrency && this.queue.length) {
      const id = this.queue.shift()!;
      this.active++; this.running.add(id);
      this.process(id)
        .catch((e) => markFailed(this.store, id, e instanceof Error ? e.message : String(e)))
        .finally(() => { this.active--; this.running.delete(id); this.pump(); });
    }
  }
  private async process(id: string) {
    let m = await this.store.get(id);
    if (!m) return;
    if (m.status === "UPLOADED") { await stepStartTranscribe(this.store, id); m = (await this.store.get(id))!; }
    if (m.status === "TRANSCRIBING") {
      while (!(await stepCheckTranscribe(this.store, id)).done) await sleep(8000);
      m = (await this.store.get(id))!;
    }
    if (m.status === "REFINING") {
      let prep = await stepRefinePrepare(this.store, id);
      while (prep.pending) { await sleep(30000); prep = await stepQwenCheck(this.store, id); }
      const { windows } = prep;
      if (windows.length) {
        for (const i of windows) await stepRefineWindow(this.store, id, i);
        await stepRefineMerge(this.store, id, windows.length);
      }
      m = (await this.store.get(id))!;
    }
    if (m.status === "SUMMARIZING") await stepSummarize(this.store, id);
  }
}
