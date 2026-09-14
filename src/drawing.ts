/**
 * get_drawing delivery (0004-bookstack-drawing-tool, REQ-BDG-001 clauses 1-8).
 *
 * Minimal upstream-PR-shaped addition: exactly one read tool plus its tests.
 * No write-path changes (bookstack-client.ts untouched); no new runtime
 * dependencies (node:buffer / node:zlib globals + global fetch only);
 * MIT license and upstream attribution preserved.
 *
 * Contract reference: docs/changes/0003-bookstack-diagram-access/specs/
 * bookstack-diagram-read.md REQ-BDG-001 clauses 1-8; reference decoder:
 * docs/changes/0003-bookstack-diagram-access/research/probe_png.py.
 */

import { createHash } from "node:crypto";
import { inflateRawSync, inflateSync, unzipSync } from "node:zlib";

// Bounds (REQ-BDG-001 clauses 3, 6).
export const DRAWING_PNG_MAX_BYTES = 5 * 1024 * 1024; // fetch cap -> DRAWING_TOO_LARGE
export const DRAWING_IMAGE_BLOCK_MAX_BYTES = 1024 * 1024; // 1 MiB opt-in image cap
export const DRAWING_DIGEST_MAX_CELLS = 2000;
export const DRAWING_DIGEST_MAX_CHARS = 100000;

export type DrawingErrorCode =
  | "DRAWING_NOT_FOUND"
  | "DRAWING_UNREADABLE"
  | "DRAWING_TOO_LARGE"
  | "WIKI_RATE_LIMITED"
  | "WIKI_UNAVAILABLE";

export class DrawingError extends Error {
  readonly code: DrawingErrorCode;
  constructor(code: DrawingErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Render a tool failure per the contract: `error: <CODE> — <bounded message>`. */
export function drawingErrorText(code: DrawingErrorCode, message: string): string {
  const bounded = message.replace(/\s+/g, " ").trim().slice(0, 200);
  return `error: ${code} — ${bounded}`;
}

export interface DrawingFetchConfig {
  baseUrl: string;
  tokenId: string;
  tokenSecret: string;
  timeoutMs?: number;
}

type FetchImpl = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

const DEFAULT_TIMEOUT_MS = 30000;

function authHeaders(config: DrawingFetchConfig): Record<string, string> {
  return {
    Authorization: `Token ${config.tokenId}:${config.tokenSecret}`,
    Accept: "application/json",
  };
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface FetchResult {
  status: number;
  text: string;
  bytes: Uint8Array | null;
}

/**
 * Exactly one bounded retry on 429 (Retry-After capped at 2 s); a second
 * 429 surfaces as WIKI_RATE_LIMITED. Timeouts and 5xx surface as
 * WIKI_UNAVAILABLE. No caching, no enumeration.
 */
async function fetchDrawingUrl(
  config: DrawingFetchConfig,
  url: string,
  accept: string,
  fetchImpl: FetchImpl,
): Promise<FetchResult> {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  for (let attempt = 0; attempt < 2; attempt++) {
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { ...authHeaders(config), Accept: accept },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new DrawingError("WIKI_UNAVAILABLE", "the wiki request timed out or failed");
    }
    if (response.status === 429 && attempt === 0) {
      const wait = parseRetryAfterMs(response.headers.get("retry-after"));
      await sleep(Math.min(wait ?? 1000, 2000));
      continue;
    }
    if (response.status === 429) {
      throw new DrawingError("WIKI_RATE_LIMITED", "the wiki rate limit was exceeded");
    }
    if (response.status >= 500) {
      throw new DrawingError("WIKI_UNAVAILABLE", "the wiki returned a server error");
    }
    if (response.status === 404) {
      throw new DrawingError("DRAWING_NOT_FOUND", "no such drawing exists");
    }
    if (response.status < 200 || response.status >= 300) {
      throw new DrawingError("WIKI_UNAVAILABLE", "the wiki request failed");
    }
    if (accept === "application/json") {
      const data = (await response.json()) as Record<string, unknown>;
      return { status: response.status, text: JSON.stringify(data), bytes: null };
    }
    const buf = new Uint8Array(await response.arrayBuffer());
    return { status: response.status, text: "", bytes: buf };
  }
  throw new DrawingError("WIKI_RATE_LIMITED", "the wiki rate limit was exceeded");
}

// ---------------------------------------------------------------------------
// PNG carve-out (tEXt / zTXt / iTXt keyword `mxfile`), ported from probe_png.py
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * tEXt/zTXt payloads are latin1 per the PNG spec, but writers in the wild
 * store raw UTF-8 there. Percent-encoded ASCII (what this wiki's draw.io
 * writer produces) is valid UTF-8 either way; raw UTF-8 decodes correctly
 * only via the UTF-8 path; genuine latin1 high-bytes are invalid UTF-8 and
 * fall back to latin1.
 */
function decodeTextBytes(bytes: Buffer): string {
  const utf8 = bytes.toString("utf8");
  return utf8.includes("�") ? bytes.toString("latin1") : utf8;
}

interface TextCarrier {
  keyword: string;
  text: string;
}

function carveTextCarriers(png: Uint8Array): TextCarrier[] {
  const buf = Buffer.from(png);
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return [];
  const out: TextCarrier[] = [];
  let off = 8;
  while (off + 8 <= buf.length) {
    const length = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString("latin1");
    const payload = buf.subarray(off + 8, off + 8 + length);
    off += 12 + length;
    if (off > buf.length + 8) break;
    if (type === "tEXt") {
      const sep = payload.indexOf(0);
      if (sep < 0) continue;
      out.push({
        keyword: payload.subarray(0, sep).toString("latin1"),
        text: decodeTextBytes(payload.subarray(sep + 1)),
      });
    } else if (type === "zTXt") {
      const sep = payload.indexOf(0);
      if (sep < 0 || sep + 2 > payload.length) continue;
      if (payload[sep + 1] !== 0) continue; // compression method must be deflate
      try {
        out.push({
          keyword: payload.subarray(0, sep).toString("latin1"),
          text: decodeTextBytes(inflateSync(payload.subarray(sep + 2))),
        });
      } catch {
        continue;
      }
    } else if (type === "iTXt") {
      // keyword NUL compFlag compMethod lang NUL translated NUL text
      const sep = payload.indexOf(0);
      if (sep < 0 || sep + 3 > payload.length) continue;
      const compFlag = payload[sep + 1];
      const compMethod = payload[sep + 2];
      let rest = payload.subarray(sep + 3);
      const langEnd = rest.indexOf(0);
      if (langEnd < 0) continue;
      rest = rest.subarray(langEnd + 1);
      const transEnd = rest.indexOf(0);
      if (transEnd < 0) continue;
      const textBytes = rest.subarray(transEnd + 1);
      try {
        const text =
          compFlag === 1
            ? compMethod === 0
              ? inflateSync(textBytes).toString("utf8")
              : null
            : textBytes.toString("utf8");
        if (text === null) continue;
        out.push({ keyword: payload.subarray(0, sep).toString("latin1"), text });
      } catch {
        continue;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Decode chain (ported from probe_png.py try_decode_mxfile / decode_diagram)
// ---------------------------------------------------------------------------

function tryInflateVariants(dec: Buffer): string | null {
  const attempts: Array<() => Buffer> = [
    () => inflateRawSync(dec),
    () => inflateSync(dec),
    () => unzipSync(dec),
  ];
  for (const attempt of attempts) {
    try {
      const raw = attempt().toString("utf8");
      if (!raw.includes("<") && raw.includes("%")) {
        try {
          return decodeURIComponent(raw);
        } catch {
          return raw;
        }
      }
      return raw;
    } catch {
      continue;
    }
  }
  return null;
}

function b64DecodeLoose(s: string): Buffer | null {
  const compact = s.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/=_-]*$/.test(compact) || compact.length < 4) return null;
  try {
    return Buffer.from(compact + "=".repeat((-compact.length % 4 + 4) % 4), "base64");
  } catch {
    return null;
  }
}

/** Decode an mxfile-level payload. Returns XML text or null. */
export function decodeMxfilePayload(text: string): string | null {
  const s = text.trim();
  if (s.startsWith("<")) return s;
  const b64 = b64DecodeLoose(s);
  if (b64) {
    const out = tryInflateVariants(b64);
    if (out !== null) return out;
  }
  const unquoted = safeUnquote(s);
  if (unquoted !== s) {
    if (unquoted.trimStart().startsWith("<")) return unquoted;
    const inflated = tryInflateVariants(Buffer.from(unquoted, "latin1"));
    if (inflated !== null) return inflated;
    const b64u = b64DecodeLoose(unquoted);
    if (b64u) {
      const out = tryInflateVariants(b64u);
      if (out !== null) return out;
    }
  }
  const raw = tryInflateVariants(Buffer.from(s, "latin1"));
  if (raw !== null) return raw;
  return null;
}

/** Decode a per-diagram inner payload. Returns mxGraphModel XML text or null. */
export function decodeDiagramPayload(inner: string): string | null {
  const s = (inner ?? "").trim();
  if (s.startsWith("<")) return s;
  const unquoted = safeUnquote(s);
  if (unquoted !== s && unquoted.trimStart().startsWith("<")) return unquoted;
  const candidates = unquoted !== s ? [s, unquoted] : [s];
  for (const cand of candidates) {
    const dec = b64DecodeLoose(cand);
    if (!dec) continue;
    const out = tryInflateVariants(dec);
    if (out !== null) return out;
  }
  return null;
}

function safeUnquote(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// ---------------------------------------------------------------------------
// Minimal constrained-XML extraction (no new dependencies).
// Shapes: <diagram name="..">INNER</diagram>; flat <mxCell .../> elements.
// ---------------------------------------------------------------------------

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => {
      try {
        return String.fromCodePoint(Number(n));
      } catch {
        return "";
      }
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => {
      try {
        return String.fromCodePoint(parseInt(n, 16));
      } catch {
        return "";
      }
    })
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function parseAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*("(?:[^"]*)"|'(?:[^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag)) !== null) {
    attrs[m[1]] = decodeXmlEntities(m[2].slice(1, -1));
  }
  return attrs;
}

interface DiagramBlock {
  name: string;
  inner: string;
  hasChildModel: boolean;
  childModel: string | null;
}

function extractDiagrams(mxfileXml: string): DiagramBlock[] | null {
  let root: string = mxfileXml;
  const mxfileMatch = /<mxfile\b[^>]*>([\s\S]*)<\/mxfile\s*>/i.exec(mxfileXml);
  if (mxfileMatch) root = mxfileMatch[1];
  else if (!/<diagram\b/i.test(mxfileXml)) return null;
  const out: DiagramBlock[] = [];
  const re = /<diagram\b([^>]*)>([\s\S]*?)<\/diagram\s*>/gi;
  let m: RegExpExecArray | null;
  let index = 0;
  while ((m = re.exec(root)) !== null) {
    index += 1;
    const attrs = parseAttrs(m[1]);
    const inner = m[2].trim();
    const child = /<mxGraphModel\b[\s\S]*<\/mxGraphModel\s*>/i.exec(inner);
    out.push({
      name: attrs["name"] || `Page-${index}`,
      inner,
      hasChildModel: child !== null,
      childModel: child ? child[0] : null,
    });
  }
  return out;
}

interface MxCell {
  id: string;
  value: string | null;
  vertex: boolean;
  edge: boolean;
  source: string | null;
  target: string | null;
  style: string | null;
}

function extractCells(modelXml: string): MxCell[] | null {
  if (!/<mxCell\b/i.test(modelXml)) return null;
  const out: MxCell[] = [];
  const re = /<mxCell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/mxCell\s*>)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(modelXml)) !== null) {
    const attrs = parseAttrs(m[1]);
    out.push({
      id: attrs["id"] ?? "",
      value: attrs["value"] ?? attrs["label"] ?? null,
      vertex: attrs["vertex"] === "1",
      edge: attrs["edge"] === "1",
      source: attrs["source"] ?? null,
      target: attrs["target"] ?? null,
      style: attrs["style"] ?? null,
    });
  }
  return out;
}

/** Contract label normalization: entities decoded, tags stripped, collapsed, empty -> `-`. */
export function normalizeLabel(value: string | null): string {
  if (value === null || value === undefined) return "-";
  let t = decodeXmlEntities(value);
  t = t.replace(/<br\s*\/?>/gi, " ");
  t = t.replace(/<\/(div|p|li|tr|h[1-6])>/gi, " ");
  t = t.replace(/<[^>]+>/g, "");
  t = t.replace(/\s+/g, " ").trim();
  return t === "" ? "-" : t;
}

function styleKind(style: string | null): "L" | "V" {
  const s = (style ?? "").trim().toLowerCase();
  if (s.includes("edgelabel") || s.startsWith("text;")) return "L";
  return "V";
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ---------------------------------------------------------------------------
// Digest emission
// ---------------------------------------------------------------------------

export interface DigestResult {
  digest: string;
  pngBytes: number;
  pngSha256: string;
  diagramCount: number;
  truncated: boolean;
}

export function emitDigest(
  drawingId: number,
  pageId: number,
  pngBytes: Uint8Array,
  imageOmitted: boolean,
): DigestResult {
  const pngSha256 = sha256Hex(pngBytes);
  const carriers = carveTextCarriers(pngBytes);
  const mxCarrier = carriers.find((c) => c.keyword === "mxfile");
  if (!mxCarrier) {
    throw new DrawingError("DRAWING_UNREADABLE", "the drawing payload has no diagram carrier");
  }
  const mxfileXml = decodeMxfilePayload(mxCarrier.text);
  if (mxfileXml === null) {
    throw new DrawingError("DRAWING_UNREADABLE", "the drawing payload could not be decoded");
  }
  const diagrams = extractDiagrams(mxfileXml);
  if (diagrams === null || diagrams.length === 0) {
    throw new DrawingError("DRAWING_UNREADABLE", "the drawing payload holds no diagrams");
  }

  const bodyLines: string[] = [];
  let truncated = false;
  let omittedCells = 0;

  for (let i = 0; i < diagrams.length; i++) {
    const diagram = diagrams[i];
    const modelXml =
      diagram.hasChildModel && diagram.childModel
        ? diagram.childModel
        : decodeDiagramPayload(diagram.inner);
    if (modelXml === null) {
      throw new DrawingError("DRAWING_UNREADABLE", "a diagram page could not be decoded");
    }
    const cells = extractCells(modelXml);
    if (cells === null) {
      throw new DrawingError("DRAWING_UNREADABLE", "a diagram page holds no readable cells");
    }
    const byId = new Map<string, string>();
    for (const cell of cells) {
      if (cell.id) byId.set(cell.id, normalizeLabel(cell.value));
    }
    const verts = cells.filter((c) => c.vertex);
    const edges = cells.filter((c) => c.edge);
    bodyLines.push(
      `## diagram ${i + 1} ${diagram.name} vertices ${verts.length} edges ${edges.length}`,
    );
    for (const cell of cells) {
      if (cell.edge) {
        const rawS = cell.source ?? null;
        const rawT = cell.target ?? null;
        let s = rawS ? (byId.get(rawS) ?? rawS) : "?";
        let t = rawT ? (byId.get(rawT) ?? rawT) : "?";
        if (s === "-") s = rawS ?? "?";
        if (t === "-") t = rawT ?? "?";
        bodyLines.push(`E ${cell.id} ${s} -> ${t} ${normalizeLabel(cell.value)}`);
      } else if (cell.vertex) {
        bodyLines.push(`${styleKind(cell.style)} ${cell.id} ${normalizeLabel(cell.value)}`);
      }
    }
  }

  // Digest caps: 2000 cells / 100000 characters, truncate at the last
  // complete line plus `[truncated: <N> cells omitted]` and truncated true.
  let emitted = bodyLines;
  const totalCells = bodyLines.filter((l) => /^[VLE] /.test(l)).length;
  if (totalCells > DRAWING_DIGEST_MAX_CELLS) {
    const kept: string[] = [];
    let keptCells = 0;
    for (const line of bodyLines) {
      if (/^[VLE] /.test(line) && keptCells >= DRAWING_DIGEST_MAX_CELLS) continue;
      if (/^[VLE] /.test(line)) keptCells += 1;
      kept.push(line);
    }
    omittedCells = totalCells - keptCells;
    emitted = kept;
    truncated = true;
  }
  const fits = (candidate: string[]) => candidate.join("\n").length + 1 <= DRAWING_DIGEST_MAX_CHARS;
  if (!fits(emitted)) {
    // Drop trailing cell lines (keeping headers) until the text fits.
    const kept = [...emitted];
    let dropped = 0;
    for (;;) {
      if (fits(kept)) break;
      let idx = -1;
      for (let k = kept.length - 1; k >= 0; k--) {
        if (/^[VLE] /.test(kept[k])) {
          idx = k;
          break;
        }
      }
      if (idx < 0) break;
      kept.splice(idx, 1);
      dropped += 1;
    }
    omittedCells += dropped;
    emitted = kept;
    truncated = true;
  }

  const head = [
    "# drawio-digest/1",
    `drawing ${drawingId} page ${pageId} png-bytes ${pngBytes.length} png-sha256 ${pngSha256} diagrams ${diagrams.length} truncated ${truncated ? "true" : "false"}`,
  ];
  if (imageOmitted) head.push("image-omitted: png-over-cap");
  const tail = truncated ? [`[truncated: ${omittedCells} cells omitted]`] : [];
  const digest = [...head, ...emitted, ...tail].join("\n") + "\n";
  return { digest, pngBytes: pngBytes.length, pngSha256, diagramCount: diagrams.length, truncated };
}

// ---------------------------------------------------------------------------
// Tool entry point (one drawing per call, read-only GETs, no caching)
// ---------------------------------------------------------------------------

export interface DrawingToolResult {
  digest: string;
  imageBase64: string | null;
}

export async function getDrawing(
  config: DrawingFetchConfig,
  drawingId: number,
  includeImage: boolean,
  fetchImpl?: FetchImpl,
): Promise<DrawingToolResult> {
  const impl: FetchImpl =
    fetchImpl ??
    ((globalThis as unknown as { fetch: FetchImpl }).fetch.bind(globalThis) as FetchImpl);
  if (!Number.isInteger(drawingId) || drawingId < 1) {
    throw new DrawingError("DRAWING_NOT_FOUND", "no such drawing exists");
  }
  const base = config.baseUrl.replace(/\/$/, "");

  // Type gate: never read arbitrary gallery images.
  const meta = await fetchDrawingUrl(
    config,
    `${base}/api/image-gallery/${drawingId}`,
    "application/json",
    impl,
  );
  let metaObj: Record<string, unknown>;
  try {
    metaObj = JSON.parse(meta.text) as Record<string, unknown>;
  } catch {
    throw new DrawingError("DRAWING_UNREADABLE", "the drawing record could not be read");
  }
  if (metaObj["type"] !== "drawio") {
    throw new DrawingError("DRAWING_NOT_FOUND", "no such drawing exists");
  }
  const pageId = Number(metaObj["uploaded_to"]);
  if (!Number.isInteger(pageId) || pageId < 1) {
    throw new DrawingError("DRAWING_UNREADABLE", "the drawing record has no owning page");
  }

  // PNG bytes with a 5 MiB fetch cap.
  const png = await fetchDrawingUrl(
    config,
    `${base}/api/image-gallery/${drawingId}/data`,
    "image/png",
    impl,
  );
  const bytes = png.bytes ?? new Uint8Array(0);
  if (bytes.length > DRAWING_PNG_MAX_BYTES) {
    throw new DrawingError("DRAWING_TOO_LARGE", "the drawing image exceeds the size cap");
  }
  if (bytes.length === 0) {
    throw new DrawingError("DRAWING_UNREADABLE", "the drawing image is empty");
  }

  const imageOmitted = includeImage && bytes.length > DRAWING_IMAGE_BLOCK_MAX_BYTES;
  const { digest } = emitDigest(drawingId, pageId, bytes, imageOmitted);
  const imageBase64 =
    includeImage && !imageOmitted ? Buffer.from(bytes).toString("base64") : null;
  return { digest, imageBase64 };
}
