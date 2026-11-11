"""Permissive pure-Python EPUB 2 & EPUB 3 parser using zipfile, lxml, and BeautifulSoup."""

from __future__ import annotations

import hashlib
import posixpath
import re
import zipfile
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Optional
from urllib.parse import unquote

from bs4 import BeautifulSoup, NavigableString, Tag
from lxml import etree

from app.tts.segmenter import SentenceItem, normalize_text, split_paragraph_sentences


class EpubParseError(ValueError):
    """Raised when an uploaded EPUB file is corrupt or cannot be parsed."""


@dataclass
class ParsedChapter:
    chapter_index: int
    href: str
    title: str
    sanitized_html: str
    sentences: list[SentenceItem]
    word_count: int
    char_count: int
    text_hash: str


@dataclass
class ParsedEpub:
    title: str
    author: str
    language: str
    description: str
    publisher: str
    cover_bytes: Optional[bytes]
    cover_ext: str
    assets: dict[str, bytes] = field(default_factory=dict)
    chapters: list[ParsedChapter] = field(default_factory=list)


_NS = {
    "c": "urn:oasis:names:tc:opendocument:xmlns:container",
    "opf": "http://www.idpf.org/2007/opf",
    "dc": "http://purl.org/dc/elements/1.1/",
    "ncx": "http://www.daisy.org/z3986/2005/ncx/",
    "xhtml": "http://www.w3.org/1999/xhtml",
    "epub": "http://www.idpf.org/2007/ops",
}

_BLOCK_TAGS = ("p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "pre")


def _safe_zip_member(zf: zipfile.ZipFile, member_path: str) -> bytes | None:
    norm = posixpath.normpath(unquote(member_path)).lstrip("/")
    for name in zf.namelist():
        if posixpath.normpath(name).lstrip("/") == norm:
            return zf.read(name)
    # Case-insensitive fallback for malformed EPUBs
    low = norm.lower()
    for name in zf.namelist():
        if posixpath.normpath(name).lstrip("/").lower() == low:
            return zf.read(name)
    return None


def _resolve_rel(base_dir: str, rel: str) -> str:
    clean = rel.split("#", 1)[0].split("?", 1)[0]
    clean = unquote(clean)
    if not base_dir or base_dir == ".":
        return posixpath.normpath(clean).lstrip("/")
    return posixpath.normpath(posixpath.join(base_dir, clean)).lstrip("/")


def _extract_toc_titles(zf: zipfile.ZipFile, opf_dir: str, manifest: dict[str, dict[str, str]], spine_nav_id: str | None) -> dict[str, str]:
    titles: dict[str, str] = {}

    # 1. Try EPUB 3 nav document
    nav_item = None
    for item in manifest.values():
        if "nav" in item.get("properties", "").split():
            nav_item = item
            break
    if nav_item:
        raw = _safe_zip_member(zf, _resolve_rel(opf_dir, nav_item["href"]))
        if raw:
            try:
                soup = BeautifulSoup(raw, "lxml")
                nav_el = soup.find("nav", attrs={"epub:type": "toc"}) or soup.find("nav")
                if nav_el:
                    nav_dir = posixpath.dirname(_resolve_rel(opf_dir, nav_item["href"]))
                    for a in nav_el.find_all("a", href=True):
                        href = _resolve_rel(nav_dir, a["href"])
                        lbl = normalize_text(a.get_text(" ", strip=True))
                        if href and lbl and href not in titles:
                            titles[href] = lbl
            except Exception:
                pass

    # 2. Try EPUB 2 NCX document
    ncx_item = manifest.get(spine_nav_id) if spine_nav_id else None
    if not ncx_item:
        for item in manifest.values():
            if item.get("media_type") == "application/x-dtbncx+xml" or item.get("href", "").lower().endswith(".ncx"):
                ncx_item = item
                break
    if ncx_item:
        ncx_path = _resolve_rel(opf_dir, ncx_item["href"])
        raw = _safe_zip_member(zf, ncx_path)
        if raw:
            try:
                root = etree.fromstring(raw)
                ncx_dir = posixpath.dirname(ncx_path)
                for np_el in root.findall(".//ncx:navPoint", _NS):
                    lbl_el = np_el.find("./ncx:navLabel/ncx:text", _NS)
                    cnt_el = np_el.find("./ncx:content", _NS)
                    if lbl_el is not None and cnt_el is not None and cnt_el.get("src"):
                        href = _resolve_rel(ncx_dir, cnt_el.get("src", ""))
                        lbl = normalize_text(lbl_el.text or "")
                        if href and lbl and href not in titles:
                            titles[href] = lbl
            except Exception:
                pass

    return titles


def _process_chapter_html(
    raw_bytes: bytes,
    chapter_path: str,
    book_id: str,
    sentence_counter_start: int = 0,
) -> tuple[str, str | None, list[SentenceItem]]:
    """Sanitize chapter XHTML, rewrite image URLs, and build deterministic paragraph/sentence spans."""
    text = raw_bytes.decode("utf-8", errors="replace")
    soup = BeautifulSoup(text, "lxml")

    # Remove unsafe/non-readable tags
    for bad in soup.find_all(["script", "style", "noscript", "iframe", "object", "embed"]):
        bad.decompose()

    chap_dir = posixpath.dirname(chapter_path)

    # Rewrite <img> and SVG <image> sources to local backend asset URLs
    for img in soup.find_all("img"):
        src = img.get("src")
        if src and not src.startswith(("http://", "https://", "data:")):
            resolved = _resolve_rel(chap_dir, src)
            img["src"] = f"/api/books/{book_id}/assets/{resolved}"
            img["loading"] = "lazy"

    for svg_img in soup.find_all("image"):
        for attr in ("xlink:href", "href"):
            val = svg_img.get(attr)
            if val and not val.startswith(("http://", "https://", "data:")):
                resolved = _resolve_rel(chap_dir, val)
                svg_img[attr] = f"/api/books/{book_id}/assets/{resolved}"

    # Extract fallback heading title
    heading_title: str | None = None
    for tag_name in ("h1", "h2", "h3"):
        h = soup.find(tag_name)
        if h:
            cand = normalize_text(h.get_text(" ", strip=True))
            if cand:
                heading_title = cand[:180]
                break
    if not heading_title and soup.title:
        cand = normalize_text(soup.title.get_text(" ", strip=True))
        if cand:
            heading_title = cand[:180]

    body = soup.body or soup

    # Ensure webnovel chapters wrapped in plain <div> without <p> still produce readable paragraphs
    block_elements: list[Tag] = []
    for el in body.find_all(_BLOCK_TAGS):
        # Skip nested blocks whose parent is already captured
        if any(parent in block_elements for parent in el.parents):
            continue
        block_elements.append(el)

    if not block_elements:
        # Fallback for plain-text or div-only chapters
        for div in body.find_all("div"):
            if not div.find(["div", "p", "h1", "h2", "h3", "h4", "ul", "ol"]):
                if normalize_text(div.get_text(" ", strip=True)):
                    block_elements.append(div)

    sentences: list[SentenceItem] = []
    para_idx = 0
    sent_idx = sentence_counter_start

    for block in block_elements:
        raw_txt = normalize_text(block.get_text(" ", strip=True))
        if not raw_txt:
            continue
        block["data-paragraph-idx"] = str(para_idx)
        sent_strs = split_paragraph_sentences(raw_txt)
        if not sent_strs:
            continue

        start_idx = sent_idx
        for s_str in sent_strs:
            sentences.append(
                SentenceItem(
                    sentence_index=sent_idx,
                    paragraph_index=para_idx,
                    text=s_str,
                )
            )
            sent_idx += 1
        end_idx = sent_idx - 1
        block["data-sentence-start"] = str(start_idx)
        block["data-sentence-end"] = str(end_idx)
        para_idx += 1

    # Also build sanitized HTML body inner content
    inner_html = "".join(str(child) for child in body.contents)
    return inner_html, heading_title, sentences


def parse_epub_file(epub_path: Path, book_id: str) -> ParsedEpub:
    """Parse an EPUB 2 or EPUB 3 archive into metadata, assets, and chapters."""
    try:
        zf = zipfile.ZipFile(str(epub_path), "r")
    except (zipfile.BadZipFile, OSError) as exc:
        raise EpubParseError(f"Corrupt or unreadable EPUB archive: {exc}") from exc

    with zf:
        container_bytes = _safe_zip_member(zf, "META-INF/container.xml")
        if not container_bytes:
            raise EpubParseError("Invalid EPUB: missing META-INF/container.xml")

        try:
            c_root = etree.fromstring(container_bytes)
        except etree.XMLSyntaxError as exc:
            raise EpubParseError(f"Invalid container.xml: {exc}") from exc

        rootfile_el = c_root.find(".//c:rootfile", _NS)
        if rootfile_el is None:
            rootfile_el = c_root.find(".//{*}rootfile")
        if rootfile_el is None or not rootfile_el.get("full-path"):
            raise EpubParseError("Invalid EPUB: rootfile OPF path missing in container.xml")

        opf_path = posixpath.normpath(rootfile_el.get("full-path", "")).lstrip("/")
        opf_dir = posixpath.dirname(opf_path)
        opf_bytes = _safe_zip_member(zf, opf_path)
        if not opf_bytes:
            raise EpubParseError(f"Invalid EPUB: missing OPF package file '{opf_path}'")

        try:
            opf_root = etree.fromstring(opf_bytes)
        except etree.XMLSyntaxError as exc:
            raise EpubParseError(f"Corrupt OPF metadata XML: {exc}") from exc

        # Extract Dublin Core metadata
        def _dc_text(tag: str) -> str:
            el = opf_root.find(f".//dc:{tag}", _NS)
            if el is None:
                el = opf_root.find(f".//{{*}}{tag}")
            return normalize_text("".join(el.itertext())) if el is not None else ""

        title = _dc_text("title") or epub_path.stem
        creators = [
            normalize_text("".join(el.itertext()))
            for el in (opf_root.findall(".//dc:creator", _NS) or opf_root.findall(".//{*}creator"))
        ]
        author = ", ".join([c for c in creators if c]) or "Unknown Author"
        language = _dc_text("language") or "en"
        description = _dc_text("description")
        publisher = _dc_text("publisher")

        # Parse manifest
        manifest: dict[str, dict[str, str]] = {}
        manifest_el = opf_root.find(".//opf:manifest", _NS)
        if manifest_el is None:
            manifest_el = opf_root.find(".//{*}manifest")
        if manifest_el is None:
            raise EpubParseError("Invalid EPUB: missing <manifest> in OPF")

        for item in manifest_el:
            if not isinstance(item.tag, str) or not item.tag.endswith("item"):
                continue
            iid = item.get("id", "")
            href = item.get("href", "")
            if iid and href:
                manifest[iid] = {
                    "id": iid,
                    "href": href,
                    "media_type": item.get("media-type", ""),
                    "properties": item.get("properties", ""),
                }

        # Find cover image
        cover_id: str | None = None
        for item in manifest.values():
            if "cover-image" in item.get("properties", "").split():
                cover_id = item["id"]
                break
        if not cover_id:
            for meta in opf_root.findall(".//{*}meta"):
                if meta.get("name") == "cover" and meta.get("content") in manifest:
                    cover_id = meta.get("content")
                    break
        if not cover_id:
            for iid, item in manifest.items():
                if "cover" in iid.lower() and item.get("media_type", "").startswith("image/"):
                    cover_id = iid
                    break

        cover_bytes: bytes | None = None
        cover_ext = ".jpg"
        if cover_id and cover_id in manifest:
            c_href = _resolve_rel(opf_dir, manifest[cover_id]["href"])
            cover_bytes = _safe_zip_member(zf, c_href)
            ext = PurePosixPath(c_href).suffix.lower()
            if ext in (".jpg", ".jpeg", ".png", ".webp", ".gif"):
                cover_ext = ext

        # Collect embedded images & styles for asset serving
        assets: dict[str, bytes] = {}
        for item in manifest.values():
            mtype = item.get("media_type", "")
            if mtype.startswith(("image/", "text/css", "font/", "application/font", "application/vnd.ms-opentype")):
                full_href = _resolve_rel(opf_dir, item["href"])
                data = _safe_zip_member(zf, full_href)
                if data is not None:
                    assets[full_href] = data

        # Parse spine
        spine_el = opf_root.find(".//opf:spine", _NS)
        if spine_el is None:
            spine_el = opf_root.find(".//{*}spine")
        if spine_el is None:
            raise EpubParseError("Invalid EPUB: missing <spine> in OPF")

        toc_id = spine_el.get("toc")
        toc_titles = _extract_toc_titles(zf, opf_dir, manifest, toc_id)

        chapters: list[ParsedChapter] = []
        chap_idx = 0
        for itemref in spine_el:
            if not isinstance(itemref.tag, str) or not itemref.tag.endswith("itemref"):
                continue
            idref = itemref.get("idref", "")
            if idref not in manifest:
                continue
            item = manifest[idref]
            mtype = item.get("media_type", "")
            if mtype and "html" not in mtype and "xml" not in mtype:
                continue

            chap_path = _resolve_rel(opf_dir, item["href"])
            raw = _safe_zip_member(zf, chap_path)
            if not raw:
                continue

            sanitized_html, heading_title, sentences = _process_chapter_html(
                raw, chap_path, book_id=book_id, sentence_counter_start=0
            )
            plain_all = " ".join(s.text for s in sentences)
            words = len(re.findall(r"\S+", plain_all))
            # Skip empty cover/title-only wrappers if they have zero words AND zero images
            if words == 0 and "<img" not in sanitized_html.lower():
                continue

            title_guess = toc_titles.get(chap_path) or heading_title or f"Chapter {chap_idx + 1}"
            text_hash = hashlib.sha256(plain_all.encode("utf-8")).hexdigest()[:24]
            chapters.append(
                ParsedChapter(
                    chapter_index=chap_idx,
                    href=chap_path,
                    title=title_guess,
                    sanitized_html=sanitized_html,
                    sentences=sentences,
                    word_count=words,
                    char_count=len(plain_all),
                    text_hash=text_hash,
                )
            )
            chap_idx += 1

        if not chapters:
            raise EpubParseError("EPUB contains no readable text chapters.")

        return ParsedEpub(
            title=title,
            author=author,
            language=language,
            description=description,
            publisher=publisher,
            cover_bytes=cover_bytes,
            cover_ext=cover_ext,
            assets=assets,
            chapters=chapters,
        )
