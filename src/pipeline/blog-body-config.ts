import type { FileRefShape } from "./blog-author-config.js";
import { loadBlogAuthorFileRefShape } from "./blog-author-config.js";

/** Modular block UIDs and inner field UIDs for Body Content on `blog`. */
export type BlogBodyBlockUids = {
  /** Top-level Modular Blocks field UID (e.g. `body_content`). */
  fieldUid: string;
  text: {
    blockUid: string;
    groupTitle: string;
    subhead: string;
    text: string;
  };
  image: {
    blockUid: string;
    file: string;
    caption: string;
    enlarge: string;
  };
  imageTextWrap: {
    blockUid: string;
    image: string;
    imageFile: string;
    imageCaption: string;
    imageEnlarge: string;
    imagePosition: string;
    text: string;
    textSubhead: string;
    textBody: string;
  };
  pullQuote: {
    blockUid: string;
    groupTitle: string;
    author: string;
    quote: string;
  };
  video: {
    blockUid: string;
    video: string;
  };
  fileRefShape: FileRefShape;
  /** Default enlarge value for image blocks (omit when unset). */
  imageEnlargeDefault?: boolean | string;
};

export type BlogBodySource = "blocks" | "rendered" | "blocks_then_rendered";

export function loadBlogBodySource(): BlogBodySource {
  const raw = (process.env.BLOG_BODY_SOURCE ?? "blocks_then_rendered").toLowerCase();
  if (raw === "blocks" || raw === "rendered") return raw;
  return "blocks_then_rendered";
}

export function loadBlogBodyBlockUids(): BlogBodyBlockUids {
  const enlargeDefault = process.env.BLOG_BODY_IMAGE_ENLARGE_DEFAULT?.trim();
  let imageEnlargeDefault: boolean | string | undefined;
  if (enlargeDefault === "1" || enlargeDefault?.toLowerCase() === "true") imageEnlargeDefault = true;
  else if (enlargeDefault === "0" || enlargeDefault?.toLowerCase() === "false") imageEnlargeDefault = false;
  else if (enlargeDefault) imageEnlargeDefault = enlargeDefault;

  return {
    fieldUid: process.env.BLOG_FIELD_BODY_CONTENT ?? "body_content",
    text: {
      blockUid: process.env.BLOG_BODY_BLOCK_TEXT ?? "text",
      groupTitle: process.env.BLOG_BODY_TEXT_GROUP_TITLE ?? "group_title",
      subhead: process.env.BLOG_BODY_TEXT_SUBHEAD ?? "subhead",
      text: process.env.BLOG_BODY_TEXT_BODY ?? "text",
    },
    image: {
      blockUid: process.env.BLOG_BODY_BLOCK_IMAGE ?? "image",
      file: process.env.BLOG_BODY_IMAGE_FILE ?? "file",
      caption: process.env.BLOG_BODY_IMAGE_CAPTION ?? "caption",
      enlarge: process.env.BLOG_BODY_IMAGE_ENLARGE ?? "enlarge",
    },
    imageTextWrap: {
      blockUid: process.env.BLOG_BODY_BLOCK_IMAGE_TEXT_WRAP ?? "image_text_wrap",
      image: process.env.BLOG_BODY_ITW_IMAGE_GROUP ?? "image",
      imageFile: process.env.BLOG_BODY_ITW_IMAGE_FILE ?? "file",
      imageCaption: process.env.BLOG_BODY_ITW_IMAGE_CAPTION ?? "caption",
      imageEnlarge: process.env.BLOG_BODY_ITW_IMAGE_ENLARGE ?? "enlarge",
      imagePosition: process.env.BLOG_BODY_ITW_IMAGE_POSITION ?? "position",
      text: process.env.BLOG_BODY_ITW_TEXT_GROUP ?? "text",
      textSubhead: process.env.BLOG_BODY_ITW_TEXT_SUBHEAD ?? "subhead",
      textBody: process.env.BLOG_BODY_ITW_TEXT_BODY ?? "text",
    },
    pullQuote: {
      blockUid: process.env.BLOG_BODY_BLOCK_PULL_QUOTE ?? "pull_quote",
      groupTitle: process.env.BLOG_BODY_PULL_QUOTE_GROUP_TITLE ?? "group_title",
      author: process.env.BLOG_BODY_PULL_QUOTE_AUTHOR ?? "author",
      quote: process.env.BLOG_BODY_PULL_QUOTE_QUOTE ?? "quote",
    },
    video: {
      blockUid: process.env.BLOG_BODY_BLOCK_VIDEO ?? "video",
      video: process.env.BLOG_BODY_VIDEO_FIELD ?? "video",
    },
    fileRefShape: loadBlogAuthorFileRefShape(),
    imageEnlargeDefault,
  };
}
