import React from 'react';

/** Minimal markdown renderer for agent messages: headings, tables, lists, bold/italic/code, links, hr. */

function inline(text: string, key = 0): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  // tokenize: `code`, **bold**, *italic*, [text](url)
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(\[([^\]]+)\]\((https?:[^)\s]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(<code key={`${key}-${i++}`}>{m[1].slice(1, -1)}</code>);
    else if (m[2]) out.push(<b key={`${key}-${i++}`}>{m[2].slice(2, -2)}</b>);
    else if (m[3]) out.push(<i key={`${key}-${i++}`}>{m[3].slice(1, -1)}</i>);
    else if (m[4]) out.push(
      <a key={`${key}-${i++}`} href={m[6]} target="_blank" rel="noreferrer">{m[5]}</a>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isSeparator = (l: string) => /^\s*\|?[\s:|-]+\|?\s*$/.test(l) && l.includes('-');

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r/g, '').split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let k = 0;

  while (i < lines.length) {
    const line = lines[i];

    // table
    if (isTableRow(line) && i + 1 < lines.length && isSeparator(lines[i + 1])) {
      const header = line.split('|').slice(1, -1).map((c) => c.trim());
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i])) {
        rows.push(lines[i].split('|').slice(1, -1).map((c) => c.trim()));
        i++;
      }
      blocks.push(
        <div className="md-table-wrap" key={k++}>
          <table className="md-table">
            <thead><tr>{header.map((h, x) => <th key={x}>{inline(h, k * 100 + x)}</th>)}</tr></thead>
            <tbody>
              {rows.map((r, y) => (
                <tr key={y}>{r.map((c, x) => <td key={x}>{inline(c, k * 1000 + y * 10 + x)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // heading
    const h = /^(#{1,4})\s+(.*)/.exec(line);
    if (h) {
      const level = h[1].length;
      blocks.push(<div className={`md-h md-h${level}`} key={k++}>{inline(h[2], k)}</div>);
      i++;
      continue;
    }

    // hr
    if (/^\s*([-*_]){3,}\s*$/.test(line)) {
      blocks.push(<hr className="md-hr" key={k++} />);
      i++;
      continue;
    }

    // list block
    if (/^\s*([-*•]|\d+\.)\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*•]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*•]|\d+\.)\s+/, ''));
        i++;
      }
      blocks.push(
        <ul className="md-ul" key={k++}>
          {items.map((it, x) => <li key={x}>{inline(it, k * 100 + x)}</li>)}
        </ul>,
      );
      continue;
    }

    // blank
    if (!line.trim()) {
      i++;
      continue;
    }

    // paragraph (merge consecutive plain lines)
    const para: string[] = [];
    while (
      i < lines.length && lines[i].trim() && !isTableRow(lines[i]) &&
      !/^(#{1,4})\s+/.test(lines[i]) && !/^\s*([-*•]|\d+\.)\s+/.test(lines[i]) &&
      !/^\s*([-*_]){3,}\s*$/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(
      <p className="md-p" key={k++}>
        {para.map((l, x) => (
          <React.Fragment key={x}>
            {x > 0 && <br />}
            {inline(l, k * 100 + x)}
          </React.Fragment>
        ))}
      </p>,
    );
  }

  return <div className="md">{blocks}</div>;
}
