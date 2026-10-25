import { useCallback } from "react";
import { useSearchParams } from "react-router";

/** Keeps filters and page number in the URL so views can be bookmarked and shared. */
export function useQueryState<K extends string>(keys: readonly K[]) {
  const [params, setParams] = useSearchParams();
  const values = Object.fromEntries(keys.map((k) => [k, params.get(k) ?? ""])) as Record<K, string>;
  const page = Number(params.get("page") ?? "1") || 1;
  const set = useCallback(
    (patch: Partial<Record<K | "page", string>>) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v) next.set(k, v as string);
            else next.delete(k);
          }
          if (!("page" in patch)) next.delete("page");
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );
  return { values, page, set };
}
