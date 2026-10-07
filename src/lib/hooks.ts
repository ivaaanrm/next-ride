import { useCallback, useEffect, useRef, useState } from "react";

import type { Page } from "../types";
import { isUnreachable } from "./api";

interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /**
   * El fallo ha sido de red (o el servidor no ha podido contestar), no de la
   * petición. Quien lo pinte debe usar `OfflineNotice` con su reintento y no un
   * `Banner` de error: son dos averías distintas y solo una se arregla sola.
   */
  offline: boolean;
}

/** Ejecuta `fetcher` al montar y cuando cambian las `deps`; expone `reload()`. */
export function useAsync<T>(
  fetcher: () => Promise<T>,
  deps: unknown[] = [],
): AsyncState<T> & { reload: () => void; setData: (value: T) => void } {
  const [state, setState] = useState<AsyncState<T>>({
    data: null,
    loading: true,
    error: null,
    offline: false,
  });
  const [nonce, setNonce] = useState(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    setState((prev) => ({ ...prev, loading: true, error: null, offline: false }));
    fetcher()
      .then((data) => {
        if (mounted.current) {
          setState({ data, loading: false, error: null, offline: false });
        }
      })
      .catch((error: unknown) => {
        if (!mounted.current) return;
        // `NetworkError` ya trae su mensaje en español; `ApiError`, el del
        // servidor, que también lo está. Nada de `String(error)`, que es por
        // donde se colaba «Load failed».
        const message = error instanceof Error ? error.message : "Error inesperado";
        setState({
          data: null,
          loading: false,
          error: message,
          offline: isUnreachable(error),
        });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  const setData = useCallback((value: T) => {
    setState({ data: value, loading: false, error: null, offline: false });
  }, []);

  return { ...state, reload, setData };
}

interface PagedState<T> {
  items: T[];
  total: number;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  offline: boolean;
}

/** El tope de `limit` en la API: `reload()` no pide más de una vez. */
const MAX_PAGE = 200;

/**
 * Un listado paginado (`{ items, total, limit, offset }`) que se va acumulando:
 * el primer tramo al montar y cuando cambian las `deps`, el siguiente con
 * `loadMore()`. Un tramo de un conjunto ya sustituido —cambió un filtro
 * mientras volaba— se descarta: no debe mezclarse con el nuevo.
 *
 * `reload()` vuelve a pedir de una vez lo que ya estaba cargado (hasta el tope
 * de la API), para que guardar una fila no devuelva la lista a la primera
 * página.
 */
export function usePaged<T>(
  fetchPage: (offset: number, limit: number) => Promise<Page<T>>,
  deps: unknown[] = [],
  pageSize = 50,
) {
  const [state, setState] = useState<PagedState<T>>({
    items: [],
    total: 0,
    loading: true,
    loadingMore: false,
    error: null,
    offline: false,
  });
  const epoch = useRef(0);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  const stateRef = useRef(state);
  stateRef.current = state;

  const run = useCallback(
    (mode: "reset" | "more" | "reload") => {
      const current = stateRef.current;
      if (mode === "more" && (current.loading || current.loadingMore || current.items.length >= current.total)) {
        return;
      }
      const mine = mode === "more" ? epoch.current : ++epoch.current;
      const offset = mode === "more" ? current.items.length : 0;
      const limit =
        mode === "reload" ? Math.min(Math.max(current.items.length, pageSize), MAX_PAGE) : pageSize;
      setState((prev) =>
        mode === "more"
          ? { ...prev, loadingMore: true }
          : { ...prev, loading: mode === "reset", error: null, offline: false },
      );
      fetchRef
        .current(offset, limit)
        .then((page) => {
          if (mine !== epoch.current) return;
          setState((prev) => ({
            items: mode === "more" ? [...prev.items, ...page.items] : page.items,
            total: page.total,
            loading: false,
            loadingMore: false,
            error: null,
            offline: false,
          }));
        })
        .catch((error: unknown) => {
          if (mine !== epoch.current) return;
          setState((prev) => ({
            ...prev,
            loading: false,
            loadingMore: false,
            error: error instanceof Error ? error.message : "Error inesperado",
            offline: isUnreachable(error),
          }));
        });
    },
    [pageSize],
  );

  useEffect(() => {
    run("reset");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  // Lo que llegue después de desmontar ya no es de nadie.
  useEffect(
    () => () => {
      epoch.current += 1;
    },
    [],
  );

  const loadMore = useCallback(() => run("more"), [run]);
  const reload = useCallback(() => run("reload"), [run]);
  return { ...state, hasMore: state.items.length < state.total, loadMore, reload };
}

/** Retrasa la propagación de un valor: evita una petición por tecla pulsada. */
export function useDebounced<T>(value: T, delayMs = 350): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
