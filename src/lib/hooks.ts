import { useCallback, useEffect, useRef, useState } from "react";

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

/** Retrasa la propagación de un valor: evita una petición por tecla pulsada. */
export function useDebounced<T>(value: T, delayMs = 350): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
