import type { FileRefShape } from "./blog-author-config.js";
import { loadBlogAuthorFileRefShape } from "./blog-author-config.js";
import type { BlogReferenceShape } from "./blog-config.js";
import { loadBlogReferenceShape } from "./blog-config.js";

/**
 * Body Content global field on `blog` — references global `modular_body`.
 *
 * CMA shape:
 * `modular_body: { modular_blocks: [{ text: { group_title, subhead, text } }, { image: { file } }, ...] }`
 */
export type BlogBodyBlockUids = {
  /** Global field UID on the blog content type (e.g. `modular_body`). */
  fieldUid: string;
  /** Modular blocks array UID inside the global field (e.g. `modular_blocks`). */
  modularBlocksFieldUid: string;
  /** Max heading level for `group_title` (h3+ → `subhead`). Default 2. */
  headingGroupMaxLevel: number;
  text: {
    blockUid: string;
    groupTitle: string;
    subhead: string;
    text: string;
  };
  image: {
    blockUid: string;
    file: string;
  };
  videoAudio: {
    blockUid: string;
    video: string;
    refContentTypeUid: string;
    referenceShape: BlogReferenceShape;
  };
  fileRefShape: FileRefShape;
};

export type BlogBodySource = "blocks" | "rendered" | "blocks_then_rendered";

export function loadBlogBodySource(): BlogBodySource {
  const raw = (process.env.BLOG_BODY_SOURCE ?? "blocks_then_rendered").toLowerCase();
  if (raw === "blocks" || raw === "rendered") return raw;
  return "blocks_then_rendered";
}

export function loadBlogVideoRefContentTypeUid(): string {
  return process.env.BLOG_BODY_VIDEO_REF_CONTENT_TYPE?.trim() || process.env.CS_CONTENT_TYPE_VIDEO?.trim() || "video";
}

export function loadBlogBodyBlockUids(): BlogBodyBlockUids {
  const headingMax = Number(process.env.BLOG_BODY_HEADING_GROUP_MAX_LEVEL ?? "2");
  return {
    fieldUid:
      process.env.BLOG_FIELD_BODY_CONTENT?.trim() ||
      process.env.BLOG_FIELD_MODULAR_BODY?.trim() ||
      "modular_body",
    modularBlocksFieldUid:
      process.env.BLOG_FIELD_MODULAR_BLOCKS?.trim() || "modular_blocks",
    headingGroupMaxLevel: Number.isFinite(headingMax) && headingMax > 0 ? Math.floor(headingMax) : 2,
    text: {
      blockUid: process.env.BLOG_BODY_BLOCK_TEXT ?? "text",
      groupTitle: process.env.BLOG_BODY_TEXT_GROUP_TITLE ?? "group_title",
      subhead: process.env.BLOG_BODY_TEXT_SUBHEAD ?? "subhead",
      text: process.env.BLOG_BODY_TEXT_BODY ?? "text",
    },
    image: {
      blockUid: process.env.BLOG_BODY_BLOCK_IMAGE ?? "image",
      file: process.env.BLOG_BODY_IMAGE_FILE ?? "file",
    },
    videoAudio: {
      blockUid: process.env.BLOG_BODY_BLOCK_VIDEO_AUDIO ?? "video_audio",
      video: process.env.BLOG_BODY_VIDEO_FIELD ?? "video",
      refContentTypeUid: loadBlogVideoRefContentTypeUid(),
      referenceShape: loadBlogReferenceShape(),
    },
    fileRefShape: loadBlogAuthorFileRefShape(),
  };
}
