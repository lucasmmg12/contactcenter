"""
Document Routes — Upload, List, Delete documents
"""
import os
import shutil
from fastapi import APIRouter, UploadFile, File, HTTPException, Query
from config import supabase, SUPPORTED_EXTENSIONS
from services.document_processor import extract_text
from services.chunker import chunk_text
from services.embeddings import store_chunks_with_embeddings

router = APIRouter()

UPLOAD_DIR = os.path.join(os.path.dirname(__file__), "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)


@router.post("/upload")
async def upload_document(file: UploadFile = File(...)):
    """
    Upload a document, extract text, chunk it, generate embeddings,
    and store in Supabase. If the document already exists, replace it.
    """
    filename = file.filename
    ext = os.path.splitext(filename)[1].lower()

    if ext not in SUPPORTED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Formato no soportado: {ext}. Formatos válidos: {', '.join(sorted(SUPPORTED_EXTENSIONS))}"
        )

    # Save file temporarily
    file_path = os.path.join(UPLOAD_DIR, filename)
    try:
        with open(file_path, "wb") as f:
            content = await file.read()
            f.write(content)

        file_size = os.path.getsize(file_path)

        # Check if document already exists → delete old version
        reindexed = False
        existing = supabase.table("rag_documents") \
            .select("id") \
            .eq("metadata->>filename", filename) \
            .execute()

        if existing.data:
            supabase.table("rag_documents") \
                .delete() \
                .eq("metadata->>filename", filename) \
                .execute()
            reindexed = True

        # Extract text
        raw_text = extract_text(file_path)
        if not raw_text.strip():
            raise HTTPException(
                status_code=400,
                detail=f"No se pudo extraer texto del archivo '{filename}'. Puede estar vacío o ser un PDF escaneado."
            )

        # Chunk text
        chunks = chunk_text(raw_text, filename, ext, file_size)

        # Generate embeddings and store
        store_chunks_with_embeddings(chunks)

        return {
            "message": f"Documento '{filename}' procesado exitosamente",
            "filename": filename,
            "file_type": ext,
            "total_chunks": len(chunks),
            "stored_chunks": len(chunks),
            "content_preview": raw_text[:300],
            "reindexed": reindexed,
        }

    except HTTPException:
        raise
    except Exception as e:
        print(f"Upload error: {e}")
        raise HTTPException(status_code=500, detail=f"Error al procesar '{filename}': {str(e)}")
    finally:
        # Clean up temp file
        if os.path.exists(file_path):
            os.remove(file_path)


@router.get("/documents")
async def list_documents():
    """List all unique documents (grouped by filename)."""
    try:
        result = supabase.table("rag_documents") \
            .select("metadata, created_at") \
            .execute()

        # Group by filename
        doc_map = {}
        for row in (result.data or []):
            metadata = row.get("metadata", {})
            filename = metadata.get("filename", "desconocido")
            if filename not in doc_map:
                doc_map[filename] = {
                    "filename": filename,
                    "file_type": metadata.get("file_type", ""),
                    "file_size": metadata.get("file_size", 0),
                    "total_chunks": metadata.get("total_chunks", 0),
                    "created_at": row.get("created_at", ""),
                }

        documents = sorted(doc_map.values(), key=lambda x: x.get("created_at", ""), reverse=True)

        return {
            "documents": documents,
            "total_documents": len(documents),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/documents")
async def delete_document(filename: str = Query(...)):
    """Delete a document and all its chunks by filename."""
    try:
        result = supabase.table("rag_documents") \
            .delete() \
            .eq("metadata->>filename", filename) \
            .execute()

        deleted_count = len(result.data) if result.data else 0

        if deleted_count == 0:
            raise HTTPException(status_code=404, detail=f"Documento '{filename}' no encontrado")

        return {
            "message": f"Documento '{filename}' eliminado ({deleted_count} chunks)",
            "deleted_chunks": deleted_count,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
