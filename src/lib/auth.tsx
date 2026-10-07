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
import { api, isUnreachable, setUnauthorizedHandler } from "./api";

/**
 * Marca de «aquí había una sesión». La cookie es HttpOnly y el script no la ve,
 * así que sin esta marca un 401 al arrancar no distinguiría entre «nunca has
 * entrado en este dispositivo» y «tu sesión ha caducado». Solo decide el texto
 * de la pantalla de entrada: si WebKit la desaloja, lo peor es un mensaje menos.
 */
const SIGNED_IN_HINT = "nr.signed_in";
const hint = {
  get: () => {
    try {
      return localStorage.getItem(SIGNED_IN_HINT) === "1";
    } catch {
      return false;
    }
  },
  set: (on: boolean) => {
    try {
      if (on) localStorage.setItem(SIGNED_IN_HINT, "1");
      else localStorage.removeItem(SIGNED_IN_HINT);
    } catch {
      /* Safari privado: sin marca, el login sale con el texto genérico. */
    }
  },
};

/** El cliente de Better Auth se descarga solo cuando se usa. */
const loadAuthClient = () => import("./auth-client");

interface AuthContextValue {
  user: User | null;
  /** El arranque todavía está decidiendo si hay sesión. */
  loading: boolean;
  /**
   * El servidor no ha contestado al restaurar, así que no se sabe si la sesión
   * vale. No es lo mismo que no tener sesión, y no se pinta igual.
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

  const clearLocalSession = useCallback(() => {
    hint.set(false);
    // La posición de scroll de cada lista se guarda con la consulta de filtros
    // dentro de la clave. El valor son números y no dice nada de nadie, pero la
    // clave enseña por qué estaba filtrando quien acaba de salir.
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith("nr.offers.")) sessionStorage.removeItem(key);
    }
  }, []);

  const logout = useCallback(() => {
    clearLocalSession();
    setUser(null);
    setOffline(false);
    // Salir por voluntad propia no es que caduque nada.
    setSessionEnded(false);
    // La cookie la borra el servidor. Si no hay red, la sesión sigue viva en el
    // servidor hasta que caduque, pero en este dispositivo ya no se usa.
    void loadAuthClient()
      .then(({ authClient }) => authClient.signOut())
      .catch(() => {});
  }, [clearLocalSession]);

  // Si el servidor rechaza la sesión en cualquier petición, se vuelve al login.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      clearLocalSession();
      setUser(null);
      setOffline(false);
      setSessionEnded(true);
    });
  }, [clearLocalSession]);

  /**
   * Restaurar la sesión.
   *
   * Siempre se pregunta: la cookie no se ve desde el script, así que no hay
   * forma de saber sin red si la hay. Tres finales. El servidor contesta con el
   * usuario: dentro. Contesta 401: al login, y si este dispositivo tenía una
   * sesión, se dice que ha caducado. No contesta: «Sin conexión», porque un
   * fallo de transporte no dice nada de si la sesión vale, y sin red tampoco
   * se podría entrar.
   */
  const restore = useCallback(async () => {
    try {
      setUser(await api.probe<User>("/auth/me"));
      hint.set(true);
      setOffline(false);
      setSessionEnded(false);
    } catch (error) {
      if (isUnreachable(error)) {
        setOffline(true);
        return;
      }
      const hadSession = hint.get();
      clearLocalSession();
      setUser(null);
      setOffline(false);
      setSessionEnded(hadSession);
    }
  }, [clearLocalSession]);

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

  const enter = useCallback(async () => {
    setUser(await api.get<User>("/auth/me"));
    hint.set(true);
    setOffline(false);
    setSessionEnded(false);
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      const { authClient, unwrap } = await loadAuthClient();
      await unwrap(authClient.signIn.email({ email, password, rememberMe: true }));
      await enter();
    },
    [enter],
  );

  const register = useCallback(
    async (email: string, password: string, fullName?: string) => {
      const { authClient, unwrap } = await loadAuthClient();
      // Con `autoSignIn` el alta ya deja la sesión abierta.
      await unwrap(authClient.signUp.email({ email, password, name: fullName ?? "" }));
      await enter();
    },
    [enter],
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
