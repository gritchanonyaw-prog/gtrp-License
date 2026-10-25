import type { PaginationMeta } from "../types";

export function Pagination({ meta, onPage }: { meta: PaginationMeta; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(meta.total / meta.page_size));
  if (meta.total === 0) return null;
  return (
    <nav className="pagination" aria-label="Pagination">
      <button type="button" className="btn" disabled={meta.page <= 1} onClick={() => onPage(meta.page - 1)}>
        Previous
      </button>
      <span>
        Page {meta.page} of {pages} · {meta.total} total
      </span>
      <button type="button" className="btn" disabled={meta.page >= pages} onClick={() => onPage(meta.page + 1)}>
        Next
      </button>
    </nav>
  );
}
