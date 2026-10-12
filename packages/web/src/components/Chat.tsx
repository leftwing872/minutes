import { useMemo } from "react";
import type { Turn } from "@minutes/shared";
import { fmtMs } from "../lib/time";

const HUES = [212, 152, 32, 282, 4, 192, 108, 328];

export function Chat({ turns, speakerMap, refined }: { turns: Turn[]; speakerMap: Record<string, string>; refined: boolean }) {
  const groups = useMemo(() => {
    const g: { speaker: string; startMs: number; texts: string[] }[] = [];
    for (const t of turns) {
      const last = g[g.length - 1];
      if (last && last.speaker === t.speaker) last.texts.push(t.text);
      else g.push({ speaker: t.speaker, startMs: t.startMs, texts: [t.text] });
    }
    return g;
  }, [turns]);
  const { hueOf, primary } = useMemo(() => {
    const order: string[] = [], len = new Map<string, number>();
    for (const t of turns) {
      if (!order.includes(t.speaker)) order.push(t.speaker);
      len.set(t.speaker, (len.get(t.speaker) ?? 0) + t.text.length);
    }
    const primary = [...len.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    return { hueOf: (s: string) => HUES[order.indexOf(s) % HUES.length]!, primary };
  }, [turns]);

  if (!turns.length) return <p className="muted">전사문이 비어 있습니다.</p>;
  const initial = (raw: string, display: string) => {
    if (display !== raw) return display[0] ?? "?";
    const m = raw.match(/(\d+)\s*$/);
    return m ? m[1]! : raw[0]?.toUpperCase() ?? "?";
  };
  return (
    <div className="chat">
      <p className="chat-note muted small">{refined ? "두 개의 음성인식 결과를 대조해 보정한 전사문입니다." : "음성인식 원문입니다. 보정 전이라 오타가 있을 수 있습니다."}</p>
      {groups.map((g, i) => {
        const h = hueOf(g.speaker), name = speakerMap[g.speaker] ?? g.speaker, mine = g.speaker === primary;
        return (
          <div key={i} className={`chat-row ${mine ? "mine" : ""}`}>
            {!mine && <div className="chat-avatar" aria-hidden="true" style={{ background: `hsl(${h} 42% 26%)` }}>{initial(g.speaker, name)}</div>}
            <div className="chat-body">
              <div className="chat-head">
                <span className="chat-name" style={{ color: `hsl(${h} 60% 68%)` }}>{name}</span>
                <span className="chat-time">{fmtMs(g.startMs)}</span>
              </div>
              {g.texts.map((t, j) => (
                <div key={j} className="chat-bubble" style={mine ? undefined : { borderColor: `hsl(${h} 34% 30%)` }}>{t}</div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
