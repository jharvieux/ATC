"use client";

import React, { useCallback, useRef, useState } from "react";

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

type DropState = "idle" | "dragging" | "selected" | "uploading" | "error";

export interface FileDropZoneProps {
  /** Native <input accept=""> value, e.g. "application/pdf,.pdf" */
  accept: string;
  /** Human-readable file type hint shown below the icon */
  acceptLabel: string;
  maxBytes: number;
  /** POST endpoint that accepts multipart/form-data */
  endpoint: string;
  /** Form field name for the file; defaults to "file" */
  fieldName?: string;
  /** Additional form fields appended to every upload */
  extraFields?: Record<string, string>;
  /** Called with the parsed response body on success */
  onSuccess: (data: unknown) => void;
  disabled?: boolean;
  className?: string;
}

export function FileDropZone({
  accept,
  acceptLabel,
  maxBytes,
  endpoint,
  fieldName = "file",
  extraFields,
  onSuccess,
  disabled = false,
  className = "",
}: FileDropZoneProps) {
  const [state, setState] = useState<DropState>("idle");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragCounter = useRef(0);

  const selectFile = useCallback(
    (f: File) => {
      if (f.size > maxBytes) {
        setError(`File is too large — maximum is ${formatBytes(maxBytes)}.`);
        setState("error");
        return;
      }
      setFile(f);
      setError(null);
      setState("selected");
    },
    [maxBytes],
  );

  const reset = useCallback(() => {
    setFile(null);
    setError(null);
    setState("idle");
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  const upload = useCallback(async () => {
    if (!file) return;
    setState("uploading");
    setError(null);
    const form = new FormData();
    form.append(fieldName, file);
    if (extraFields) {
      for (const [k, v] of Object.entries(extraFields)) form.append(k, v);
    }
    try {
      const res = await fetch(endpoint, { method: "POST", body: form });
      const data: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = (data as { error?: string }).error ?? `Upload failed (${res.status})`;
        setError(msg);
        setState("error");
        return;
      }
      reset();
      onSuccess(data);
    } catch {
      setError("Network error — check your connection and try again.");
      setState("error");
    }
  }, [file, endpoint, fieldName, extraFields, onSuccess, reset]);

  const onDragEnter = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (disabled || state === "uploading") return;
      dragCounter.current += 1;
      setState("dragging");
    },
    [disabled, state],
  );

  const onDragLeave = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      dragCounter.current -= 1;
      if (dragCounter.current === 0) setState((s) => (s === "dragging" ? "idle" : s));
    },
    [],
  );

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      dragCounter.current = 0;
      if (disabled || state === "uploading") return;
      const f = e.dataTransfer.files[0];
      if (f) selectFile(f);
    },
    [disabled, state, selectFile],
  );

  const onInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      if (f) selectFile(f);
    },
    [selectFile],
  );

  const isUploading = state === "uploading";
  const isDragging = state === "dragging";
  const isInteractive = !disabled && !isUploading;

  return (
    <div className={className}>
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-label="Drop a file here or click to browse"
        aria-disabled={disabled}
        onClick={() => {
          if (isInteractive && state !== "selected") inputRef.current?.click();
        }}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && isInteractive && state !== "selected") {
            inputRef.current?.click();
          }
        }}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        onDrop={onDrop}
        className={[
          "border-2 border-dashed rounded-lg px-6 py-8 text-center transition-colors",
          isDragging ? "border-indigo-400 bg-indigo-50" : "",
          disabled
            ? "border-gray-200 bg-gray-50 cursor-not-allowed opacity-50"
            : isUploading
              ? "border-gray-300 bg-gray-50 cursor-not-allowed"
              : state === "selected"
                ? "border-indigo-300 bg-indigo-50/30 cursor-default"
                : "border-gray-300 bg-gray-50 hover:border-gray-400 hover:bg-gray-100 cursor-pointer",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          className="sr-only"
          onChange={onInputChange}
          disabled={!isInteractive}
        />

        {isUploading ? (
          <div className="flex flex-col items-center gap-2">
            <div className="w-5 h-5 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin" />
            <p className="text-sm text-gray-600">Uploading {file?.name}…</p>
          </div>
        ) : state === "selected" && file ? (
          <div className="flex flex-col items-center gap-2" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm font-medium text-gray-800 truncate max-w-xs">{file.name}</p>
            <p className="text-xs text-gray-500">{formatBytes(file.size)}</p>
            <div className="flex gap-2 mt-1">
              <button
                onClick={upload}
                className="px-4 py-1.5 bg-indigo-600 text-white text-sm font-medium rounded hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                Upload
              </button>
              <button
                onClick={reset}
                className="px-4 py-1.5 bg-white border border-gray-300 text-sm text-gray-600 rounded hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-gray-300"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-1 pointer-events-none select-none">
            <svg
              className={`w-8 h-8 mb-1 ${isDragging ? "text-indigo-500" : "text-gray-400"}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5"
              />
            </svg>
            <p className="text-sm font-medium text-gray-700">
              {isDragging ? "Drop to upload" : "Drop a file here, or click to browse"}
            </p>
            <p className="text-xs text-gray-400">
              {acceptLabel} — up to {formatBytes(maxBytes)}
            </p>
          </div>
        )}
      </div>

      {state === "error" && error && (
        <div className="mt-2 flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2">
          <span className="flex-1">{error}</span>
          <button onClick={reset} className="shrink-0 text-red-500 hover:text-red-700 font-medium">
            Try again
          </button>
        </div>
      )}
    </div>
  );
}
