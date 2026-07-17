import fs from "node:fs/promises";
import path from "node:path";

const outputDir = path.resolve(process.argv[2] ?? "sample/csv");
const chunkRows = 1_000;

const specs = [
  { name: "large_100k_20cols.csv", rows: 100_000, columns: 20, kind: "standard" },
  { name: "large_500k_30cols.csv", rows: 500_000, columns: 30, kind: "standard" },
  { name: "wide_50k_200cols.csv", rows: 50_000, columns: 200, kind: "wide" },
  { name: "long_text_100k.csv", rows: 100_000, columns: 10, kind: "longText" },
  { name: "escaped_multiline_200k.csv", rows: 200_000, columns: 12, kind: "escaped" },
  { name: "utf8_bom_korean_100k.csv", rows: 100_000, columns: 16, kind: "korean", bom: true },
];

function escapeCsv(value) {
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function header(spec) {
  if (spec.kind === "longText") return ["id", "created_at", "title", "body", "tags", "author", "status", "score", "url", "notes"];
  if (spec.kind === "escaped") return ["id", "company", "contact", "address", "description", "json_payload", "status", "amount", "created_at", "category", "emoji", "nullable"];
  if (spec.kind === "korean") return ["id", "생성일", "사용자명", "도시", "부서", "상태", "금액", "비고", "검색어", "태그", "url", "점수", "활성", "등급", "메모", "빈값"];
  return Array.from({ length: spec.columns }, (_, col) => col === 0 ? "id" : `column_${String(col).padStart(3, "0")}`);
}

function row(spec, index) {
  const id = index + 1;
  if (spec.kind === "longText") {
    const body = `Record ${id}: ` + "A long searchable text field for virtual scrolling and cell truncation. ".repeat(12);
    return [id, `2026-07-${String((id % 28) + 1).padStart(2, "0")}T12:34:56Z`, `Sample article ${id}`, body, "performance,virtualization,csv", `author_${id % 500}`, id % 7 ? "active" : "archived", (id * 17) % 1000, `https://example.test/items/${id}`, id % 23 ? "" : "Optional note"];
  }
  if (spec.kind === "escaped") {
    return [id, `Acme, Branch ${id % 500}`, `Person "${id}"`, `${id % 999} Example Street\nSuite ${id % 99}`, `Comma, quote " and newline\nfor parser test #${id}`, `{"id":${id},"flags":[true,false],"label":"row ${id}"}`, id % 3 ? "open" : "closed", (id * 13.37).toFixed(2), `2026-07-${String((id % 28) + 1).padStart(2, "0")}`, `category_${id % 20}`, id % 29 ? "📄" : "⚠️", id % 17 ? "" : "null"];
  }
  if (spec.kind === "korean") {
    const names = ["김민준", "이서연", "박지훈", "최하은", "정도윤"];
    const cities = ["서울", "부산", "인천", "대전", "광주"];
    return [id, `2026-07-${String((id % 28) + 1).padStart(2, "0")}`, names[id % names.length], cities[id % cities.length], `개발${id % 8}팀`, id % 5 ? "진행 중" : "완료", (id * 981) % 10_000_000, `한글 텍스트와 UTF-8 인코딩 확인용 행 ${id}`, `대용량 CSV 뷰어 ${id}`, "테스트,한글,검색", `https://example.test/ko/${id}`, (id * 7) % 101, id % 2 ? "true" : "false", ["A", "B", "C", "D"][id % 4], id % 31 ? "" : "줄바꿈\n포함 메모", id % 11 ? "" : "값 있음"];
  }
  return Array.from({ length: spec.columns }, (_, col) => {
    if (col === 0) return id;
    if (col === 1) return `2026-07-${String((id % 28) + 1).padStart(2, "0")}`;
    if (col === 2) return `user_${String(id).padStart(7, "0")}`;
    if (col === 3) return (id * 7919) % 10_000_000;
    if (col === 4) return id % 2 ? "true" : "false";
    return `value_${col}_${id}_${(id * (col + 17)) % 99991}`;
  });
}

async function generate(spec) {
  const target = path.join(outputDir, spec.name);
  const handle = await fs.open(target, "w");
  try {
    await handle.write(spec.bom ? "\uFEFF" : "");
    await handle.write(`${header(spec).join(",")}\n`);
    for (let start = 0; start < spec.rows; start += chunkRows) {
      const end = Math.min(start + chunkRows, spec.rows);
      let chunk = "";
      for (let index = start; index < end; index += 1) chunk += `${row(spec, index).map(escapeCsv).join(",")}\n`;
      await handle.write(chunk);
    }
  } finally {
    await handle.close();
  }
  const { size } = await fs.stat(target);
  return { file: spec.name, rows: spec.rows, columns: header(spec).length, bytes: size };
}

await fs.mkdir(outputDir, { recursive: true });
const results = [];
for (const spec of specs) results.push(await generate(spec));
await fs.writeFile(path.join(outputDir, "README.md"), [
  "# CSV viewer test samples",
  "",
  "| File | Data rows | Columns | Purpose |",
  "| --- | ---: | ---: | --- |",
  ...results.map(({ file, rows, columns, bytes }) => `| ${file} | ${rows.toLocaleString()} | ${columns} | ${(bytes / 1024 / 1024).toFixed(1)} MiB generated file |`),
  "",
  "All files use UTF-8 and LF line endings; `utf8_bom_korean_100k.csv` intentionally begins with a UTF-8 BOM.",
].join("\n") + "\n");
console.table(results);
