import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import type { User } from "../types";
import { api, isUnreachable, setUnauthorizedHandler, tokens } from "./api";

interface AuthContextValue {
  user: User | null;
  /** El arranque todavía está decidiendo si hay sesión. */
  loading: boolean;
  /**
   * Hay tokens guardados y el servidor no ha contestado, así que no se sabe si
   * la sesión vale. No es lo mismo que no tener sesión, y no se pinta igual.
   */
  offline: boolean;
  /** Un reintento de `retry()` está en vuelo. */
  retrying: boolean;
  /**
   * Había una sesión y el servidor la ha rechazado. Sirve para que el login se
   * presente como lo que es —el final normal de unos días sin abrir la app— y
   * no como una avería.
   */
  sessionEnded: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, fullName?: string) => Promise<void>;
  logout: () => void;
  /** Vuelve a intentar restaurar la sesión. Es el botón «Reintentar». */
  retry: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [sessionEnded, setSessionEnded] = useState(false);

  const logout = useCallback(() => {
    tokens.clear();
    // La posición de scroll de cada lista se guarda con la consulta de filtros
    // dentro de la clave. El valor son números y no dice nada de nadie, pero la
    // clave enseña por qué estaba filtrando quien acaba de salir.
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith("nr.offers.")) sessionStorage.removeItem(key);
    }
    setUser(null);
    setOffline(false);
    // Salir por voluntad propia no es que caduque nada.
    setSessionEnded(false);
  }, []);

  // Si el refresh se rechaza en cualquier petición, se cierra la sesión. Los
  // tokens ya los ha borrado `request`; aquí solo se apaga la pantalla.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null);
      setOffline(false);
      setSessionEnded(true);
    });
  }, []);

  /**
   * Restaurar la sesión guardada.
   *
   * Los tres finales son distintos y antes solo había uno. Sin tokens: al
   * login, que en un arranque en frío es normal —la app instalada tiene su
   * propio almacén y WebKit lo desaloja a los siete días sin visitas—. Con
   * tokens y un rechazo del servidor: fuera los tokens y al login. Con tokens y
   * sin respuesta: **los tokens se quedan** y se enseña «Sin conexión», porque
   * un fallo de transporte no dice nada sobre si la sesión sigue siendo válida.
   */
  const restore = useCallback(async () => {
    if (!tokens.access() && !tokens.refresh()) {
      setUser(null);
      setOffline(false);
      return;
    }
    try {
      setUser(await api.get<User>("/auth/me"));
      setOffline(false);
      setSessionEnded(false);
    } catch (error) {
      if (isUnreachable(error)) {
        setOffline(true);
        return;
      }
      // 401 o 403: el servidor ha mirado la credencial y la ha rechazado.
      // `request` ya ha vaciado el almacén en el 401; se repite aquí para que
      // el estado no dependa de por dónde haya salido el error.
      tokens.clear();
      setUser(null);
      setOffline(false);
      setSessionEnded(true);
    }
  }, []);

  useEffect(() => {
    restore().finally(() => setLoading(false));
  }, [restore]);

  const retry = useCallback(() => {
    setRetrying(true);
    restore().finally(() => setRetrying(false));
  }, [restore]);

  /* Una app instalada pasa la mayor parte de su vida suspendida. Se vuelve a ella
     en el metro, en otra wifi, con la red ya de vuelta, y sin esto se queda en la
     tarjeta de «Sin conexión» hasta que alguien pulsa Reintentar. Se reintenta
     solo cuando hay algo que arreglar: si no está `offline`, no se toca nada. */
  useEffect(() => {
    if (!offline) return;
    const again = () => {
      if (document.visibilityState === "visible") retry();
    };
    window.addEventListener("online", again);
    document.addEventListener("visibilitychange", again);
    return () => {
      window.removeEventListener("online", again);
      document.removeEventListener("visibilitychange", again);
    };
  }, [offline, retry]);

  const login = useCallback(async (email: string, password: string) => {
    const pair = await api.login(email, password);
    tokens.save(pair);
    setUser(await api.get<User>("/auth/me"));
    setOffline(false);
    setSessionEnded(false);
  }, []);

  const register = useCallback(
    async (email: string, password: string, fullName?: string) => {
      await api.register(email, password, fullName);
      const pair = await api.login(email, password);
      tokens.save(pair);
      setUser(await api.get<User>("/auth/me"));
      setOffline(false);
      setSessionEnded(false);
    },
    [],
  );

  const value = useMemo(
    () => ({
      user,
      loading,
      offline,
      retrying,
      sessionEnded,
      login,
      register,
      logout,
      retry,
    }),
    [user, loading, offline, retrying, sessionEnded, login, register, logout, retry],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth debe usarse dentro de <AuthProvider>");
  return context;
}
