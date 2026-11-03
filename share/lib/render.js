// Turns a note's markdown into HTML that is safe to show to anyone.
//
// Raw HTML in the note is escaped (only <u> for underline is kept), links are
// limited to http(s) and mailto, and images point at the copies uploaded with
// the note, so a published page can never run script or load the author's
// local files.

import { Marked } from "marked";

const VIDEO_RE = /\.(mp4|m4v|mov|webm)(\?|#|$)/i;
const YOUTUBE_RE = /^https?:\/\/(?:(?:www|m)\.)?(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{11})/;

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeUrl(href) {
  try {
    const url = new URL(href);
    return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:" ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} markdown note body without frontmatter
 * @param {Record<string, string>} files attachment src (as written in the note) -> uploaded URL
 */
export function renderNote(markdown, files = {}) {
  const resolveMedia = (src) => {
    let key = src;
    try { key = decodeURI(src); } catch {}
    return files[key] || files[src] || safeUrl(src);
  };

  const marked = new Marked({
    gfm: true,
    breaks: false,
    renderer: {
      html({ text }) {
        return /^<\/?u>$/i.test(text.trim()) ? text.trim().toLowerCase() : escapeHtml(text);
      },
      link({ href, title, tokens }) {
        const inner = this.parser.parseInline(tokens);
        const url = safeUrl(href);
        if (!url) return inner;
        const t = title ? ` title="${escapeHtml(title)}"` : "";
        return `<a href="${escapeHtml(url)}"${t} target="_blank" rel="noopener noreferrer nofollow">${inner}</a>`;
      },
      image({ href, title, text }) {
        const yt = YOUTUBE_RE.exec(href || "");
        if (yt) {
          return `<span class="embed"><iframe src="https://www.youtube-nocookie.com/embed/${yt[1]}" title="${escapeHtml(text || "YouTube video")}" allowfullscreen loading="lazy" referrerpolicy="strict-origin-when-cross-origin"></iframe></span>`;
        }
        const url = resolveMedia(href || "");
        if (!url) return `<span class="missing">${escapeHtml(text || "Image not shared")}</span>`;
        const alt = escapeHtml(text || "");
        const t = title ? ` title="${escapeHtml(title)}"` : "";
        if (VIDEO_RE.test(href)) return `<video src="${escapeHtml(url)}" controls preload="metadata"${t}></video>`;
        return `<img src="${escapeHtml(url)}" alt="${alt}"${t} loading="lazy">`;
      },
    },
  });

  return marked.parse(markdown || "", { async: false });
}
