"""Sentence-level text segmentation and TTS chunk planning for prose and webnovels."""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass


ABBREVIATIONS = {
    "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc",
    "gen", "col", "lt", "sgt", "capt", "cmdr", "rev", "hon",
    "vol", "ch", "fig", "no", "nos", "inc", "ltd", "corp",
    "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
}

_SENTENCE_SPLIT_RE = re.compile(
    r"""(?<=[.!?。！？…])["'”’\)\]\*]*\s+(?=[A-Z0-9"'“‘\(\[\*<\u4e00-\u9fff])"""
)
_WHITESPACE_RE = re.compile(r"\s+")


@dataclass
class SentenceItem:
    sentence_index: int
    paragraph_index: int
    text: str


@dataclass
class ChunkPlan:
    chunk_index: int
    sentence_start: int
    sentence_end: int
    sentences: list[SentenceItem]
    text_hash: str


def normalize_text(text: str) -> str:
    return _WHITESPACE_RE.sub(" ", text).strip()


def split_paragraph_sentences(paragraph_text: str) -> list[str]:
    """Split a paragraph into natural sentences without breaking common abbreviations or decimals."""
    clean = normalize_text(paragraph_text)
    if not clean:
        return []

    raw_parts = _SENTENCE_SPLIT_RE.split(clean)
    merged: list[str] = []
    for part in raw_parts:
        part = part.strip()
        if not part:
            continue
        if merged:
            prev = merged[-1]
            # Check trailing abbreviation before a period (e.g. "Mr." or "Dr." or single initial "J.")
            m = re.search(r"\b([A-Za-z]{1,6})\.$", prev)
            if m:
                token = m.group(1).lower()
                if token in ABBREVIATIONS or (len(token) == 1 and token.isalpha()):
                    merged[-1] = f"{prev} {part}"
                    continue
            # Check decimal or ellipsis continuation starting lowercase
            if re.search(r"\d\.$", prev) and re.match(r"^\d", part):
                merged[-1] = f"{prev}{part}"
                continue
        merged.append(part)

    # Guard against excessively long sentences (> 420 chars) by splitting cleanly at clause boundaries
    final_sentences: list[str] = []
    for sent in merged:
        if len(sent) <= 420:
            final_sentences.append(sent)
            continue
        clauses = re.split(r"(?<=[;—–,])\s+", sent)
        buf = ""
        for cl in clauses:
            if not buf:
                buf = cl
            elif len(buf) + 1 + len(cl) <= 320:
                buf = f"{buf} {cl}"
            else:
                final_sentences.append(buf)
                buf = cl
        if buf:
            final_sentences.append(buf)

    return [s for s in final_sentences if s.strip()]


def build_chunk_plans(
    sentences: list[SentenceItem],
    batch_size: int = 1,
    max_chunk_chars: int = 320,
) -> list[ChunkPlan]:
    """Group ordered sentences into TTS chunks, coalescing ultra-short lines in the same paragraph."""
    if not sentences:
        return []

    batch_size = max(1, min(int(batch_size), 4))
    # Even when batch_size=1, merge tiny 1-4 word fragments (<= 42 chars) with the next sentence
    # in the same paragraph so short exclamations don't pay full prefill overhead.
    max_group_sents = max(batch_size, 3)
    plans: list[ChunkPlan] = []
    idx = 0
    chunk_idx = 0

    while idx < len(sentences):
        group: list[SentenceItem] = [sentences[idx]]
        chars = len(sentences[idx].text)
        idx += 1

        while idx < len(sentences) and len(group) < max_group_sents:
            nxt = sentences[idx]
            prev = group[-1]
            same_para = nxt.paragraph_index == prev.paragraph_index
            should_merge_short = same_para and (len(prev.text) <= 42 or len(nxt.text) <= 35) and (chars + len(nxt.text) <= 180)
            within_batch = len(group) < batch_size and (chars + len(nxt.text) <= max_chunk_chars)
            if not (should_merge_short or within_batch):
                break
            group.append(nxt)
            chars += len(nxt.text)
            idx += 1

        joined = "\n".join(item.text for item in group)
        thash = hashlib.sha256(joined.encode("utf-8")).hexdigest()[:24]
        plans.append(
            ChunkPlan(
                chunk_index=chunk_idx,
                sentence_start=group[0].sentence_index,
                sentence_end=group[-1].sentence_index,
                sentences=group,
                text_hash=thash,
            )
        )
        chunk_idx += 1

    return plans

