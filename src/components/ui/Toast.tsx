import { create } from "zustand";
import { useEffect } from "react";

type ToastKind = "info" | "error";

interface ToastEntry {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastState {
  items: ToastEntry[];
  push: (kind: ToastKind, message: string) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;

const useToastStore = create<ToastState>((set) => ({
  items: [],
  push: (kind, message) =>
    set((state) => ({
      items: [...state.items, { id: nextId++, kind, message }],
    })),
  dismiss: (id) =>
    set((state) => ({ items: state.items.filter((t) => t.id !== id) })),
}));

export function toastInfo(message: string) {
  useToastStore.getState().push("info", message);
}

export function toastError(message: string) {
  useToastStore.getState().push("error", message);
}

export function ToastViewport() {
  const items = useToastStore((s) => s.items);
  const dismiss = useToastStore((s) => s.dismiss);

  return (
    <div className="pointer-events-none fixed bottom-6 right-6 z-50 flex flex-col gap-2">
      {items.map((t) => (
        <ToastItem key={t.id} entry={t} onDismiss={() => dismiss(t.id)} />
      ))}
    </div>
  );
}

function ToastItem({
  entry,
  onDismiss,
}: {
  entry: ToastEntry;
  onDismiss: () => void;
}) {
  useEffect(() => {
    const handle = setTimeout(onDismiss, 4000);
    return () => clearTimeout(handle);
  }, [onDismiss]);

  const colorClass =
    entry.kind === "error"
      ? "bg-red-600 text-white"
      : "bg-zinc-800 text-white dark:bg-zinc-200 dark:text-zinc-900";

  return (
    <div
      className={`pointer-events-auto rounded-md px-4 py-2 text-sm shadow-lg ${colorClass}`}
      onClick={onDismiss}
      role="status"
    >
      {entry.message}
    </div>
  );
}
