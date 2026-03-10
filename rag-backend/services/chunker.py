"""
Chunker — Splits text into semantic chunks using LangChain
"""
import tiktoken
from langchain_text_splitters import RecursiveCharacterTextSplitter
from config import CHUNK_SIZE, CHUNK_OVERLAP


# Token counter using tiktoken (cl100k_base = GPT-4 tokenizer)
_encoding = tiktoken.get_encoding("cl100k_base")


def count_tokens(text: str) -> int:
    """Count tokens in a text string."""
    return len(_encoding.encode(text))


def chunk_text(text: str, filename: str, file_type: str, file_size: int) -> list[dict]:
    """
    Split text into chunks with metadata.
    Uses hierarchical separators for intelligent splitting.
    """
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=CHUNK_SIZE,
        chunk_overlap=CHUNK_OVERLAP,
        separators=[
            "\n\n\n",  # Major sections
            "\n\n",    # Paragraphs
            "\n",      # Lines
            ". ",      # Sentences
            "; ",      # Clauses
            ", ",      # Sub-clauses
            " ",       # Words
            "",        # Characters (last resort)
        ],
        length_function=len,
    )

    chunks = splitter.split_text(text)
    total = len(chunks)

    result = []
    for i, chunk_text_content in enumerate(chunks):
        result.append({
            "content": chunk_text_content,
            "metadata": {
                "filename": filename,
                "file_type": file_type,
                "file_size": file_size,
                "chunk_index": i,
                "total_chunks": total,
                "token_count": count_tokens(chunk_text_content),
            }
        })

    return result
