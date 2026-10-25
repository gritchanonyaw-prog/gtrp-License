import type { PaginationMeta } from "../types";
import { t } from "../i18n";

export function Pagination({ meta, onPage }: { meta: PaginationMeta; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(meta.total / meta.page_size));
  if (meta.total === 0) return null;
  return (
    <nav className="pagination" aria-label={t("Pagination")}>
      <button type="button" className="btn" disabled={meta.page <= 1} onClick={() => onPage(meta.page - 1)}>
        {t("Previous")}
      </button>
      <span>
        {t("Page {page} of {pages} · {total} total", { page: meta.page, pages, total: meta.total })}
      </span>
      <button type="button" className="btn" disabled={meta.page >= pages} onClick={() => onPage(meta.page + 1)}>
        {t("Next")}
      </button>
    </nav>
  );
}
