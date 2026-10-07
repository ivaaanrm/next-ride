import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * La última red bajo el árbol de React.
 *
 * En una pestaña de navegador un error de render es molesto: la pantalla se
 * queda en blanco y se recarga. Instalada en la pantalla de inicio no hay barra
 * de direcciones, ni botón de recarga, ni botón de atrás — y «Recargar la app»
 * de la pantalla «Más» no sirve de nada, porque vive dentro del árbol que acaba
 * de morir. Sin esto, un solo error de render deja la app sin salida hasta
 * desinstalarla.
 *
 * Es deliberadamente tonta: no usa hooks, ni contexto, ni el router, ni ningún
 * componente de la app. Solo las clases de la hoja de estilos, que sigue
 * cargada. Lo que falle aquí no tiene dónde caerse.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // No hay servicio de errores al que mandarlo: la consola es lo que hay, y
    // sirve cuando alguien conecta el teléfono al inspector de Safari.
    console.error("Error de render sin capturar:", error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;

    return (
      <div className="auth-shell">
        <div className="auth-card">
          <h1>Algo se ha roto</h1>
          <p className="sub">
            La aplicación ha encontrado un error del que no sabe volver. Recargar suele
            bastar; la sesión no se pierde.
          </p>
          <button
            className="btn btn-primary btn-lg"
            type="button"
            onClick={() => window.location.reload()}
          >
            Recargar la app
          </button>
        </div>
      </div>
    );
  }
}
