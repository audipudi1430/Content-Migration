/** Contentstack `video` content type field UIDs (YouTube / Brightcove embed entries). */
export type VideoFieldUids = {
  type: string;
  youtubeUrl: string;
  brightcoveMediaId: string;
  url: string;
  mediaTitle: string;
  altText: string;
  typeYoutube: string;
  typeBrightcove: string;
  typeBrightcoveAudio: string;
};

export function loadVideoContentTypeUid(): string {
  return (
    process.env.BLOG_BODY_VIDEO_REF_CONTENT_TYPE?.trim() ||
    process.env.CS_CONTENT_TYPE_VIDEO?.trim() ||
    "video"
  );
}

export function loadVideoFieldUids(): VideoFieldUids {
  return {
    type: process.env.VIDEO_FIELD_TYPE?.trim() || "type",
    youtubeUrl: process.env.VIDEO_FIELD_YOUTUBE_URL?.trim() || "youtube_url",
    brightcoveMediaId: process.env.VIDEO_FIELD_BRIGHTCOVE_MEDIA_ID?.trim() || "brightcove_media_id",
    url: process.env.VIDEO_FIELD_URL?.trim() || "url",
    mediaTitle: process.env.VIDEO_FIELD_MEDIA_TITLE?.trim() || "media_title",
    altText: process.env.VIDEO_FIELD_ALT_TEXT?.trim() || "alt_text",
    typeYoutube: process.env.VIDEO_TYPE_YOUTUBE?.trim() || "YouTube",
    typeBrightcove: process.env.VIDEO_TYPE_BRIGHTCOVE?.trim() || "Brightcove",
    typeBrightcoveAudio: process.env.VIDEO_TYPE_BRIGHTCOVE_AUDIO?.trim() || "Brightcove Audio",
  };
}
