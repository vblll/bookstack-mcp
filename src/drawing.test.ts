import test from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync, deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import {
  DRAWING_DIGEST_MAX_CELLS,
  decodeDiagramPayload,
  decodeMxfilePayload,
  drawingErrorText,
  emitDigest,
  getDrawing,
  normalizeLabel,
} from "./drawing.js";

// ---------------------------------------------------------------------------
// Helpers: synthetic PNGs (carve-out reads lengths only; CRC left zero).
// ---------------------------------------------------------------------------

function chunk(type: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(payload.length, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, payload, Buffer.alloc(4)]);
}

function textPayload(keyword: string, text: Buffer | string): Buffer {
  return Buffer.concat([Buffer.from(keyword + "\0", "latin1"), Buffer.from(text as never)]);
}

function makePng(carrierChunks: Buffer[]): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const iend = chunk("IEND", Buffer.alloc(0));
  return Buffer.concat([sig, ...carrierChunks, iend]);
}

function modelXml(cells: string): string {
  return `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells}</root></mxGraphModel>`;
}

const SMALL_MODEL = modelXml(
  `<mxCell id="a1" value="УТ 11.5" vertex="1" parent="1"/>` +
    `<mxCell id="a2" value="&lt;b&gt;БП2&lt;/b&gt;" vertex="1" parent="1"/>` +
    `<mxCell id="a3" value="text" style="text;html=1;" vertex="1" parent="1"/>` +
    `<mxCell id="e1" value="утбп2" edge="1" source="a1" target="a2" parent="1"/>` +
    `<mxCell id="e2" edge="1" parent="1"/>`,
);

function mxfileXml(model: string): string {
  return `<mxfile host="x" version="1"><diagram name="Page-1">${model}</diagram></mxfile>`;
}

const SMALL_PNG = makePng([chunk("tEXt", textPayload("mxfile", mxfileXml(SMALL_MODEL)))]);
const SMALL_SHA = createHash("sha256").update(SMALL_PNG).digest("hex");

function stubFetch(
  meta: { type: string; uploaded_to: number } | null,
  png: Buffer | null,
  opts: { metaStatus?: number; pngStatus?: number } = {},
) {
  return async (url: string) => {
    const jsonHeaders = { get: () => "application/json" };
    const pngHeaders = { get: () => "image/png" };
    if (url.endsWith("/data")) {
      const status = opts.pngStatus ?? (png ? 200 : 404);
      return {
        status,
        headers: pngHeaders,
        json: async () => ({}),
        arrayBuffer: async () =>
          (png ? new Uint8Array(png) : new Uint8Array(0)).buffer as ArrayBuffer,
      };
    }
    const status = opts.metaStatus ?? (meta ? 200 : 404);
    return {
      status,
      headers: jsonHeaders,
      json: async () => meta ?? {},
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
}

async function rejectsWithCode(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    assert.equal((error as { code?: string }).code, code);
    return;
  }
  assert.fail(`expected rejection with ${code}`);
}

const CONFIG = { baseUrl: "https://wiki.example", tokenId: "t", tokenSecret: "s" };

// ---------------------------------------------------------------------------

test("digest is deterministic and line-ordered (V/L/E in document order)", async () => {
  const fetch = stubFetch({ type: "drawio", uploaded_to: 70 }, SMALL_PNG);
  const first = await getDrawing(CONFIG, 265, false, fetch as never);
  const second = await getDrawing(CONFIG, 265, false, fetch as never);
  assert.equal(first.digest, second.digest);
  assert.equal(first.imageBase64, null);
  const lines = first.digest.split("\n");
  assert.equal(lines[0], "# drawio-digest/1");
  assert.equal(
    lines[1],
    `drawing 265 page 70 png-bytes ${SMALL_PNG.length} png-sha256 ${SMALL_SHA} diagrams 1 truncated false`,
  );
  assert.equal(lines[2], "## diagram 1 Page-1 vertices 3 edges 2");
  assert.deepEqual(lines.slice(3, 8), [
    "V a1 УТ 11.5",
    "V a2 БП2",
    "L a3 text",
    "E e1 УТ 11.5 -> БП2 утбп2",
    "E e2 ? -> ? -",
  ]);
});

test("decode chain: percent-encoded uncompressed mxfile", () => {
  const xml = mxfileXml(SMALL_MODEL);
  const out = decodeMxfilePayload(encodeURIComponent(xml));
  assert.ok(out !== null && out.includes("<mxfile"));
});

test("decode chain: base64 + raw-deflate compressed mxfile", () => {
  const xml = mxfileXml(SMALL_MODEL);
  const compressed = deflateRawSync(Buffer.from(encodeURIComponent(xml), "utf8")).toString("base64");
  const out = decodeMxfilePayload(compressed);
  assert.ok(out !== null && out.includes("<mxfile"));
});

test("decode chain: compressed diagram inner payload", () => {
  const inner = deflateRawSync(Buffer.from(encodeURIComponent(SMALL_MODEL), "utf8")).toString(
    "base64",
  );
  const xml = `<mxfile><diagram name="D">${inner}</diagram></mxfile>`;
  const png = makePng([chunk("tEXt", textPayload("mxfile", xml))]);
  const { digest } = emitDigest(1, 2, new Uint8Array(png), false);
  assert.ok(digest.includes("## diagram 1 D vertices 3 edges 2"));
  assert.ok(digest.includes("V a1 УТ 11.5"));
});

test("decode chain: zTXt carrier", () => {
  const payload = Buffer.concat([
    Buffer.from("mxfile\0", "latin1"),
    Buffer.from([0]),
    deflateSync(Buffer.from(mxfileXml(SMALL_MODEL), "utf8")),
  ]);
  const png = makePng([chunk("zTXt", payload)]);
  const { digest } = emitDigest(7, 8, new Uint8Array(png), false);
  assert.ok(digest.includes("drawing 7 page 8"));
  assert.ok(digest.includes("V a1 УТ 11.5"));
});

test("decodeDiagramPayload: urlencode-plain inner", () => {
  const out = decodeDiagramPayload(encodeURIComponent(SMALL_MODEL));
  assert.ok(out !== null && out.includes("<mxGraphModel"));
});

test("labels: entities decoded, tags stripped, whitespace collapsed, empty -> -", () => {
  assert.equal(normalizeLabel("&lt;b&gt;A&lt;/b&gt;<br> B"), "A B");
  assert.equal(normalizeLabel("  a\n\tb  "), "a b");
  assert.equal(normalizeLabel(""), "-");
  assert.equal(normalizeLabel(null), "-");
  assert.equal(normalizeLabel("<div>x</div><p>y</p>"), "x y");
});

test("endpoints resolve to labels, else raw id, else ?", async () => {
  const fetch = stubFetch({ type: "drawio", uploaded_to: 70 }, SMALL_PNG);
  const { digest } = await getDrawing(CONFIG, 265, false, fetch as never);
  assert.ok(digest.includes("E e1 УТ 11.5 -> БП2 утбп2"));
  assert.ok(digest.includes("E e2 ? -> ? -"));
});

test("truncation at the 2000-cell cap with omitted count", () => {
  let cells = "";
  for (let i = 0; i < DRAWING_DIGEST_MAX_CELLS + 100; i++) {
    cells += `<mxCell id="v${i}" value="n${i}" vertex="1" parent="1"/>`;
  }
  const png = makePng([chunk("tEXt", textPayload("mxfile", mxfileXml(modelXml(cells))))]);
  const { digest, truncated } = emitDigest(1, 1, new Uint8Array(png), false);
  assert.equal(truncated, true);
  assert.ok(digest.includes("truncated true"));
  assert.ok(digest.includes("[truncated: 100 cells omitted]"));
  const kept = digest.split("\n").filter((l) => /^[VLE] /.test(l));
  assert.equal(kept.length, DRAWING_DIGEST_MAX_CELLS);
});

test("truncation at the 100000-char cap", () => {
  const big = "x".repeat(110000);
  const png = makePng([
    chunk("tEXt", textPayload("mxfile", mxfileXml(modelXml(`<mxCell id="v1" value="${big}" vertex="1" parent="1"/>`)))),
  ]);
  const { digest, truncated } = emitDigest(1, 1, new Uint8Array(png), false);
  assert.equal(truncated, true);
  assert.ok(digest.includes("truncated true"));
  assert.ok(/\[truncated: \d+ cells omitted\]/.test(digest));
});

test("DRAWING_NOT_FOUND: missing id and non-drawio type", async () => {
  const missing = stubFetch(null, null, { metaStatus: 404 });
  await rejectsWithCode(getDrawing(CONFIG, 999999, false, missing as never), 'DRAWING_NOT_FOUND');
  const gallery = stubFetch({ type: "gallery", uploaded_to: 70 }, SMALL_PNG);
  await rejectsWithCode(getDrawing(CONFIG, 5, false, gallery as never), 'DRAWING_NOT_FOUND');
  await rejectsWithCode(getDrawing(CONFIG, 0, false, missing as never), 'DRAWING_NOT_FOUND');
});

test("DRAWING_UNREADABLE: no mxfile carrier and undecodable payload", async () => {
  const noCarrier = makePng([chunk("tEXt", textPayload("note", "hello"))]);
  await rejectsWithCode(
    getDrawing(CONFIG, 1, false, stubFetch({ type: "drawio", uploaded_to: 1 }, noCarrier) as never),
    "DRAWING_UNREADABLE",
  );
  const garbage = makePng([chunk("tEXt", textPayload("mxfile", "%%%not-xml%%%"))]);
  await rejectsWithCode(
    getDrawing(CONFIG, 1, false, stubFetch({ type: "drawio", uploaded_to: 1 }, garbage) as never),
    "DRAWING_UNREADABLE",
  );
});

test("DRAWING_TOO_LARGE: PNG over the 5 MiB fetch cap", async () => {
  const big = Buffer.alloc(5 * 1024 * 1024 + 1);
  SMALL_PNG.copy(big, 0);
  await rejectsWithCode(
    getDrawing(CONFIG, 1, false, stubFetch({ type: "drawio", uploaded_to: 1 }, big) as never),
    "DRAWING_TOO_LARGE",
  );
});

test("WIKI_RATE_LIMITED: 429 on both attempts after one bounded retry", async () => {
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    return {
      status: 429,
      headers: { get: () => "0" },
      json: async () => ({}),
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
  await rejectsWithCode(getDrawing(CONFIG, 1, false, fetch as never), "WIKI_RATE_LIMITED");
  assert.equal(calls, 2);
});

test("WIKI_UNAVAILABLE: 500 and transport timeout", async () => {
  const failing = async () => ({
    status: 500,
    headers: { get: () => null },
    json: async () => ({}),
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  await rejectsWithCode(getDrawing(CONFIG, 1, false, failing as never), 'WIKI_UNAVAILABLE');
  const throwing = async () => {
    throw new Error("timeout");
  };
  await rejectsWithCode(getDrawing(CONFIG, 1, false, throwing as never), 'WIKI_UNAVAILABLE');
});

test("error text form carries the code verbatim and no content", async () => {
  const text = drawingErrorText("DRAWING_NOT_FOUND", "no such drawing exists");
  assert.ok(text.startsWith("error: DRAWING_NOT_FOUND — "));
  const missing = stubFetch(null, null, { metaStatus: 404 });
  try {
    await getDrawing(CONFIG, 1, false, missing as never);
    assert.fail("expected rejection");
  } catch (error) {
    assert.match(drawingErrorText("DRAWING_NOT_FOUND", (error as Error).message), /DRAWING_NOT_FOUND/);
  }
});

test("image block: shape for a <= 1 MiB PNG, omit line above the cap", async () => {
  const small = await getDrawing(
    CONFIG,
    265,
    true,
    stubFetch({ type: "drawio", uploaded_to: 70 }, SMALL_PNG) as never,
  );
  assert.ok(small.imageBase64 !== null);
  assert.deepEqual(Buffer.from(small.imageBase64 as string, "base64"), SMALL_PNG);
  assert.ok(!small.digest.includes("image-omitted"));

  const pad = Buffer.alloc(1024 * 1024 + 1, 65);
  const bigPng = makePng([
    chunk("tEXt", textPayload("mxfile", mxfileXml(SMALL_MODEL))),
    chunk("tEXt", textPayload("pad", pad)),
  ]);
  assert.ok(bigPng.length > 1024 * 1024);
  const big = await getDrawing(
    CONFIG,
    265,
    true,
    stubFetch({ type: "drawio", uploaded_to: 70 }, bigPng) as never,
  );
  assert.equal(big.imageBase64, null);
  assert.ok(big.digest.includes("image-omitted: png-over-cap"));
});
