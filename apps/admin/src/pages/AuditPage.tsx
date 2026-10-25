import { AUDIT_EVENT_TYPES } from "@gtrp/shared";
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { Pagination } from "../components/Pagination";
import { EmptyState, ErrorState, Loading } from "../components/States";
import { useAsync } from "../hooks/useAsync";
import { useQueryState } from "../hooks/useQueryState";
import { api } from "../services/api";
import { fmtDate, localInputToIso, shortId } from "../services/format";
import { t } from "../i18n";

const KEYS = ["from", "to", "actor_user_id", "target_user_id", "license_id", "event_type"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Audit log. Event details are redacted server-side; secrets are never stored in events. */
export function AuditPage() {
  const { values, page, set } = useQueryState(KEYS);
  const [draft, setDraft] = useState(values);
  const { data, error, loading, reload } = useAsync(() => api.events({ ...values, page, page_size: 50 }), [...KEYS.map((k) => values[k]), page]);

  function apply(e: FormEvent) {
    e.preventDefault();
    const clean: Record<string, string> = {};
    for (const k of KEYS) {
      const v = draft[k].trim();
      if (!v) clean[k] = "";
      else if (k === "from" || k === "to") clean[k] = v.endsWith("Z") ? v : localInputToIso(v);
      else clean[k] = v;
    }
    set(clean);
  }

  const idError = (["actor_user_id", "target_user_id", "license_id"] as const).find((k) => draft[k] && !UUID.test(draft[k].trim()));

  return (
    <section>
      <div className="page-head">
        <h1>{t("Audit log")}</h1>
      </div>
      <form className="filters" onSubmit={apply}>
        <label className="field inline">
          <span>{t("From")}</span>
          <input type="datetime-local" value={draft.from.replace(/:\d{2}\.\d{3}Z$|Z$/, "")} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
        </label>
        <label className="field inline">
          <span>{t("To")}</span>
          <input type="datetime-local" value={draft.to.replace(/:\d{2}\.\d{3}Z$|Z$/, "")} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
        </label>
        <label className="field inline">
          <span>{t("Event type")}</span>
          <select value={draft.event_type} onChange={(e) => setDraft({ ...draft, event_type: e.target.value })}>
            <option value="">{t("All")}</option>
            {AUDIT_EVENT_TYPES.map((ev) => (
              <option key={ev} value={ev}>
                {ev}
              </option>
            ))}
          </select>
        </label>
        <label className="field inline">
          <span>{t("Administrator ID")}</span>
          <input value={draft.actor_user_id} onChange={(e) => setDraft({ ...draft, actor_user_id: e.target.value })} />
        </label>
        <label className="field inline">
          <span>{t("Customer ID")}</span>
          <input value={draft.target_user_id} onChange={(e) => setDraft({ ...draft, target_user_id: e.target.value })} />
        </label>
        <label className="field inline">
          <span>{t("License ID")}</span>
          <input value={draft.license_id} onChange={(e) => setDraft({ ...draft, license_id: e.target.value })} />
        </label>
        <button type="submit" className="btn" disabled={!!idError}>
          {t("Apply filters")}
        </button>
        {idError && <small className="error-text">{t("IDs must be full UUIDs.")}</small>}
      </form>
      {loading && <Loading />}
      {error !== null && <ErrorState error={error} onRetry={reload} />}
      {data && !loading && (
        <>
          {data.data.length === 0 ? (
            <EmptyState>{t("No events match these filters.")}</EmptyState>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t("Time")}</th>
                    <th>{t("Event")}</th>
                    <th>{t("By")}</th>
                    <th>{t("Customer")}</th>
                    <th>{t("License")}</th>
                    <th>{t("Details")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.data.map((e) => (
                    <tr key={e.id}>
                      <td>{fmtDate(e.created_at)}</td>
                      <td>
                        <code>{e.event_type}</code>
                      </td>
                      <td>{e.actor_email ?? e.actor_type}</td>
                      <td>{e.target_user_id ? <Link to={`/customers/${e.target_user_id}`}>{e.target_email ?? shortId(e.target_user_id)}</Link> : "—"}</td>
                      <td>{e.license_id ? <Link to={`/licenses/${e.license_id}`}>{shortId(e.license_id)}</Link> : "—"}</td>
                      <td>
                        <details>
                          <summary>{t("View")}</summary>
                          <pre className="details-json">{JSON.stringify(e.details, null, 2)}</pre>
                        </details>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pagination meta={data.pagination} onPage={(p) => set({ page: String(p) })} />
        </>
      )}
    </section>
  );
}
