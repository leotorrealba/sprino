import { useCallback, useEffect, useRef, useState } from 'react';
import type { Attachment } from '@sprino/protocol-types';

interface AttachmentsProps {
  token: string;
  taskId: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function uuidv7(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const ms = BigInt(Date.now());
  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n) & 0xffn);
  bytes[5] = Number(ms & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function Attachments({ token, taskId }: AttachmentsProps) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/tasks/${taskId}/attachments`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`list failed: ${r.status}`);
      const j = (await r.json()) as { attachments: Attachment[] };
      setAttachments(j.attachments);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [taskId, token]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleUpload = async (file: File) => {
    setUploading(true);
    setUploadError(null);
    try {
      const authHeader = { authorization: `Bearer ${token}` };
      const createRes = await fetch('/api/attachments', {
        method: 'POST',
        headers: { ...authHeader, 'content-type': 'application/json' },
        body: JSON.stringify({
          operation_id: uuidv7(),
          task_id: taskId,
          filename: file.name,
          content_type: file.type || 'application/octet-stream',
          size_bytes: file.size,
        }),
      });
      if (!createRes.ok) {
        throw new Error(`create_upload failed: ${createRes.status} ${await createRes.text()}`);
      }
      const { attachment, upload_url } = (await createRes.json()) as {
        attachment: Attachment;
        upload_url: string;
      };

      // upload_url is relative (/api/...) for LocalStorageBackend; absolute for S3.
      // Include auth header only for same-origin requests.
      const putHeaders: Record<string, string> = {
        'content-type': file.type || 'application/octet-stream',
      };
      if (upload_url.startsWith('/')) Object.assign(putHeaders, authHeader);

      const putRes = await fetch(upload_url, {
        method: 'PUT',
        headers: putHeaders,
        body: file,
      });
      if (!putRes.ok) {
        throw new Error(`upload failed: ${putRes.status} ${await putRes.text()}`);
      }

      const finalizeRes = await fetch(`/api/attachments/${attachment.id}/finalize`, {
        method: 'POST',
        headers: { ...authHeader, 'content-type': 'application/json' },
        body: JSON.stringify({
          operation_id: uuidv7(),
          attachment_id: attachment.id,
        }),
      });
      if (!finalizeRes.ok) {
        throw new Error(`finalize failed: ${finalizeRes.status} ${await finalizeRes.text()}`);
      }

      await load();
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleDownload = async (attachment: Attachment) => {
    if (!attachment.url) return;
    try {
      // Only send auth header for same-origin URLs; presigned S3 URLs must not
      // receive the Bearer token (conflicting auth triggers CORS/preflight errors).
      const headers: Record<string, string> = attachment.url.startsWith('/')
        ? { authorization: `Bearer ${token}` }
        : {};
      const r = await fetch(attachment.url, { headers });
      if (!r.ok) throw new Error(`download failed: ${r.status}`);
      const blob = await r.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = attachment.filename;
      a.click();
      // Defer revocation so the browser has a tick to start consuming the URL.
      queueMicrotask(() => URL.revokeObjectURL(objectUrl));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="mt-3 border-t border-slate-100 pt-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Attachments
        </h3>
        <div>
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleUpload(file);
            }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="rounded px-2 py-1 text-[11px] font-medium text-slate-600 ring-1 ring-inset ring-slate-200 hover:bg-slate-50 disabled:opacity-40"
          >
            {uploading ? 'uploading…' : '+ attach'}
          </button>
        </div>
      </div>

      {uploadError && (
        <div className="mb-2 rounded border border-rose-200 bg-rose-50 px-2 py-1 text-xs text-rose-800">
          {uploadError}
        </div>
      )}

      {error && (
        <div className="mb-2 rounded border border-rose-200 bg-rose-50 px-2 py-1 text-xs text-rose-800">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-xs text-slate-400">loading…</p>
      ) : attachments.length === 0 ? (
        <p className="text-xs text-slate-400">no attachments</p>
      ) : (
        <ul className="space-y-1">
          {attachments.map((a) => (
            <li
              key={a.id}
              className="flex items-center gap-2 rounded border border-slate-100 bg-slate-50 px-2 py-1.5"
            >
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-slate-700">
                {a.filename}
              </span>
              <span className="shrink-0 text-[10px] text-slate-400">
                {formatBytes(a.size_bytes)}
              </span>
              {a.url && (
                <button
                  onClick={() => void handleDownload(a)}
                  className="shrink-0 text-[11px] font-medium text-blue-600 hover:underline"
                >
                  download
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
