"""Quick test for all RAG endpoints"""
import sys
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

import requests
import json

BASE = "http://localhost:8000/api"

def test(name, fn):
    try:
        result = fn()
        print(f"[OK] {name}")
        return result
    except Exception as e:
        print(f"[FAIL] {name}: {e}")
        return None

# 1. Health
test("Health Check", lambda: requests.get(f"{BASE}/health").json())

# 2. List docs
r = test("List Documents", lambda: requests.get(f"{BASE}/documents").json())
if r:
    print(f"   -> {r['total_documents']} documentos")

# 3. Upload test file
def upload():
    with open("test_doc.txt", "rb") as f:
        resp = requests.post(f"{BASE}/upload", files={"file": ("test_doc.txt", f)})
        resp.raise_for_status()
        return resp.json()

r = test("Upload Document", upload)
if r:
    print(f"   -> {r['total_chunks']} chunks, reindexed={r['reindexed']}")

# 4. List docs (should have 1)
r = test("List Documents (post-upload)", lambda: requests.get(f"{BASE}/documents").json())
if r:
    print(f"   -> {r['total_documents']} documento(s)")

# 5. Chat
def ask():
    resp = requests.post(f"{BASE}/chat", json={
        "question": "Cuantos dias de licencia por adopcion corresponden?",
        "conversation_id": None
    }, timeout=180)
    resp.raise_for_status()
    return resp.json()

print("\nEnviando pregunta al RAG pipeline (15-30 seg)...")
r = test("RAG Chat", ask)
if r:
    print(f"   -> Respuesta: {r['answer'][:300]}...")
    print(f"   -> Sources: {json.dumps(r.get('sources', []))}")
    print(f"   -> Pipeline: {json.dumps(r.get('pipeline', {}))}")
    conv_id = r['conversation_id']

    # 6. List conversations
    r2 = test("List Conversations", lambda: requests.get(f"{BASE}/conversations").json())
    if r2:
        print(f"   -> {len(r2['conversations'])} conversacion(es)")

    # 7. Get messages
    r3 = test("Get Messages", lambda: requests.get(f"{BASE}/conversations/{conv_id}/messages").json())
    if r3:
        print(f"   -> {len(r3['messages'])} mensaje(s)")

    # 8. Follow-up
    def ask_followup():
        resp = requests.post(f"{BASE}/chat", json={
            "question": "Y por maternidad?",
            "conversation_id": conv_id
        }, timeout=180)
        resp.raise_for_status()
        return resp.json()

    print("\nPregunta de seguimiento...")
    r4 = test("Follow-up Chat", ask_followup)
    if r4:
        print(f"   -> Respuesta: {r4['answer'][:300]}...")

    # 9. Delete conversation
    r5 = test("Delete Conversation", lambda: requests.delete(f"{BASE}/conversations/{conv_id}").json())

# 10. Delete document
r6 = test("Delete Document", lambda: requests.delete(f"{BASE}/documents?filename=test_doc.txt").json())

print("\nTest completado")
