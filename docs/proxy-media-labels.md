# Media labels, byte sniffing, and where a label may still decide

Written 2026-11-21 after the segment proxy rejected real MPEG-TS segments the
AniKoto/MegaPlay CDN labelled `text/html`.

## The rule

A segment's **bytes** decide what it is. Its `Content-Type` and its file
extension are hints from a CDN that rotates both on purpose, and neither may
accept or reject a body.

- Accepted as MPEG-TS: `0x47` at offset 0, and again at offset 188 once 189
  bytes are in hand (a range too short to reach 188 falls back to the first
  byte). Relabelled `video/mp2t`.
- Accepted as fragmented MP4: `ftyp`/`styp`/`moof`/`sidx` at offset 4.
  Relabelled `video/mp4`.
- Rejected: the first non-whitespace byte is `<`, or `{`/`[` followed by text.
  That is a CDN error page or an expired-token JSON answer, refused under any
  label.

Measured 2026-11-21, play_id 21-1180, ani provider: `seg-f3-00001.html` returned
HTTP 200, 931,164 bytes, `content-type: text/html`, real MPEG-TS (0x47 at 0, 188,
376). Index 2 was `application/javascript` and index 3 `text/css`, both real TS.

## Audit: every label-only decision in this repo

| File | Decision | Status |
| --- | --- | --- |
| `app/api/proxy/segment/route.ts` | `isSuspiciousType()` + `isHtmlType(upstreamType) \|\| looksLikeHtml(body)` returned 502 | **Fixed.** The body decides; the label is never consulted for accept/reject. |
| `app/api/proxy/manifest/route.ts` | rewrites and relabels the playlist; reads the body as text | No label decision. A playlist is always served `application/vnd.apple.mpegurl`. |
| `app/api/proxy/subtitle/route.ts` | always answers `text/vtt; charset=utf-8` | No label decision: the body is passed through as VTT whatever the upstream said. |
| `app/api/proxy/ani-subtitle/route.ts` | always answers `text/vtt; charset=utf-8` | No label decision, same as above. |
| `app/api/watch/[playId]/route.ts` | `probeStream()` decides whether a stream is HLS by `stream.type` or a `.m3u8` in the URL, then looks for `#EXTM3U` | Not a media-label decision, and not reached by segment disguises: it probes the provider's stream URL, not a segment. Unchanged. |
| `lib/ani/resolve.ts` | resolves a provider embed; no media body is fetched | No label decision. |
| download helpers | none exist in this repo | n/a |

`isHtmlType`, `looksLikeHtml` and the `text/html`-alone 502 no longer exist
anywhere in `app/` or `lib/`.

## KumoriTV (read only, not changed)

Repo `wisdom-technologies-bit/kumoritv-repo` at `1fe13a2` (2026-11-20),
`frontend/`:

- `app/lib/proxy/sniff.ts:41-45` — `classifyChunk()` already decides MPEG-TS by
  bytes, with the same stronger check: `bytes[0] === 0x47 && (bytes.length < 189
  || bytes[188] === 0x47)`.
- `app/lib/proxy/segment-handler.ts:196-205` — the only rejection is
  `kind === "html" || (kind === "unknown" && upstreamHtml)`. A TS body labelled
  `text/html` classifies as `ts`, so it is accepted and relabelled `video/mp2t`
  by `sniffContentType()` (`sniff.ts:76`).

**KumoriTV does not have this bug**: the disguised `.html`, `.js` and `.css`
segments would be accepted there. One difference worth knowing, not a defect for
this task: a JSON error body classifies as `unknown` and is passed through when
the label is not html, while this repo now rejects it.

## Extension dependencies

| Location | Use | Can a rotating extension break it? |
| --- | --- | --- |
| `lib/proxy-signing.ts:87` (`signedResourceUrl`) | `.endsWith('.m3u8')` chooses the manifest route, else the segment route | No. `.html`, `.js`, `.css`, `.png`, `.webp`, `.gif`, `.woff` all route to `/api/proxy/segment`, which is correct. Only a playlist served under a non-`.m3u8` name would be mis-routed. |
| `lib/proxy-signing.ts:134` (`rewriteManifest`) | `.includes('.m3u8')` decides playlist vs media URI | No, for the same reason. Latent risk unrelated to rotation: `.includes` also matches `.m3u8` in a query string, so a segment URL carrying `?x=.m3u8` would be treated as a playlist. |
| `app/api/proxy/segment/route.ts` (`defaultType`) | last-resort label when the CDN sent no type and the body proves nothing | No. It only picks a label; it never accepts or rejects. |
| `app/api/watch/[playId]/route.ts:241` | `.includes('.m3u8')` decides whether to read a body as a playlist | No: it inspects the provider stream URL, not a segment. |

Signing itself is extension-free: the signature covers the encoded target URL
and headers, so rotating extensions change the URL (and therefore the signature)
but cannot break verification.

## What could not be verified

The live CDN: this sandbox cannot reach `*.mistyhorizon.space`, so every case
here is a stub upstream shaped from the owner's measurements. The first real
confirmation is `bash otaku-seg-test.sh 21-1180` after deploy.
