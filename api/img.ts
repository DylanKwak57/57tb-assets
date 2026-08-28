/**
 * 이미지 서빙 함수 — LINE Flex 호환용 깨끗한 헤더.
 * Vercel 정적 서빙의 etag/content-disposition/must-revalidate를 피하려고
 * 함수로 직접 200 + Content-Type + immutable 캐시만 줌 (etag 없음).
 * 사용: /api/img?f=precision-campaign/digital-volume-jun2026.jpg
 */
import { readFileSync } from "fs";
import { join } from "path";

const GH_BASE =
  "https://raw.githubusercontent.com/DylanKwak57/57tb-assets/master/";

export default async function handler(req: any, res: any) {
  const f = String(req.query?.f || "precision-campaign/digital-volume-jun2026.jpg");
  // 경로 traversal 방지
  if (f.includes("..") || f.startsWith("/")) {
    res.writeHead(400).end("bad path");
    return;
  }
  let buf: Buffer;
  try {
    buf = readFileSync(join(process.cwd(), f));
  } catch {
    const r = await fetch(GH_BASE + f);
    if (!r.ok) {
      res.writeHead(404).end("not found");
      return;
    }
    buf = Buffer.from(await r.arrayBuffer());
  }
  const ext = f.split(".").pop()?.toLowerCase();
  const type = ext === "png" ? "image/png" : "image/jpeg";
  res.writeHead(200, {
    "Content-Type": type,
    "Cache-Control": "public, max-age=31536000, immutable",
  });
  res.end(buf);
}
