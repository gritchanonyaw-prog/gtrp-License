import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { Pagination } from "../components/Pagination";
import { EmptyState, ErrorState, Loading } from "../components/States";
import { StatusBadge } from "../components/StatusBadge";
import { useAsync } from "../hooks/useAsync";
import { useQueryState } from "../hooks/useQueryState";
import { api } from "../services/api";
import { fmtDate } from "../services/format";

export function CustomersPage() {
  const { values, page, set } = useQueryState(["q", "status"] as const);
  const [q, setQ] = useState(values.q);
  const { data, error, loading, reload } = useAsync(() => api.customers({ q: values.q, status: values.status, page, page_size: 25 }), [values.q, values.status, page]);

  function search(e: FormEvent) {
    e.preventDefault();
    set({ q: q.trim() });
  }

  return (
    <section>
      <div className="page-head">
        <h1>Customers</h1>
      </div>
      <form className="filters" onSubmit={search} role="search">
        <label className="field inline">
          <span>Email or user ID</span>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="name@example.com" />
        </label>
        <label className="field inline">
          <span>Status</span>
          <select value={values.status} onChange={(e) => set({ status: e.target.value })}>
            <option value="">All</option>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
            <option value="deleted">Deleted</option>
          </select>
        </label>
        <button type="submit" className="btn">
          Search
        </button>
      </form>
      {loading && <Loading />}
      {error !== null && <ErrorState error={error} onRetry={reload} />}
      {data && !loading && (
        <>
          {data.data.length === 0 ? (
            <EmptyState>No customers match these filters.</EmptyState>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Status</th>
                    <th>Licenses</th>
                    <th>Joined</th>
                  </tr>
                </thead>
                <tbody>
                  {data.data.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <Link to={`/customers/${c.id}`}>{c.email}</Link>
                      </td>
                      <td>
                        <StatusBadge status={c.status} />
                      </td>
                      <td>
                        {c.active_license_count} active / {c.license_count}
                      </td>
                      <td>{fmtDate(c.created_at)}</td>
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
