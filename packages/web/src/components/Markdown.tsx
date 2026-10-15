import { useMemo } from "react";
import { Marked } from "marked";

// 제목을 한 단계 내려 렌더 (# → h2): 패널 제목(h2)과 위계를 맞춘다
const md = new Marked({
  gfm: true,
  renderer: {
    heading({ tokens, depth }) {
      const level = Math.min(depth + 1, 6);
      return `<h${level}>${this.parser.parseInline(tokens)}</h${level}>\n`;
    },
  },
});

/** 마크다운 → HTML 문자열 (화면 렌더와 인쇄/내보내기가 공유) */
export const renderMarkdown = (source: string) => md.parse(source, { async: false }) as string;

export function Markdown({ source }: { source: string }) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}
